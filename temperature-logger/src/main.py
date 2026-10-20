import os
import threading
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
import tomllib
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from sensor_dht22 import DHT22Reader

import storage

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
MAX_READINGS = int(config.get("chart", {}).get("max_points", 300))
DB_PATH = ROOT_DIR / config.get("storage", {}).get("path", "data/readings.db")

app = Flask(__name__, static_folder="static", static_url_path="/static")
sensor = DHT22Reader(
    pin_name=DHT_PIN, retries=DHT_RETRIES, delay_seconds=DHT_RETRY_DELAY_SECONDS
)
lock = threading.Lock()
latest_data = {
    "temperature": None,
    "humidity": None,
    "sent_at": None,
    "last_error": None,
}


def jst_string(measured_at_ms):
    return datetime.fromtimestamp(measured_at_ms / 1000, JST).strftime(
        "%Y-%m-%d %H:%M:%S"
    )


def send_to_ambient(rows):
    url = f"https://ambidata.io/api/v2/channels/{AMBIENT_CHANNEL_ID}/dataarray"
    payload = {
        "writeKey": AMBIENT_WRITE_KEY,
        "data": [
            {
                "created": row["measured_at_ms"],
                "d1": row["temperature"],
                "d2": row["humidity"],
            }
            for row in rows
        ],
    }
    response = requests.post(url, json=payload, timeout=(3, 5))
    response.raise_for_status()


def send_pending():
    rows = storage.pending(DB_PATH)
    if not rows:
        return
    send_to_ambient(rows)
    storage.mark_sent(DB_PATH, [row["id"] for row in rows], time.time_ns() // 1_000_000)
    print(f"sent to Ambient: {len(rows)} readings", flush=True)


def sender_loop():
    global latest_data
    next_read = time.monotonic()
    while True:
        try:
            temperature, humidity = sensor.read()
            measured_at_ms = time.time_ns() // 1_000_000
            storage.insert(DB_PATH, measured_at_ms, temperature, humidity)
            with lock:
                latest_data = {
                    "temperature": temperature,
                    "humidity": humidity,
                    "sent_at": jst_string(measured_at_ms),
                    "last_error": None,
                }
            print(f"read: temperature={temperature}, humidity={humidity}", flush=True)
        except Exception as error:
            message = f"DHT22 read or SQLite save failed: {error}"
            with lock:
                latest_data["last_error"] = message
            print(f"error: {message}", flush=True)

        try:
            send_pending()
        except Exception as error:
            message = f"Ambient send failed: {error}"
            with lock:
                latest_data["last_error"] = message
            print(f"error: {message}", flush=True)

        next_read += SEND_INTERVAL_SECONDS
        time.sleep(max(0, next_read - time.monotonic()))


def query_parameters():
    def integer(name, default):
        value = request.args.get(name)
        return default if value is None else int(value)

    try:
        start_ms = integer("start_ms", 0)
        end_ms = integer("end_ms", 2**63 - 1)
        if start_ms < 0 or end_ms <= start_ms:
            raise ValueError("start_ms must be nonnegative and less than end_ms")
        return start_ms, end_ms
    except ValueError as error:
        raise ValueError(f"invalid time range: {error}") from error


@app.after_request
def add_cache_headers(response):
    path = request.path
    if path in {"/", "/health", "/api/readings"} or path.startswith("/static/"):
        response.headers["Cache-Control"] = (
            "public, max-age=60, s-maxage=60, stale-while-revalidate=60"
        )
    else:
        response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/health")
def health():
    with lock:
        return jsonify(dict(latest_data))


@app.route("/api/readings")
def readings_json():
    if not request.args:
        return jsonify(
            [storage.chart_row(row) for row in storage.latest(DB_PATH, MAX_READINGS)]
        )
    try:
        start_ms, end_ms = query_parameters()
        limit = int(request.args.get("limit", 1000))
        if not 1 <= limit <= 10000:
            raise ValueError("limit must be between 1 and 10000")
        if set(request.args) - {"start_ms", "end_ms", "limit"}:
            raise ValueError("unknown query parameter")
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    rows = storage.range_readings(DB_PATH, start_ms, end_ms, limit)
    return jsonify(
        [
            {"measured_at_ms": row["measured_at_ms"], **storage.chart_row(row)}
            for row in rows
        ]
    )


@app.route("/api/stats")
def stats_json():
    try:
        start_ms, end_ms = query_parameters()
        interval = request.args.get("interval")
        if interval not in (None, "hour", "day"):
            raise ValueError("interval must be hour or day")
        if set(request.args) - {"start_ms", "end_ms", "interval"}:
            raise ValueError("unknown query parameter")
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    result = {
        "start_ms": start_ms,
        "end_ms": end_ms,
        "summary": storage.summary(DB_PATH, start_ms, end_ms),
    }
    if interval:
        result["interval"] = interval
        result["buckets"] = storage.grouped(DB_PATH, start_ms, end_ms, interval)
    return jsonify(result)


def start_background_sender():
    storage.initialize(DB_PATH)
    rows = storage.latest(DB_PATH, 1)
    if rows:
        row = rows[-1]
        with lock:
            latest_data.update(
                temperature=row["temperature"],
                humidity=row["humidity"],
                sent_at=jst_string(row["measured_at_ms"]),
            )
    thread = threading.Thread(target=sender_loop, daemon=True)
    thread.start()


if __name__ == "__main__":
    start_background_sender()
    app.run(host=SERVER_HOST, port=SERVER_PORT, debug=False, use_reloader=False)
