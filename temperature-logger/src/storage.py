"""SQLite storage for sensor readings."""

import math
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from itertools import zip_longest
from pathlib import Path
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")
JST_OFFSET_MS = 9 * 60 * 60 * 1000
DAY_MS = 24 * 60 * 60 * 1000
DAILY_STATS_VERSION = 1
DAILY_STATS_SCHEMA = """
    CREATE TABLE IF NOT EXISTS daily_stats (
        day TEXT PRIMARY KEY,
        samples INTEGER NOT NULL,
        temperature_sum REAL NOT NULL,
        temperature_min REAL NOT NULL,
        temperature_max REAL NOT NULL,
        humidity_sum REAL NOT NULL,
        humidity_min REAL NOT NULL,
        humidity_max REAL NOT NULL
    )
"""


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
        db.execute("BEGIN IMMEDIATE")
        daily_existed = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daily_stats'"
        ).fetchone()
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
        db.execute(DAILY_STATS_SCHEMA)
        if not daily_existed:
            # A legacy DB stays on the exact raw-data path until an explicit rebuild.
            has_readings = db.execute("SELECT 1 FROM readings LIMIT 1").fetchone()
            db.execute(
                f"PRAGMA user_version = {0 if has_readings else DAILY_STATS_VERSION}"
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
        day = datetime.fromtimestamp(measured_at_ms / 1000, JST).date().isoformat()
        db.execute(
            "INSERT INTO daily_stats (day, samples, temperature_sum, "
            "temperature_min, temperature_max, humidity_sum, humidity_min, "
            "humidity_max) VALUES (?, 1, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(day) DO UPDATE SET "
            "samples = daily_stats.samples + 1, "
            "temperature_sum = daily_stats.temperature_sum + excluded.temperature_sum, "
            "temperature_min = MIN(daily_stats.temperature_min, excluded.temperature_min), "
            "temperature_max = MAX(daily_stats.temperature_max, excluded.temperature_max), "
            "humidity_sum = daily_stats.humidity_sum + excluded.humidity_sum, "
            "humidity_min = MIN(daily_stats.humidity_min, excluded.humidity_min), "
            "humidity_max = MAX(daily_stats.humidity_max, excluded.humidity_max)",
            (day, temperature, temperature, temperature, humidity, humidity, humidity),
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


def _daily_range(db, start_ms, end_ms):
    if db.execute("PRAGMA user_version").fetchone()[0] != DAILY_STATS_VERSION:
        return None
    if start_ms == 0 and end_ms == 2**63 - 1:
        first = db.execute(
            "SELECT measured_at_ms FROM readings ORDER BY measured_at_ms LIMIT 1"
        ).fetchone()
        last = db.execute(
            "SELECT measured_at_ms FROM readings ORDER BY measured_at_ms DESC LIMIT 1"
        ).fetchone()
        if (first is None or first[0] >= 0) and (last is None or last[0] < end_ms):
            return (None, None)
    if (start_ms + JST_OFFSET_MS) % DAY_MS or (end_ms + JST_OFFSET_MS) % DAY_MS:
        return None
    try:
        return (
            datetime.fromtimestamp(start_ms / 1000, JST).date().isoformat(),
            datetime.fromtimestamp(end_ms / 1000, JST).date().isoformat(),
        )
    except (OverflowError, OSError, ValueError):
        return None


def _day_filter(days):
    if days == (None, None):
        return "", ()
    return " WHERE day >= ? AND day < ?", days


def summary(db_path, start_ms, end_ms, use_daily=True):
    with connect(db_path) as db:
        days = _daily_range(db, start_ms, end_ms) if use_daily else None
        if days is not None:
            where, params = _day_filter(days)
            row = db.execute(
                "SELECT COALESCE(SUM(samples), 0) AS count, "
                "SUM(temperature_sum) / SUM(samples) AS temperature_avg, "
                "MIN(temperature_min) AS temperature_min, "
                "MAX(temperature_max) AS temperature_max, "
                "SUM(humidity_sum) / SUM(samples) AS humidity_avg, "
                "MIN(humidity_min) AS humidity_min, "
                "MAX(humidity_max) AS humidity_max FROM daily_stats" + where,
                params,
            ).fetchone()
        else:
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
    with connect(db_path) as db:
        days = _daily_range(db, start_ms, end_ms) if interval != "hour" else None
        if days is not None:
            modifier = {
                "day": "day",
                "week": "date(day, 'weekday 0', '-6 days')",
                "month": "date(day, 'start of month')",
            }[interval]
            expression = (
                f"CAST(strftime('%s', {modifier}) AS INTEGER) * 1000 "
                f"- {JST_OFFSET_MS}"
            )
            where, params = _day_filter(days)
            rows = db.execute(
                f"SELECT {expression} AS bucket_start_ms, SUM(samples) AS count, "
                "SUM(temperature_sum) / SUM(samples) AS temperature_avg, "
                "MIN(temperature_min) AS temperature_min, "
                "MAX(temperature_max) AS temperature_max, "
                "SUM(humidity_sum) / SUM(samples) AS humidity_avg, "
                "MIN(humidity_min) AS humidity_min, "
                "MAX(humidity_max) AS humidity_max FROM daily_stats"
                f"{where} GROUP BY bucket_start_ms ORDER BY bucket_start_ms",
                params,
            ).fetchall()
            return [dict(row) for row in rows]

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


def rebuild_daily_stats(db_path):
    """Replace the derived table atomically from the authoritative readings."""
    with connect(db_path) as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(DAILY_STATS_SCHEMA)
        db.execute("DELETE FROM daily_stats")
        db.execute(
            "INSERT INTO daily_stats (day, samples, temperature_sum, "
            "temperature_min, temperature_max, humidity_sum, humidity_min, "
            "humidity_max) "
            "SELECT date(measured_at_ms / 1000, 'unixepoch', '+9 hours') AS day, "
            "COUNT(*), SUM(temperature), MIN(temperature), MAX(temperature), "
            "SUM(humidity), MIN(humidity), MAX(humidity) "
            "FROM readings GROUP BY day"
        )
        db.execute(f"PRAGMA user_version = {DAILY_STATS_VERSION}")
        return db.execute("SELECT COUNT(*) FROM daily_stats").fetchone()[0]


def validate_daily_stats(db_path):
    """Compare the derived table with SQL aggregates of the source data."""
    fields = (
        "samples",
        "temperature_sum",
        "temperature_min",
        "temperature_max",
        "humidity_sum",
        "humidity_min",
        "humidity_max",
    )
    mismatches = []
    mismatch_count = 0

    def compare(scope, expected, actual):
        nonlocal mismatch_count
        for field in fields:
            left = expected[field]
            right = actual[field]
            if field.endswith("_sum") and left is not None and right is not None:
                equal = math.isclose(left, right, rel_tol=1e-9, abs_tol=1e-6)
            else:
                equal = left == right
            if not equal:
                mismatch_count += 1
                if len(mismatches) < 20:
                    mismatches.append(
                        {
                            "scope": scope,
                            "field": field,
                            "readings": left,
                            "daily_stats": right,
                        }
                    )

    with connect(db_path) as db:
        ready = db.execute("PRAGMA user_version").fetchone()[0] == DAILY_STATS_VERSION
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
        raw_totals = dict(
            db.execute(
                "SELECT COUNT(*) AS samples, SUM(temperature) AS temperature_sum, "
                "MIN(temperature) AS temperature_min, "
                "MAX(temperature) AS temperature_max, "
                "SUM(humidity) AS humidity_sum, MIN(humidity) AS humidity_min, "
                "MAX(humidity) AS humidity_max FROM readings"
            ).fetchone()
        )
        exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daily_stats'"
        ).fetchone()
        if not exists:
            return {
                "ok": False,
                "ready": ready,
                "integrity_check": integrity,
                "readings_totals": raw_totals,
                "daily_totals": None,
                "days_compared": 0,
                "mismatch_count": 1,
                "mismatches": [{"scope": "schema", "field": "daily_stats"}],
            }
        daily_totals = dict(
            db.execute(
                "SELECT COALESCE(SUM(samples), 0) AS samples, "
                "SUM(temperature_sum) AS temperature_sum, "
                "MIN(temperature_min) AS temperature_min, "
                "MAX(temperature_max) AS temperature_max, "
                "SUM(humidity_sum) AS humidity_sum, "
                "MIN(humidity_min) AS humidity_min, "
                "MAX(humidity_max) AS humidity_max FROM daily_stats"
            ).fetchone()
        )
        compare("total", raw_totals, daily_totals)
        actual_days = db.execute(
            "SELECT date(measured_at_ms / 1000, 'unixepoch', '+9 hours') AS day, "
            "COUNT(*) AS samples, SUM(temperature) AS temperature_sum, "
            "MIN(temperature) AS temperature_min, "
            "MAX(temperature) AS temperature_max, SUM(humidity) AS humidity_sum, "
            "MIN(humidity) AS humidity_min, MAX(humidity) AS humidity_max "
            "FROM readings GROUP BY day ORDER BY day"
        )
        stored_days = db.execute("SELECT * FROM daily_stats ORDER BY day")
        days_compared = 0
        for expected, actual in zip_longest(actual_days, stored_days):
            days_compared += 1
            if expected is None or actual is None or expected["day"] != actual["day"]:
                mismatch_count += 1
                if len(mismatches) < 20:
                    mismatches.append(
                        {
                            "scope": "day",
                            "readings": expected["day"] if expected else None,
                            "daily_stats": actual["day"] if actual else None,
                        }
                    )
            else:
                compare(expected["day"], expected, actual)
    return {
        "ok": ready and integrity == "ok" and mismatch_count == 0,
        "ready": ready,
        "integrity_check": integrity,
        "readings_totals": raw_totals,
        "daily_totals": daily_totals,
        "days_compared": days_compared,
        "mismatch_count": mismatch_count,
        "mismatches": mismatches,
    }


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
