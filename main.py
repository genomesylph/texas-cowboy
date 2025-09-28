# main.py — ESP32 MicroPython dealer via MQTT + shared streaks & history (retained)
# - Phases: BETTING(15s) -> FLIP(4s) -> RESULT(6s)
# - Publishes (retained):
#     cowboy/state            : {"phase","countdown","roundId"}
#     cowboy/stats/streaks    : {"streaks": { CODE:int, ... }}
#     cowboy/stats/history    : {"history":[{"roundId":N,"winner":"L|R|S"}, ...]}  (last 10)
# - Publishes (non-retained):
#     cowboy/reveal           : {"roundId", "L":[...], "R":[...], "board":[...]}
# - Subscribes:
#     cowboy/bets/#           : bets from web
#     cowboy/stats/winners    : {"winners":[...], "winnerSide":"L|R|S"}  (จากเว็บ)

import network, time, ujson as json, uasyncio as asyncio, ubinascii, urandom
from umqtt.simple import MQTTClient
import ssl

# ====== CONFIG ======
WIFI_SSID   = "Buta The Cat_2.4G"
WIFI_PASS   = "56098148"

# สำหรับทดสอบกับ Mosquitto สาธารณะ (ใช้ TLS/8883)
MQTT_HOST   = "test.mosquitto.org"
MQTT_PORT   = 8883
MQTT_USER   = ""
MQTT_PASSW  = ""

TOPIC_STATE    = b"cowboy/state"
TOPIC_REVEAL   = b"cowboy/reveal"
TOPIC_BETS     = b"cowboy/bets/#"

# เพิ่มหัวข้อสำหรับสถิติ/ประวัติ
TOPIC_WINNERS  = b"cowboy/stats/winners"
TOPIC_STREAKS  = b"cowboy/stats/streaks"
TOPIC_HISTORY  = b"cowboy/stats/history"

# เวลาต่อรอบ (วินาที)
T_BETTING = 15
T_FLIP    = 4
T_RESULT  = 6

# ====== Globals ======
client = None
phase = "BETTING"
countdown = 0
round_id = 0
bets = []                         # เก็บ bet ของรอบปัจจุบัน

# --- คีย์เดิมพันที่หน้าเว็บใช้ (ต้องตรงกับฝั่งเว็บ) ---
BET_CODES = [
    'LEFT_WIN','RIGHT_WIN','TIE',
    'ANY_HOLE_SUITED_OR_CONN','ANY_HOLE_PAIR','ANY_HOLE_AA',
    'WIN_HIGH_OR_PAIR','WIN_TWO_PAIR','WIN_TRIPS_STRAIGHT_FLUSH',
    'WIN_FULL_HOUSE','ANY_FOUR_OR_SF_OR_ROYAL'
]

# สถิติ "ยังไม่ออก … ตา" (เซฟลงไฟล์ + broadcast retained)
STREAKS_FILE = "streaks.json"
STREAKS = {k: 0 for k in BET_CODES}

# ประวัติผู้ชนะ 10 ตาล่าสุด (L/R/S)
HISTORY_FILE = "history.json"
HISTORY_MAX = 10
HISTORY = []                       # [{"roundId":N,"winner":"L|R|S"}, ...]
LAST_HISTORY_ROUND = -1            # กันบันทึกซ้ำรอบเดียว

# ====== Wi-Fi ======
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
            time.sleep(0.5)
            print(".", end="")
    print("\nWiFi:", sta.ifconfig())

# ====== Deck / Dealing ======
def make_deck():
    ranks = b"23456789TJQKA"
    suits = [b"s", b"h", b"d", b"c"]  # ใช้อักษร s/h/d/c แล้วเว็บแปลงเป็น ♠♥♦♣
    deck = []
    for s in suits:
        for r in ranks:
            deck.append(bytes([r]) + s)  # b"As", b"Kd" (ตัวอย่าง)
    # Fisher-Yates shuffle ด้วย getrandbits
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

# ====== Persist helpers (STREAKS / HISTORY) ======
def load_streaks():
    try:
        with open(STREAKS_FILE, "r") as f:
            s = json.loads(f.read())
        # เติมคีย์ที่อาจขาด
        for k in BET_CODES:
            if k not in s or not isinstance(s[k], int):
                s[k] = 0
        return s
    except:
        return {k: 0 for k in BET_CODES}

def save_streaks():
    try:
        with open(STREAKS_FILE, "w") as f:
            f.write(json.dumps(STREAKS))
    except:
        pass

def load_history():
    try:
        with open(HISTORY_FILE, "r") as f:
            H = json.loads(f.read())
        return H[-HISTORY_MAX:] if isinstance(H, list) else []
    except:
        return []

def save_history():
    try:
        with open(HISTORY_FILE, "w") as f:
            f.write(json.dumps(HISTORY[-HISTORY_MAX:]))
    except:
        pass

# ====== MQTT publish wrappers ======
def mqtt_publish(topic, obj, retain=False):
    payload = json.dumps(obj)
    try:
        client.publish(topic, payload, retain=retain)
    except Exception as e:
        print("Publish failed:", e)

def publish_state_now():
    mqtt_publish(TOPIC_STATE, {"phase": phase, "countdown": countdown, "roundId": round_id}, retain=True)

def publish_streaks():
    mqtt_publish(TOPIC_STREAKS, {"streaks": STREAKS}, retain=True)

def publish_history():
    mqtt_publish(TOPIC_HISTORY, {"history": HISTORY[-HISTORY_MAX:]}, retain=True)

# ====== STREAKS / HISTORY update ======
def update_streaks_with(winners, winner_side):
    """ winners: list ของ bet codes ที่ 'ออก'
        winner_side: 'L'|'R'|'S' (ผลฝั่งชนะสำหรับ 3 ช่องหลัก) """
    try:
        # รวมผลฝั่งชนะเข้าไปใน winners เพื่อรีเซ็ตช่องหลัก
        side_code = "TIE"
        if winner_side == "L":
            side_code = "LEFT_WIN"
        elif winner_side == "R":
            side_code = "RIGHT_WIN"

        winner_set = set(winners or [])
        winner_set.add(side_code)

        # นับ/รีเซ็ตทุกช่อง
        for code in BET_CODES:
            if code in winner_set:
                STREAKS[code] = 0
            else:
                STREAKS[code] = int(STREAKS.get(code, 0)) + 1

        save_streaks()
        publish_streaks()
    except Exception as e:
        print("update_streaks_with err:", e)

def append_history_once(side_letter):
    """ side_letter: 'L'|'R'|'S' """
    global LAST_HISTORY_ROUND
    try:
        if LAST_HISTORY_ROUND != round_id:
            HISTORY.append({"roundId": round_id, "winner": side_letter})
            if len(HISTORY) > HISTORY_MAX:
                del HISTORY[:-HISTORY_MAX]
            save_history()
            publish_history()
            LAST_HISTORY_ROUND = round_id
        else:
            # ถ้ารอบเดียวกันถูกส่งซ้ำ -> อัปเดตรายการสุดท้ายแทน
            if HISTORY:
                HISTORY[-1]["winner"] = side_letter
                save_history()
                publish_history()
    except Exception as e:
        print("append_history_once err:", e)

# ====== MQTT ======
def on_msg(topic, msg):
    # bets: cowboy/bets/<clientId>
    # winners: cowboy/stats/winners
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
            winnerSide = str(data.get("winnerSide", "S")).upper()
            if winnerSide not in ("L","R","S"):
                winnerSide = "S"

            # อัปเดตสถิติโดยยึดค่าจริงจากเว็บ
            update_streaks_with(winners, winnerSide)
            # เติมประวัติ (กันซ้ำรอบเดียว)
            append_history_once(winnerSide)
            return

    except Exception as e:
        print("Bad msg:", e)

def mqtt_connect():
    # client_id สั้น ๆ แบบสุ่ม
    rnd = ubinascii.hexlify(bytes([urandom.getrandbits(8) for _ in range(3)])).decode()
    cid = ("mpy_%s" % rnd).encode()

    c = MQTTClient(client_id=cid,
                   server=MQTT_HOST, port=MQTT_PORT,
                   user=MQTT_USER or None, password=MQTT_PASSW or None,
                   ssl=ssl, keepalive=30)  # ใช้ ssl โมดูล ไม่ใช่ True

    c.connect()
    c.set_callback(on_msg)
    c.subscribe(TOPIC_BETS)
    c.subscribe(TOPIC_WINNERS)
    print("MQTT connected as", cid.decode())
    return c

def mqtt_publish_bootstrap():
    # ส่งค่า retained ปัจจุบันให้ client ที่เพิ่งเชื่อม ได้เห็นทันที
    publish_state_now()
    publish_streaks()
    publish_history()

# ====== Async tasks ======
async def broadcast_state():
    # ยิงสถานะปัจจุบันทุก 1 วินาที (retained)
    while True:
        publish_state_now()
        await asyncio.sleep(1)

async def game_loop():
    global phase, countdown, round_id, bets
    while True:
        # 1) BETTING 15s
        round_id += 1
        bets = []
        phase = "BETTING"; countdown = T_BETTING
        while countdown > 0:
            await asyncio.sleep(1); countdown -= 1

        # 2) FLIP 4s (แอนิเมชันบนเว็บ)
        phase = "FLIP"; countdown = T_FLIP
        pack = deal_pack()  # สุ่มไพ่เตรียมไว้
        while countdown > 0:
            await asyncio.sleep(1); countdown -= 1

        # 3) RESULT 6s (เปิดไพ่จริง)
        phase = "RESULT"; countdown = T_RESULT
        payload = {"roundId": round_id}
        payload.update(pack)
        mqtt_publish(TOPIC_REVEAL, payload, retain=False)  # ส่งตอนเริ่ม RESULT
        while countdown > 0:
            await asyncio.sleep(1); countdown -= 1
        # วนไปเริ่มรอบถัดไป

async def mqtt_rx_pump():
    # umqtt.simple ต้อง poll เอง
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
    global client, STREAKS, HISTORY, LAST_HISTORY_ROUND
    # โหลดข้อมูลสถิติ/ประวัติ (ครั้งแรก/ตอนรีคอนเน็กต์)
    STREAKS = load_streaks()
    HISTORY = load_history()
    LAST_HISTORY_ROUND = -1

    while True:
        try:
            client = mqtt_connect()
            mqtt_publish_bootstrap()
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
