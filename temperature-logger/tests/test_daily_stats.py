import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))
import storage  # noqa: E402


def milliseconds(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


class DailyStatsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.db_path = Path(directory.name) / "readings.db"

    def test_empty_database_and_first_measurements(self):
        storage.initialize(self.db_path)
        with storage.connect(self.db_path) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM daily_stats").fetchone()[0], 0
            )
        self.assertTrue(storage.validate_daily_stats(self.db_path)["ok"])
        self.assertEqual(storage.summary(self.db_path, 0, 2**63 - 1)["count"], 0)

        first = milliseconds("2024-02-28T14:59:00+00:00")
        second = milliseconds("2024-02-28T15:00:00+00:00")
        storage.insert(self.db_path, first, 20, 50)
        storage.insert(self.db_path, first + 1000, 22, 60)
        storage.insert(self.db_path, second, 24, 70)
        with storage.connect(self.db_path) as db:
            rows = db.execute("SELECT * FROM daily_stats ORDER BY day").fetchall()
        self.assertEqual([row["day"] for row in rows], ["2024-02-28", "2024-02-29"])
        self.assertEqual([row["samples"] for row in rows], [2, 1])
        self.assertEqual(rows[0]["temperature_sum"], 42)
        self.assertEqual(rows[0]["temperature_min"], 20)
        self.assertEqual(rows[0]["temperature_max"], 22)
        self.assertEqual(rows[0]["humidity_sum"], 110)
        self.assertTrue(storage.validate_daily_stats(self.db_path)["ok"])

    def test_duplicate_and_failed_upsert_roll_back_both_tables(self):
        storage.initialize(self.db_path)
        when = milliseconds("2024-01-01T00:00:00+09:00")
        storage.insert(self.db_path, when, 20, 50)
        with self.assertRaises(sqlite3.IntegrityError):
            storage.insert(self.db_path, when, 20, 50)
        with storage.connect(self.db_path) as db:
            db.execute("""
                CREATE TRIGGER reject_daily BEFORE INSERT ON daily_stats
                BEGIN SELECT RAISE(ABORT, 'daily failure'); END
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            storage.insert(self.db_path, when + 1000, 21, 51)
        with storage.connect(self.db_path) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM readings").fetchone()[0], 1
            )
            self.assertEqual(
                db.execute("SELECT samples FROM daily_stats").fetchone()[0], 1
            )
            self.assertEqual(
                db.execute("SELECT samples FROM hourly_stats").fetchone()[0], 1
            )
        self.assertTrue(storage.validate_daily_stats(self.db_path)["ok"])

    def test_legacy_database_uses_raw_data_until_rebuild(self):
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute("""
                CREATE TABLE readings (
                    id INTEGER PRIMARY KEY,
                    measured_at_ms INTEGER NOT NULL,
                    temperature REAL NOT NULL,
                    humidity REAL NOT NULL,
                    ambient_sent_at_ms INTEGER,
                    UNIQUE (measured_at_ms, temperature, humidity)
                )
            """)
            db.execute(
                "INSERT INTO readings (measured_at_ms, temperature, humidity) VALUES (?, ?, ?)",
                (milliseconds("2024-01-01T00:00:00+09:00"), 10, 40),
            )
        storage.initialize(self.db_path)
        with storage.connect(self.db_path) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 0)
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM daily_stats").fetchone()[0], 0
            )
        start = milliseconds("2024-01-01T00:00:00+09:00")
        end = milliseconds("2024-01-02T00:00:00+09:00")
        self.assertEqual(storage.summary(self.db_path, start, end)["count"], 1)
        self.assertEqual(
            storage.grouped(self.db_path, start, end, "day")[0]["count"], 1
        )
        storage.insert(self.db_path, start + 1000, 20, 50)
        self.assertEqual(storage.summary(self.db_path, start, end)["count"], 2)
        self.assertFalse(storage.validate_daily_stats(self.db_path)["ok"])

        self.assertEqual(storage.rebuild_daily_stats(self.db_path), 1)
        self.assertTrue(storage.validate_daily_stats(self.db_path)["ok"])
        self.assertEqual(storage.rebuild_daily_stats(self.db_path), 1)
        self.assertTrue(storage.validate_daily_stats(self.db_path)["ok"])
        with storage.connect(self.db_path) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM readings").fetchone()[0], 2
            )

    def test_rebuild_failure_preserves_existing_stats_and_version(self):
        storage.initialize(self.db_path)
        storage.insert(self.db_path, milliseconds("2024-01-01T00:00:00+09:00"), 20, 50)
        before = storage.validate_daily_stats(self.db_path)
        with storage.connect(self.db_path) as db:
            db.execute("""
                CREATE TRIGGER reject_rebuild BEFORE INSERT ON daily_stats
                BEGIN SELECT RAISE(ABORT, 'rebuild failure'); END
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            storage.rebuild_daily_stats(self.db_path)
        after = storage.validate_daily_stats(self.db_path)
        self.assertEqual(after["daily_totals"], before["daily_totals"])
        self.assertTrue(after["ok"])

    def test_initial_rebuild_failure_keeps_raw_fallback(self):
        storage.initialize(self.db_path)
        when = milliseconds("2024-01-01T00:00:00+09:00")
        with storage.connect(self.db_path) as db:
            db.execute("PRAGMA user_version = 0")
            db.execute(
                "INSERT INTO readings (measured_at_ms, temperature, humidity) VALUES (?, ?, ?)",
                (when, 20, 50),
            )
            db.execute("""
                CREATE TRIGGER reject_initial_rebuild BEFORE INSERT ON daily_stats
                BEGIN SELECT RAISE(ABORT, 'initial rebuild failure'); END
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            storage.rebuild_daily_stats(self.db_path)
        with storage.connect(self.db_path) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 0)
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM daily_stats").fetchone()[0], 0
            )
        self.assertEqual(
            storage.summary(self.db_path, when, when + 86400000)["count"], 1
        )

    def test_fast_statistics_equal_raw_with_calendar_and_partial_ranges(self):
        storage.initialize(self.db_path)
        for when, temperature, humidity in (
            ("2020-12-31T23:59:00+09:00", 10.1, 40.2),
            ("2021-01-01T00:01:00+09:00", 20.3, 50.4),
            ("2024-02-28T23:59:00+09:00", 22.5, 60.6),
            ("2024-02-29T00:00:00+09:00", 24.7, 70.8),
            ("2024-03-01T00:00:00+09:00", 26.9, 80.1),
        ):
            storage.insert(self.db_path, milliseconds(when), temperature, humidity)
        for group, start, end in (
            ("day", "2024-02-27T00:00:00+09:00", "2024-03-02T00:00:00+09:00"),
            ("week", "2020-12-28T00:00:00+09:00", "2021-01-11T00:00:00+09:00"),
            ("month", "2024-02-01T00:00:00+09:00", "2024-04-01T00:00:00+09:00"),
            ("day", "2024-02-28T12:00:00+09:00", "2024-03-01T12:00:00+09:00"),
            ("week", "2020-12-31T12:00:00+09:00", "2021-01-01T12:00:00+09:00"),
            ("month", "2024-02-29T12:00:00+09:00", "2024-03-01T12:00:00+09:00"),
        ):
            with self.subTest(group=group, start=start):
                start_ms, end_ms = milliseconds(start), milliseconds(end)
                fast = storage.summary(self.db_path, start_ms, end_ms)
                raw = storage.summary(self.db_path, start_ms, end_ms, use_daily=False)
                self.assertEqual(fast["count"], raw["count"])
                for field in fast:
                    if field != "count" and fast[field] is not None:
                        self.assertAlmostEqual(fast[field], raw[field])
                fast_rows = storage.grouped(self.db_path, start_ms, end_ms, group)
                with storage.connect(self.db_path) as db:
                    db.execute("PRAGMA user_version = 0")
                raw_rows = storage.grouped(self.db_path, start_ms, end_ms, group)
                with storage.connect(self.db_path) as db:
                    db.execute("PRAGMA user_version = 1")
                self.assertEqual(len(fast_rows), len(raw_rows))
                for fast_row, raw_row in zip(fast_rows, raw_rows):
                    self.assertEqual(
                        fast_row["bucket_start_ms"], raw_row["bucket_start_ms"]
                    )
                    self.assertEqual(fast_row["count"], raw_row["count"])
                    for field in fast_row:
                        if (
                            field not in ("bucket_start_ms", "count")
                            and fast_row[field] is not None
                        ):
                            self.assertAlmostEqual(fast_row[field], raw_row[field])
        self.assertTrue(storage.validate_daily_stats(self.db_path)["ok"])

    def test_validator_detects_corruption_and_cli_repairs_it(self):
        storage.initialize(self.db_path)
        storage.insert(self.db_path, milliseconds("2024-01-01T00:00:00+09:00"), 20, 50)
        with storage.connect(self.db_path) as db:
            db.execute(
                "UPDATE daily_stats SET samples = samples + 1, "
                "temperature_sum = temperature_sum + 5"
            )
        report = storage.validate_daily_stats(self.db_path)
        self.assertFalse(report["ok"])
        self.assertGreater(report["mismatch_count"], 0)
        self.assertIn("samples", {item["field"] for item in report["mismatches"]})
        command = [
            sys.executable,
            str(PROJECT_DIR / "rebuild_daily_stats.py"),
            "--db",
            str(self.db_path),
        ]
        check = subprocess.run([*command, "--check"], capture_output=True, text=True)
        self.assertEqual(check.returncode, 1)
        rebuilt = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(rebuilt.returncode, 0, rebuilt.stderr)
        self.assertTrue(json.loads(rebuilt.stdout)["ok"])
        self.assertEqual(
            subprocess.run([*command, "--check"], capture_output=True).returncode, 0
        )


if __name__ == "__main__":
    unittest.main()
