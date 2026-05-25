import os
import time
import tomllib
import threading
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify

from sensor_dht22 import read_dht22

JST = ZoneInfo("Asia/Tokyo")

BASE_DIR = Path(__file__).parent

load_dotenv(BASE_DIR / ".env")

with open(BASE_DIR / "config.toml", "rb") as f:
    config = tomllib.load(f)


AMBIENT_CHANNEL_ID = os.environ["AMBIENT_CHANNEL_ID"]
AMBIENT_WRITE_KEY = os.environ["AMBIENT_WRITE_KEY"]

DHT_PIN = config["dht22"].get("pin", "D4")
DHT_RETRIES = int(config["dht22"].get("retries", 3))
DHT_RETRY_DELAY_SECONDS = float(config["dht22"].get("retry_delay_seconds", 2.0))

SEND_INTERVAL_SECONDS = int(config["sender"].get("interval_seconds", 60))

SERVER_HOST = config["server"].get("host", "0.0.0.0")
SERVER_PORT = int(config["server"].get("port", 8000))


app = Flask(__name__)

latest_data = {
    "temperature": None,
    "humidity": None,
    "sent_at": None,
    "last_error": None,
}


def send_to_ambient(temperature: float, humidity: float) -> None:
    url = f"https://ambidata.io/api/v2/channels/{AMBIENT_CHANNEL_ID}/data"

    payload = {
        "writeKey": AMBIENT_WRITE_KEY,
        "d1": temperature,
        "d2": humidity,
    }

    response = requests.post(url, json=payload, timeout=10)
    response.raise_for_status()


def sender_loop() -> None:
    global latest_data

    while True:
        try:
            temperature, humidity = read_dht22(
                pin_name=DHT_PIN,
                retries=DHT_RETRIES,
                delay_seconds=DHT_RETRY_DELAY_SECONDS,
            )

            send_to_ambient(temperature, humidity)

            latest_data = {
                "temperature": temperature,
                "humidity": humidity,
                "sent_at": datetime.now(JST).isoformat(),
                "last_error": None,
            }

            print(
                f"sent: temperature={temperature}, humidity={humidity}",
                flush=True,
            )

        except Exception as e:
            latest_data["last_error"] = str(e)
            print(f"error: {e}", flush=True)

        time.sleep(SEND_INTERVAL_SECONDS)


@app.route("/")
def index():
    return "OK"


@app.route("/health")
def health():
    return jsonify(latest_data)


def start_background_sender() -> None:
    thread = threading.Thread(target=sender_loop, daemon=True)
    thread.start()


if __name__ == "__main__":
    start_background_sender()

    app.run(
        host=SERVER_HOST,
        port=SERVER_PORT,
        debug=False,
        use_reloader=False,
    )
