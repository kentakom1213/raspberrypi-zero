import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))
import storage  # noqa: E402


def milliseconds(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


class HourlyStatsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.db_path = Path(directory.name) / "readings.db"
        storage.initialize(self.db_path)

    def test_new_database_has_empty_ready_hourly_stats(self):
        with storage.connect(self.db_path) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM hourly_stats").fetchone()[0], 0
            )
        self.assertTrue(storage.validate_hourly_stats(self.db_path)["ok"])

    def test_insert_boundaries_duplicate_and_rollback(self):
        first = milliseconds("2024-02-28T23:59:00+09:00")
        second = milliseconds("2024-02-29T00:00:00+09:00")
        storage.insert(self.db_path, first, 20, 50)
        storage.insert(self.db_path, first + 1000, 22, 60)
        storage.insert(self.db_path, second, 24, 70)
        with self.assertRaises(sqlite3.IntegrityError):
            storage.insert(self.db_path, first, 20, 50)
        with storage.connect(self.db_path) as db:
            rows = db.execute(
                "SELECT * FROM hourly_stats ORDER BY hour_start_ms"
            ).fetchall()
            self.assertEqual([row["samples"] for row in rows], [2, 1])
            self.assertEqual(
                [row["hour_start_ms"] for row in rows],
                [milliseconds("2024-02-28T23:00:00+09:00"), second],
            )
            self.assertEqual(rows[0]["temperature_sum"], 42)
            self.assertEqual(rows[0]["humidity_max"], 60)
            db.execute("""
                CREATE TRIGGER reject_hourly BEFORE INSERT ON hourly_stats
                BEGIN SELECT RAISE(ABORT, 'hourly failure'); END
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            storage.insert(self.db_path, second + storage.HOUR_MS, 30, 75)
        with storage.connect(self.db_path) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM readings").fetchone()[0], 3
            )
            self.assertEqual(
                db.execute("SELECT SUM(samples) FROM daily_stats").fetchone()[0], 3
            )
        self.assertTrue(storage.validate_hourly_stats(self.db_path)["ok"])

    def test_open_ended_partial_day_uses_daily_and_edge_readings(self):
        first = milliseconds("2024-02-29T00:30:00+09:00")
        second = milliseconds("2024-03-01T00:30:00+09:00")
        storage.insert(self.db_path, first, 20, 50)
        storage.insert(self.db_path, second, 24, 60)
        result = storage.summary(self.db_path, first + 1, 2**63 - 1)
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["temperature_avg"], 24)

    def test_rebuild_repeatability_and_cli_check(self):
        stamp = milliseconds("2024-01-01T00:20:00+09:00")
        with storage.connect(self.db_path) as db:
            db.execute("PRAGMA user_version = 1")
            db.execute(
                "INSERT INTO readings (measured_at_ms, temperature, humidity) VALUES (?, ?, ?)",
                (stamp, 20, 50),
            )
        self.assertFalse(storage.validate_hourly_stats(self.db_path)["ok"])
        self.assertEqual(storage.rebuild_hourly_stats(self.db_path), 1)
        self.assertEqual(storage.rebuild_hourly_stats(self.db_path), 1)
        self.assertTrue(storage.validate_hourly_stats(self.db_path)["ok"])
        command = [
            sys.executable,
            str(PROJECT_DIR / "rebuild_hourly_stats.py"),
            "--db",
            str(self.db_path),
            "--check",
        ]
        checked = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(json.loads(checked.stdout)["hourly_samples"], 1)
        with storage.connect(self.db_path) as db:
            db.execute("UPDATE hourly_stats SET samples = samples + 1")
        self.assertFalse(storage.validate_hourly_stats(self.db_path)["ok"])
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 1)
        storage.rebuild_hourly_stats(self.db_path)
        self.assertTrue(storage.validate_hourly_stats(self.db_path)["ok"])

    def test_rebuild_failure_preserves_previous_aggregate(self):
        stamp = milliseconds("2024-01-01T00:20:00+09:00")
        storage.insert(self.db_path, stamp, 20, 50)
        with storage.connect(self.db_path) as db:
            db.execute("""
                CREATE TRIGGER reject_rebuild BEFORE INSERT ON hourly_stats
                BEGIN SELECT RAISE(ABORT, 'rebuild failure'); END
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            storage.rebuild_hourly_stats(self.db_path)
        self.assertTrue(storage.validate_hourly_stats(self.db_path)["ok"])

    def test_fast_aggregates_equal_raw_for_partial_ranges(self):
        for when, temperature, humidity in (
            ("2024-02-28T23:59:00+09:00", 10, 40),
            ("2024-02-29T00:01:00+09:00", 20, 50),
            ("2024-02-29T00:30:00+09:00", 22, 55),
            ("2024-02-29T02:00:00+09:00", 24, 60),
            ("2024-03-01T00:00:00+09:00", 30, 70),
        ):
            storage.insert(self.db_path, milliseconds(when), temperature, humidity)
        for group in ("hour", "day", "week", "month"):
            for start, end in (
                ("2024-02-28T23:30:00+09:00", "2024-03-01T00:30:00+09:00"),
                ("2024-02-29T00:10:00+09:00", "2024-02-29T00:40:00+09:00"),
                ("2024-02-29T00:00:00+09:00", "2024-03-01T00:00:00+09:00"),
            ):
                with self.subTest(group=group, start=start):
                    start_ms, end_ms = milliseconds(start), milliseconds(end)
                    fast = storage.grouped(self.db_path, start_ms, end_ms, group)
                    summary = storage.summary(
                        self.db_path,
                        start_ms,
                        end_ms,
                        use_daily=group != "hour",
                        use_hourly=group == "hour",
                    )
                    raw_summary = storage.summary(
                        self.db_path, start_ms, end_ms, use_daily=False
                    )
                    with storage.connect(self.db_path) as db:
                        db.execute("PRAGMA user_version = 0")
                    raw = storage.grouped(self.db_path, start_ms, end_ms, group)
                    with storage.connect(self.db_path) as db:
                        db.execute("PRAGMA user_version = 2")
                    self.assertEqual(summary["count"], raw_summary["count"])
                    self.assertEqual(len(fast), len(raw))
                    for left, right in zip(fast, raw):
                        for field in left:
                            if field in ("count", "bucket_start_ms"):
                                self.assertEqual(left[field], right[field])
                            elif left[field] is not None:
                                self.assertAlmostEqual(left[field], right[field])
        self.assertTrue(storage.validate_hourly_stats(self.db_path)["ok"])


if __name__ == "__main__":
    unittest.main()
