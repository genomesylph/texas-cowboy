# main.py — ESP32 MicroPython dealer via MQTT
# เพิ่มเก็บ "6 เกมล่าสุด" ต่อ bet code แล้ว publish แบบ retained ที่ cowboy/stats/mini6

import network, time, ujson as json, uasyncio as asyncio, ubinascii, urandom
from umqtt.simple import MQTTClient
import ssl

# ====== CONFIG ======
WIFI_SSID   = "Buta The Cat_2.4G"
WIFI_PASS   = "56098148"

MQTT_HOST   = "test.mosquitto.org"
MQTT_PORT   = 8883
MQTT_USER   = ""
MQTT_PASSW  = ""

TOPIC_STATE    = b"cowboy/state"
TOPIC_REVEAL   = b"cowboy/reveal"
TOPIC_BETS     = b"cowboy/bets/#"

TOPIC_WINNERS  = b"cowboy/stats/winners"   # web -> esp32
TOPIC_STREAKS  = b"cowboy/stats/streaks"   # esp32 -> web (retained)
TOPIC_HISTORY  = b"cowboy/stats/history"   # esp32 -> web (retained; 10 จุดบน)
TOPIC_MINI6    = b"cowboy/stats/mini6"     # esp32 -> web (retained; 6 เกมล่าสุด/ต่อ code)

# durations
T_BETTING = 3 #15
T_FLIP    = 4
T_RESULT  = 10 #6

# ====== Globals ======
client = None
phase = "BETTING"
countdown = 0
round_id = 0
bets = []

# ต้องมี 3 outcome หลักด้วย
BET_CODES = [
    'LEFT_WIN','RIGHT_WIN','TIE',
    'ANY_HOLE_SUITED_OR_CONN','ANY_HOLE_PAIR','ANY_HOLE_AA',
    'WIN_HIGH_OR_PAIR','WIN_TWO_PAIR','WIN_TRIPS_STRAIGHT_FLUSH',
    'WIN_FULL_HOUSE','ANY_FOUR_OR_SF_OR_ROYAL'
]

# streaks
STREAKS_FILE = "streaks.json"
STREAKS = {k: 0 for k in BET_CODES}

# history 10 จุดบน
HISTORY_FILE = "history.json"
HISTORY_MAX = 10
HISTORY = []
LAST_HISTORY_ROUND = -1

# mini 6 เกมล่าสุดต่อ bet code (true=ออก/เขียว, false=ไม่ออก/แดง) — ต้อง persist
MINI6_FILE = "mini6.json"
MINI6 = {k: [] for k in BET_CODES}  # เก็บเฉพาะ 6 ตัวล่าสุดเสมอ

# ====== WiFi ======
def wifi_connect():
    sta = network.WLAN(network.STA_IF)
    if not sta.active():
        sta.active(True)
    if not sta.isconnected():
        print("WiFi connecting...")
        sta.connect(WIFI_SSID, WIFI_PASS)
        for _ in range(60):
            if sta.isconnected():
                break
            time.sleep(0.5); print(".", end="")
    print("\nWiFi:", sta.ifconfig())

# ====== Deal ======
def make_deck():
    ranks = b"23456789TJQKA"
    suits = [b"s", b"h", b"d", b"c"]
    deck = []
    for s in suits:
        for r in ranks:
            deck.append(bytes([r]) + s)
    n = len(deck)
    for i in range(n-1, 0, -1):
        j = urandom.getrandbits(16) % (i+1)
        deck[i], deck[j] = deck[j], deck[i]
    return deck

def deal_pack():
    d = make_deck()
    L = [d.pop().decode(), d.pop().decode()]
    R = [d.pop().decode(), d.pop().decode()]
    board = [d.pop().decode(), d.pop().decode(), d.pop().decode(), d.pop().decode(), d.pop().decode()]
    return {"L": L, "R": R, "board": board}

# ====== Persist helpers ======
def load_json(path, default):
    try:
        with open(path, "r") as f:
            return json.loads(f.read())
    except:
        return default

def save_json(path, obj):
    try:
        with open(path, "w") as f:
            f.write(json.dumps(obj))
    except:
        pass

def load_streaks():
    s = load_json(STREAKS_FILE, {})
    out = {k: 0 for k in BET_CODES}
    if isinstance(s, dict):
        for k in BET_CODES:
            v = s.get(k, 0)
            out[k] = int(v) if isinstance(v, int) else 0
    return out

def save_streaks():
    save_json(STREAKS_FILE, STREAKS)

def load_history():
    H = load_json(HISTORY_FILE, [])
    return H[-HISTORY_MAX:] if isinstance(H, list) else []

def save_history():
    save_json(HISTORY_FILE, HISTORY[-HISTORY_MAX:])

def load_mini6():
    m = load_json(MINI6_FILE, {})
    out = {k: [] for k in BET_CODES}
    if isinstance(m, dict):
        for k in BET_CODES:
            arr = m.get(k, [])
            if isinstance(arr, list):
                # แปลงให้เป็น bool
                out[k] = [bool(x) for x in arr][-6:]
    return out

def save_mini6():
    # เก็บเฉพาะ 6 ตัวล่าสุด
    trimmed = {k: (MINI6.get(k, [])[-6:]) for k in BET_CODES}
    save_json(MINI6_FILE, trimmed)

# ====== MQTT publish ======
def mqtt_publish(topic, obj, retain=False):
    try:
        client.publish(topic, json.dumps(obj), retain=retain)
    except Exception as e:
        print("Publish failed:", e)

def publish_state_now():
    mqtt_publish(TOPIC_STATE, {"phase": phase, "countdown": countdown, "roundId": round_id}, retain=True)

def publish_streaks():
    mqtt_publish(TOPIC_STREAKS, {"streaks": STREAKS}, retain=True)

def publish_history():
    mqtt_publish(TOPIC_HISTORY, {"history": HISTORY[-HISTORY_MAX:]}, retain=True)

def publish_mini6():
    # ส่งเป็น 0/1 เพื่อย่น payload
    payload = {k: [1 if v else 0 for v in MINI6.get(k, [])[-6:]] for k in BET_CODES}
    mqtt_publish(TOPIC_MINI6, {"mini6": payload}, retain=True)

# ====== Update logic ======
def update_streaks_and_mini6(winners_set, winner_side_letter):
    """winners_set: set ของ bet codes ที่ 'ออก' ในรอบนี้ (รวม LEFT_WIN/RIGHT_WIN/TIE)
       winner_side_letter: 'L'|'R'|'S' (สำหรับ history 10 จุดบน) """
    # 1) streaks
    for code in BET_CODES:
        if code in winners_set:
            STREAKS[code] = 0
        else:
            STREAKS[code] = int(STREAKS.get(code, 0)) + 1
    save_streaks(); publish_streaks()

    # 2) mini6: true=ออก, false=ไม่ออก (ล่าสุดอยู่ท้าย)
    for code in BET_CODES:
        hit = (code in winners_set)
        arr = MINI6.get(code, [])
        arr.append(bool(hit))
        if len(arr) > 6: arr = arr[-6:]
        MINI6[code] = arr
    save_mini6(); publish_mini6()

    # 3) history 10 จุดบน
    append_history_once(winner_side_letter)

def append_history_once(side_letter):
    global LAST_HISTORY_ROUND
    try:
        if LAST_HISTORY_ROUND != round_id:
            HISTORY.append({"roundId": round_id, "winner": side_letter})
            if len(HISTORY) > HISTORY_MAX:
                del HISTORY[:-HISTORY_MAX]
            save_history(); publish_history()
            LAST_HISTORY_ROUND = round_id
        else:
            if HISTORY:
                HISTORY[-1]["winner"] = side_letter
                save_history(); publish_history()
    except Exception as e:
        print("append_history_once err:", e)

# ====== MQTT ======
def on_msg(topic, msg):
    global bets
    try:
        if topic.startswith(b"cowboy/bets/"):
            if phase != "BETTING":
                return
            data = json.loads(msg)
            rid = int(data.get("roundId", -1))
            if rid != round_id:
                return
            code = str(data.get("code", ""))
            amt  = int(data.get("amount", 0))
            cid  = topic.decode().split("/", 2)[-1]
            if amt > 0 and code:
                bets.append({"client": cid, "code": code, "amount": amt, "roundId": rid})
            return

        if topic == TOPIC_WINNERS:
            data = json.loads(msg)
            winners = data.get("winners", [])
            wside   = str(data.get("winnerSide", "S")).upper()
            if wside not in ("L","R","S"): wside = "S"

            # รวม outcome หลักเข้า winners_set
            side_code = "TIE" if wside == "S" else ("LEFT_WIN" if wside == "L" else "RIGHT_WIN")
            winners_set = set(winners or [])
            winners_set.add(side_code)

            update_streaks_and_mini6(winners_set, wside)
            return

    except Exception as e:
        print("Bad msg:", e)

def mqtt_connect():
    rnd = ubinascii.hexlify(bytes([urandom.getrandbits(8) for _ in range(3)])).decode()
    cid = ("mpy_%s" % rnd).encode()
    c = MQTTClient(client_id=cid,
                   server=MQTT_HOST, port=MQTT_PORT,
                   user=MQTT_USER or None, password=MQTT_PASSW or None,
                   ssl=ssl, keepalive=30)
    c.set_callback(on_msg)
    c.connect()
    c.subscribe(TOPIC_BETS)
    c.subscribe(TOPIC_WINNERS)
    print("MQTT connected as", cid.decode())
    return c

def mqtt_bootstrap_retained():
    publish_state_now()
    publish_streaks()
    publish_history()
    publish_mini6()

async def broadcast_state():
    while True:
        publish_state_now()
        await asyncio.sleep(1)

async def game_loop():
    global phase, countdown, round_id, bets
    while True:
        # BETTING
        round_id += 1; bets = []
        phase = "BETTING"; countdown = T_BETTING
        while countdown > 0:
            await asyncio.sleep(1); countdown -= 1

        # FLIP
        phase = "FLIP"; countdown = T_FLIP
        pack = deal_pack()
        while countdown > 0:
            await asyncio.sleep(1); countdown -= 1

        # RESULT
        phase = "RESULT"; countdown = T_RESULT
        obj = {"roundId": round_id}; obj.update(pack)
        mqtt_publish(TOPIC_REVEAL, obj, retain=False)
        while countdown > 0:
            await asyncio.sleep(1); countdown -= 1

async def mqtt_rx_pump():
    while True:
        try:
            client.check_msg()
        except Exception as e:
            try:
                client.disconnect()
            except:
                pass
            print("MQTT error, reconnecting...", e)
            await asyncio.sleep(2)
            reconnect()
        await asyncio.sleep_ms(50)

def reconnect():
    global client, STREAKS, HISTORY, MINI6, LAST_HISTORY_ROUND
    STREAKS = load_streaks()
    HISTORY = load_history()
    MINI6   = load_mini6()
    LAST_HISTORY_ROUND = -1
    while True:
        try:
            c = mqtt_connect()
            globals()['client'] = c
            mqtt_bootstrap_retained()
            return
        except Exception as e:
            print("MQTT reconnect failed:", e)
            time.sleep(2)

def main():
    wifi_connect()
    reconnect()
    loop = asyncio.get_event_loop()
    loop.create_task(broadcast_state())
    loop.create_task(mqtt_rx_pump())
    loop.run_until_complete(game_loop())

if __name__ == "__main__":
    main()
