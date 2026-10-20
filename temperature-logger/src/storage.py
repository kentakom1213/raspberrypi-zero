"""SQLite storage for sensor readings."""

import math
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")
JST_OFFSET_MS = 9 * 60 * 60 * 1000


@contextmanager
def connect(db_path):
    connection = sqlite3.connect(db_path, timeout=30)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        with connection:
            yield connection
    finally:
        connection.close()


def initialize(db_path):
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with connect(db_path) as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY,
                measured_at_ms INTEGER NOT NULL,
                temperature REAL NOT NULL,
                humidity REAL NOT NULL,
                ambient_sent_at_ms INTEGER,
                UNIQUE (measured_at_ms, temperature, humidity)
            )
        """)
        db.execute(
            "CREATE INDEX IF NOT EXISTS readings_time ON readings(measured_at_ms)"
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS readings_pending ON readings(id) WHERE ambient_sent_at_ms IS NULL"
        )


def validate_values(temperature, humidity):
    if not math.isfinite(temperature) or not math.isfinite(humidity):
        raise ValueError("temperature and humidity must be finite")
    if not -40 <= temperature <= 80 or not 0 <= humidity <= 100:
        raise ValueError("temperature or humidity is outside DHT22 range")


def insert(db_path, measured_at_ms, temperature, humidity, sent=False):
    validate_values(temperature, humidity)
    with connect(db_path) as db:
        cursor = db.execute(
            "INSERT INTO readings (measured_at_ms, temperature, humidity, ambient_sent_at_ms) "
            "VALUES (?, ?, ?, ?)",
            (measured_at_ms, temperature, humidity, measured_at_ms if sent else None),
        )
        return cursor.lastrowid


def pending(db_path, limit=60):
    with connect(db_path) as db:
        return db.execute(
            "SELECT id, measured_at_ms, temperature, humidity FROM readings "
            "WHERE ambient_sent_at_ms IS NULL ORDER BY id LIMIT ?",
            (limit,),
        ).fetchall()


def mark_sent(db_path, ids, sent_at_ms):
    if not ids:
        return
    with connect(db_path) as db:
        db.executemany(
            "UPDATE readings SET ambient_sent_at_ms = ? WHERE id = ? AND ambient_sent_at_ms IS NULL",
            ((sent_at_ms, row_id) for row_id in ids),
        )


def latest(db_path, limit):
    with connect(db_path) as db:
        rows = db.execute(
            "SELECT measured_at_ms, temperature, humidity FROM readings "
            "ORDER BY measured_at_ms DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return list(reversed(rows))


def range_readings(db_path, start_ms, end_ms, limit):
    with connect(db_path) as db:
        return db.execute(
            "SELECT measured_at_ms, temperature, humidity FROM readings "
            "WHERE measured_at_ms >= ? AND measured_at_ms < ? "
            "ORDER BY measured_at_ms, id LIMIT ?",
            (start_ms, end_ms, limit),
        ).fetchall()


def summary(db_path, start_ms, end_ms):
    with connect(db_path) as db:
        row = db.execute(
            "SELECT COUNT(*) AS count, AVG(temperature) AS temperature_avg, "
            "MIN(temperature) AS temperature_min, MAX(temperature) AS temperature_max, "
            "AVG(humidity) AS humidity_avg, MIN(humidity) AS humidity_min, "
            "MAX(humidity) AS humidity_max "
            "FROM readings WHERE measured_at_ms >= ? AND measured_at_ms < ?",
            (start_ms, end_ms),
        ).fetchone()
    return dict(row)


def grouped(db_path, start_ms, end_ms, interval):
    if interval in ("hour", "day"):
        bucket_ms = {"hour": 3600000, "day": 86400000}[interval]
        # Japan Standard Time has no daylight saving time; group boundaries are JST.
        expression = (
            f"((measured_at_ms + {JST_OFFSET_MS}) / {bucket_ms}) "
            f"* {bucket_ms} - {JST_OFFSET_MS}"
        )
    else:
        # SQLite's weekday 0 is Sunday; the preceding six days start on Monday.
        modifier = (
            "'weekday 0', '-6 days'" if interval == "week" else "'start of month'"
        )
        expression = (
            "CAST(strftime('%s', date(measured_at_ms / 1000, 'unixepoch', "
            f"'+9 hours', {modifier})) AS INTEGER) * 1000 - {JST_OFFSET_MS}"
        )
    with connect(db_path) as db:
        rows = db.execute(
            f"SELECT {expression} AS bucket_start_ms, COUNT(*) AS count, "
            "AVG(temperature) AS temperature_avg, MIN(temperature) AS temperature_min, "
            "MAX(temperature) AS temperature_max, AVG(humidity) AS humidity_avg, "
            "MIN(humidity) AS humidity_min, MAX(humidity) AS humidity_max "
            "FROM readings WHERE measured_at_ms >= ? AND measured_at_ms < ? "
            "GROUP BY bucket_start_ms ORDER BY bucket_start_ms",
            (start_ms, end_ms),
        ).fetchall()
    return [dict(row) for row in rows]


def empty_buckets(start_ms, end_ms, interval):
    """Build empty JST calendar periods without loading individual readings."""
    current = datetime.fromtimestamp(start_ms / 1000, JST)
    current = current.replace(minute=0, second=0, microsecond=0)
    if interval != "hour":
        current = current.replace(hour=0)
    if interval == "week":
        current -= timedelta(days=current.weekday())
    elif interval == "month":
        current = current.replace(day=1)

    result = []
    while int(current.timestamp() * 1000) < end_ms:
        if len(result) >= 10000:
            raise ValueError("time range contains more than 10000 buckets")
        bucket_start_ms = int(current.timestamp() * 1000)
        result.append(
            {
                "bucket_start_ms": bucket_start_ms,
                "count": 0,
                "temperature_avg": None,
                "temperature_min": None,
                "temperature_max": None,
                "humidity_avg": None,
                "humidity_min": None,
                "humidity_max": None,
            }
        )
        if interval == "hour":
            current += timedelta(hours=1)
        elif interval == "day":
            current += timedelta(days=1)
        elif interval == "week":
            current += timedelta(weeks=1)
        else:
            year, month = divmod(current.year * 12 + current.month, 12)
            current = current.replace(year=year, month=month + 1)
    return result


def chart_row(row):
    measured_at_ms = row["measured_at_ms"]
    return {
        "time": datetime.fromtimestamp(measured_at_ms / 1000, JST).strftime(
            "%Y-%m-%d %H:%M:%S"
        ),
        "temperature": row["temperature"],
        "humidity": row["humidity"],
    }
