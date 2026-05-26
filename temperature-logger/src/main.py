import os
import time
import tomllib
import threading
from collections import deque
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template

from sensor_dht22 import DHT22Reader


ROOT_DIR = Path(__file__).resolve().parent.parent
JST = ZoneInfo("Asia/Tokyo")

load_dotenv(ROOT_DIR / ".env")

with open(ROOT_DIR / "config.toml", "rb") as f:
    config = tomllib.load(f)


AMBIENT_CHANNEL_ID = os.environ["AMBIENT_CHANNEL_ID"]
AMBIENT_WRITE_KEY = os.environ["AMBIENT_WRITE_KEY"]

DHT_PIN = config["dht22"].get("pin", "D4")
DHT_RETRIES = int(config["dht22"].get("retries", 3))
DHT_RETRY_DELAY_SECONDS = float(config["dht22"].get("retry_delay_seconds", 3.0))

SEND_INTERVAL_SECONDS = int(config["sender"].get("interval_seconds", 60))

SERVER_HOST = config["server"].get("host", "0.0.0.0")
SERVER_PORT = int(config["server"].get("port", 8000))

MAX_LOGS = int(config.get("logs", {}).get("max_entries", 100))
MAX_READINGS = int(config.get("chart", {}).get("max_points", 300))


app = Flask(__name__)

sensor = DHT22Reader(
    pin_name=DHT_PIN,
    retries=DHT_RETRIES,
    delay_seconds=DHT_RETRY_DELAY_SECONDS,
)

latest_data = {
    "temperature": None,
    "humidity": None,
    "sent_at": None,
    "last_error": None,
}

logs = deque(maxlen=MAX_LOGS)
readings = deque(maxlen=MAX_READINGS)
lock = threading.Lock()


def now_jst_string() -> str:
    return datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")


def add_log(level: str, message: str, **data) -> None:
    entry = {
        "time": now_jst_string(),
        "level": level,
        "message": message,
        **data,
    }

    with lock:
        logs.appendleft(entry)


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
            temperature, humidity = sensor.read()

            send_to_ambient(temperature, humidity)

            current = {
                "temperature": temperature,
                "humidity": humidity,
                "sent_at": now_jst_string(),
                "last_error": None,
            }

            with lock:
                latest_data = current
                readings.append(
                    {
                        "time": current["sent_at"],
                        "temperature": temperature,
                        "humidity": humidity,
                    }
                )

            add_log(
                "info",
                "sent to Ambient",
                temperature=temperature,
                humidity=humidity,
            )

            print(
                f"sent: temperature={temperature}, humidity={humidity}",
                flush=True,
            )

        except Exception as e:
            error_message = str(e)

            with lock:
                latest_data["last_error"] = error_message

            add_log("error", error_message)

            print(f"error: {error_message}", flush=True)

        time.sleep(SEND_INTERVAL_SECONDS)


@app.route("/")
def index():
    with lock:
        data = dict(latest_data)

    return render_template("index.html", data=data)


@app.route("/health")
def health():
    with lock:
        return jsonify(dict(latest_data))


@app.route("/logs")
def show_logs():
    with lock:
        entries = list(logs)

    return render_template("logs.html", entries=entries)


@app.route("/logs.json")
def logs_json():
    with lock:
        return jsonify(list(logs))


@app.route("/api/readings")
def readings_json():
    with lock:
        return jsonify(list(readings))


def start_background_sender() -> None:
    thread = threading.Thread(target=sender_loop, daemon=True)
    thread.start()


if __name__ == "__main__":
    add_log("info", "server started")
    start_background_sender()

    app.run(
        host=SERVER_HOST,
        port=SERVER_PORT,
        debug=False,
        use_reloader=False,
    )
