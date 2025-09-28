# server_mqtt.py — MicroPython ESP32 dealer via MQTT (complete)
import network, time, ujson as json, uasyncio as asyncio, ubinascii, urandom, ussl
from umqtt.simple import MQTTClient

# ====== CONFIG (EDIT ME) ======
WIFI_SSID   = "YOUR_WIFI"
WIFI_PASS   = "YOUR_PASS"

# For quick testing with Mosquitto public broker (no auth):
MQTT_HOST   = "broker.emqx.io"
MQTT_PORT   = 8883                   # MQTTS
MQTT_USER   = ""                     # leave empty for test.mosquitto.org
MQTT_PASSW  = ""

TOPIC_STATE  = b"cowboy/state"
TOPIC_REVEAL = b"cowboy/reveal"
TOPIC_BETS   = b"cowboy/bets/#"

# Round timing (seconds)
T_BETTING = 15
T_LOCK    = 2
T_REVEAL  = 4

# ====== Globals ======
client = None
phase = "BETTING"
countdown = 0
round_id = 0
bets = []  # simple list of bet dicts per round

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
    suits = [b"s", b"h", b"d", b"c"]  # use ascii letters for suits
    deck = []
    for s in suits:
        for r in ranks:
            deck.append(bytes([r]) + s)  # e.g. b"As', b'Kd'
    # Fisher–Yates shuffle using getrandbits
    n = len(deck)
    for i in range(n - 1, 0, -1):
        j = urandom.getrandbits(16) % (i + 1)
        deck[i], deck[j] = deck[j], deck[i]
    return deck

def deal_pack():
    d = make_deck()
    L = [d.pop().decode(), d.pop().decode()]
    R = [d.pop().decode(), d.pop().decode()]
    board = [d.pop().decode(), d.pop().decode(), d.pop().decode(), d.pop().decode(), d.pop().decode()]
    return {"L": L, "R": R, "board": board}

# ====== MQTT ======
def on_msg(topic, msg):
    # Expect topic "cowboy/bets/<clientId>"
    global bets, phase, round_id
    try:
        if not topic.startswith(b"cowboy/bets/"):
            return
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
    except Exception as e:
        print("Bad bet msg:", e)

def mqtt_connect():
    # random short client id
    rnd = ubinascii.hexlify(bytes([urandom.getrandbits(8) for _ in range(3)])).decode()
    cid = ("mpy_%s" % rnd).encode()
    # ssl_params with SNI for many brokers; full CA verify may require custom firmware
    c = MQTTClient(client_id=cid,
                   server=MQTT_HOST, port=MQTT_PORT,
                   user=MQTT_USER or None, password=MQTT_PASSW or None,
                   ssl=ussl,
                   keepalive=30)
    c.set_callback(on_msg)
    c.connect()
    c.subscribe(TOPIC_BETS)
    print("MQTT connected as", cid.decode())
    return c

def mqtt_publish(topic, obj, retain=False):
    payload = json.dumps(obj)
    try:
        client.publish(topic, payload, retain=retain)
    except Exception as e:
        print("Publish failed:", e)

# ====== Async tasks ======
async def broadcast_state():
    # Publish current state once per second (retained)
    while True:
        mqtt_publish(TOPIC_STATE, {"phase": phase, "countdown": countdown, "roundId": round_id}, retain=True)
        await asyncio.sleep(1)

async def game_loop():
    global phase, countdown, round_id, bets
    while True:
        # 1) BETTING
        round_id += 1
        bets = []
        phase = "BETTING"; countdown = T_BETTING
        while countdown > 0:
            await asyncio.sleep(1)
            countdown -= 1

        # 2) LOCK
        phase = "LOCK"; countdown = T_LOCK
        while countdown > 0:
            await asyncio.sleep(1)
            countdown -= 1

        # 3) REVEAL
        phase = "REVEAL"; countdown = T_REVEAL
        pack = deal_pack()
        payload = {"roundId": round_id}
        payload.update(pack)
        mqtt_publish(TOPIC_REVEAL, payload, retain=False)
        # TODO: compute payouts here if needed and publish per-client summaries
        while countdown > 0:
            await asyncio.sleep(1)
            countdown -= 1

async def mqtt_rx_pump():
    # Poll incoming MQTT messages (umqtt.simple needs polling)
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
    global client
    while True:
        try:
            client = mqtt_connect()
            # Immediately publish current state so late joiners get context
            mqtt_publish(TOPIC_STATE, {"phase": phase, "countdown": countdown, "roundId": round_id}, retain=True)
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
