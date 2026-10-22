import csv
import os
import sys
import tempfile
import types
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR))
sys.path.insert(0, str(PROJECT_DIR / "src"))
from import_csv import import_files  # noqa: E402
import storage  # noqa: E402


def milliseconds(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


class TempDatabaseTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.db_path = self.root / "readings.db"


class PersistenceTests(TempDatabaseTest):
    def test_csv_import_deduplicates_reports_and_never_overwrites(self):
        paths = [self.root / "a.csv", self.root / "b.csv"]
        header = ["created", "気温 (℃)", "湿度 (%)", "cmnt"]
        for path, rows in zip(
            paths,
            [
                [
                    ["2026/6/1 0:30:00.123", "20", "50", ""],
                    ["2026/6/1 0:30:00.123", "20", "50", ""],
                ],
                [
                    ["2026/6/1 1:30:00.84", "22", "60", ""],
                    ["2026/6/1 1:31:00.4", "23", "61", ""],
                    ["bad", "22", "60", ""],
                ],
            ],
        ):
            with path.open("w", encoding="utf-8-sig", newline="") as output:
                writer = csv.writer(output)
                writer.writerow(header)
                writer.writerows(rows)
        report = import_files(paths, self.db_path, ZoneInfo("Asia/Tokyo"))
        self.assertEqual(
            (report["imported"], report["duplicates"], report["invalid"]), (3, 1, 1)
        )
        self.assertEqual([f["imported"] for f in report["files"]], [1, 2])
        self.assertEqual(report["files"][1]["errors"][0]["line"], 4)
        self.assertEqual(report["integrity_check"], "ok")
        self.assertEqual(report["oldest"], "2026-06-01T00:30:00.123000+09:00")
        self.assertEqual(report["newest"], "2026-06-01T01:31:00.004000+09:00")
        self.assertEqual(
            [
                row["measured_at_ms"] % 1000
                for row in storage.range_readings(self.db_path, 0, 2**63 - 1, 10)
            ],
            [123, 84, 4],
        )
        self.assertEqual(len(storage.pending(self.db_path)), 0)
        self.assertTrue(storage.validate_daily_stats(self.db_path)["ok"])
        self.assertTrue(storage.validate_hourly_stats(self.db_path)["ok"])
        with self.assertRaises(FileExistsError):
            import_files(paths, self.db_path, ZoneInfo("Asia/Tokyo"))

    def test_live_readings_are_pending_and_grouped_in_jst(self):
        storage.initialize(self.db_path)
        with storage.connect(self.db_path) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(db.execute("PRAGMA synchronous").fetchone()[0], 2)
        midnight_jst = 1780239600000  # 2026-06-01 00:00 JST
        first = storage.insert(self.db_path, midnight_jst + 1800000, 20.0, 50.0)
        storage.insert(self.db_path, midnight_jst + 5400000, 22.0, 60.0)
        self.assertEqual(len(storage.pending(self.db_path)), 2)
        self.assertEqual(
            storage.summary(self.db_path, midnight_jst, midnight_jst + 7200000)[
                "temperature_avg"
            ],
            21.0,
        )
        buckets = storage.grouped(
            self.db_path, midnight_jst, midnight_jst + 7200000, "hour"
        )
        self.assertEqual(
            [row["bucket_start_ms"] for row in buckets],
            [midnight_jst, midnight_jst + 3600000],
        )
        storage.mark_sent(self.db_path, [first], midnight_jst + 7200000)
        self.assertEqual(len(storage.pending(self.db_path)), 1)


class ApiTests(TempDatabaseTest):
    def setUp(self):
        super().setUp()
        try:
            import flask  # noqa: F401
        except ImportError:
            self.skipTest("Flask is required for API tests")
        os.environ["AMBIENT_CHANNEL_ID"] = "test-channel"
        os.environ["AMBIENT_WRITE_KEY"] = "test-key"
        sys.modules.setdefault(
            "dotenv", types.SimpleNamespace(load_dotenv=lambda *args: None)
        )
        import main

        self.main = main
        self.main.DB_PATH = self.db_path
        storage.initialize(self.db_path)
        self.client = main.app.test_client()

    def test_legacy_and_range_api(self):
        storage.insert(self.db_path, 1780249200000, 20.0, 50.0)
        response = self.client.get("/api/readings")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json[0]), {"time", "temperature", "humidity"})
        self.assertEqual(
            len(
                self.client.get(
                    "/api/readings?start_ms=1780249200000&end_ms=1780249200001"
                ).json
            ),
            1,
        )
        self.assertEqual(
            self.client.get("/api/stats?interval=day").json["summary"]["count"], 1
        )
        self.assertEqual(
            len(self.client.get("/api/stats?interval=day").json["buckets"]), 1
        )
        self.assertEqual(self.client.get("/api/stats?interval=week").status_code, 400)
        self.assertEqual(
            set(self.client.get("/health").json),
            {"temperature", "humidity", "sent_at", "last_error"},
        )

    def test_failed_ambient_send_can_be_retried(self):
        storage.insert(self.db_path, 1780249200000, 20.0, 50.0)
        with patch.object(self.main.requests, "post", side_effect=OSError("offline")):
            with self.assertRaises(OSError):
                self.main.send_pending()
        self.assertEqual(len(storage.pending(self.db_path)), 1)
        self.assertTrue(storage.validate_daily_stats(self.db_path)["ok"])
        response = types.SimpleNamespace(raise_for_status=lambda: None)
        with patch.object(self.main.requests, "post", return_value=response) as post:
            self.main.send_pending()
        self.assertEqual(
            post.call_args.kwargs["json"]["data"][0]["created"], 1780249200000
        )
        self.assertEqual(len(storage.pending(self.db_path)), 0)

    def test_daily_statistics_use_jst_boundaries_and_show_gaps(self):
        storage.insert(self.db_path, milliseconds("2024-02-28T14:59:00+00:00"), 10, 40)
        storage.insert(self.db_path, milliseconds("2024-02-28T15:00:00+00:00"), 20, 50)
        response = self.client.get(
            "/api/stats",
            query_string={
                "group_by": "day",
                "from": "2024-02-28T00:00:00+09:00",
                "to": "2024-03-02T00:00:00+09:00",
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.json
        self.assertEqual(data["summary"]["count"], 2)
        self.assertEqual(data["summary"]["temperature_avg"], 15)
        self.assertEqual([row["count"] for row in data["buckets"]], [1, 1, 0])
        self.assertEqual(
            [row["bucket_start_ms"] for row in data["buckets"]],
            [
                milliseconds(f"2024-0{month}-{day:02d}T00:00:00+09:00")
                for month, day in ((2, 28), (2, 29), (3, 1))
            ],
        )
        self.assertIsNone(data["buckets"][2]["temperature_avg"])
        self.assertIsNone(data["buckets"][2]["humidity_max"])
        self.assertEqual(data["buckets"][1]["humidity_min"], 50)

    def test_hourly_statistics_partial_range_and_missing_hour(self):
        for when, temperature, humidity in (
            ("2024-02-29T00:05:00+09:00", 20, 50),
            ("2024-02-29T00:35:00+09:00", 22, 60),
            ("2024-02-29T02:00:00+09:00", 24, 70),
        ):
            storage.insert(self.db_path, milliseconds(when), temperature, humidity)
        response = self.client.get(
            "/api/stats",
            query_string={
                "group_by": "hour",
                "from": "2024-02-29T00:20:00+09:00",
                "to": "2024-02-29T03:00:00+09:00",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            set(response.json), {"start_ms", "end_ms", "summary", "group_by", "buckets"}
        )
        self.assertEqual(response.json["summary"]["count"], 2)
        self.assertEqual(response.json["summary"]["temperature_avg"], 23)
        self.assertEqual([row["count"] for row in response.json["buckets"]], [1, 0, 1])
        self.assertIsNone(response.json["buckets"][1]["temperature_avg"])
        self.assertEqual(
            response.json["buckets"][0]["bucket_start_ms"],
            milliseconds("2024-02-29T00:00:00+09:00"),
        )
        self.assertEqual(
            self.client.get(
                "/api/stats",
                query_string={
                    "interval": "hour",
                    "start_ms": milliseconds("2024-02-29T00:20:00+09:00"),
                    "end_ms": milliseconds("2024-02-29T03:00:00+09:00"),
                },
            ).json["buckets"][0]["count"],
            1,
        )

    def test_weekly_statistics_start_monday_across_year(self):
        storage.insert(self.db_path, milliseconds("2023-12-31T23:59:00+09:00"), 12, 40)
        storage.insert(self.db_path, milliseconds("2024-01-01T00:00:00+09:00"), 22, 60)
        storage.insert(self.db_path, milliseconds("2024-01-15T00:00:00+09:00"), 30, 70)
        response = self.client.get(
            "/api/stats",
            query_string={
                "group_by": "week",
                "from": "2023-12-25T00:00:00+09:00",
                "to": "2024-01-15T00:00:00+09:00",
            },
        )
        self.assertEqual(response.status_code, 200)
        rows = response.json["buckets"]
        self.assertEqual([row["count"] for row in rows], [1, 1, 0])
        self.assertEqual(
            [row["bucket_start_ms"] for row in rows],
            [
                milliseconds(f"{day}T00:00:00+09:00")
                for day in ("2023-12-25", "2024-01-01", "2024-01-08")
            ],
        )
        self.assertEqual(response.json["summary"]["count"], 2)
        self.assertEqual(rows[1]["temperature_max"], 22)

    def test_iso_week_continues_across_new_year(self):
        storage.insert(self.db_path, milliseconds("2020-12-31T23:59:00+09:00"), 10, 40)
        storage.insert(self.db_path, milliseconds("2021-01-01T00:01:00+09:00"), 20, 50)
        response = self.client.get(
            "/api/stats",
            query_string={
                "group_by": "week",
                "from": "2020-12-28T00:00:00+09:00",
                "to": "2021-01-04T00:00:00+09:00",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json["buckets"]), 1)
        self.assertEqual(response.json["buckets"][0]["count"], 2)
        self.assertEqual(
            response.json["buckets"][0]["bucket_start_ms"],
            milliseconds("2020-12-28T00:00:00+09:00"),
        )

    def test_monthly_statistics_and_summary_use_raw_readings(self):
        for when, temperature, humidity in (
            ("2024-02-29T00:00:00+09:00", 10, 40),
            ("2024-02-29T23:59:00+09:00", 20, 50),
            ("2024-03-01T00:00:00+09:00", 30, 60),
        ):
            storage.insert(self.db_path, milliseconds(when), temperature, humidity)
        response = self.client.get(
            "/api/stats",
            query_string={
                "group_by": "month",
                "from": "2024-02-01T00:00:00+09:00",
                "to": "2024-04-01T00:00:00+09:00",
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.json
        self.assertEqual([row["count"] for row in data["buckets"]], [2, 1])
        self.assertEqual(data["buckets"][0]["temperature_avg"], 15)
        self.assertEqual(data["summary"]["temperature_avg"], 20)
        self.assertEqual(data["summary"]["temperature_min"], 10)
        self.assertEqual(data["summary"]["temperature_max"], 30)
        self.assertEqual(data["summary"]["humidity_avg"], 50)
        self.assertEqual(data["summary"]["count"], 3)

    def test_stats_range_validation_and_empty_period(self):
        query = {
            "group_by": "day",
            "from": "2024-01-01T00:00:00+09:00",
            "to": "2024-01-03T00:00:00+09:00",
        }
        response = self.client.get("/api/stats", query_string=query)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["summary"]["count"], 0)
        self.assertEqual([row["count"] for row in response.json["buckets"]], [0, 0])
        self.assertIsNone(response.json["summary"]["temperature_avg"])
        for update in (
            {"group_by": "invalid"},
            {"from": "2024-01-01T00:00:00"},
            {"to": "2024-01-01T00:00:00+09:00"},
            {"interval": "day"},
            {"unknown": "value"},
        ):
            with self.subTest(update=update):
                self.assertEqual(
                    self.client.get(
                        "/api/stats", query_string={**query, **update}
                    ).status_code,
                    400,
                )
        self.assertEqual(self.client.get("/api/stats?group_by=week").status_code, 400)

    def test_iso_time_bounds_remain_start_inclusive_end_exclusive(self):
        for millisecond in (0, 1, 2):
            storage.insert(
                self.db_path,
                milliseconds("2024-01-01T00:00:00+09:00") + millisecond,
                20 + millisecond,
                50,
            )
        response = self.client.get(
            "/api/stats",
            query_string={
                "from": "2024-01-01T00:00:00.000001+09:00",
                "to": "2024-01-01T00:00:00.001001+09:00",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["summary"]["count"], 1)
        self.assertEqual(response.json["summary"]["temperature_avg"], 21)

    def test_api_only_routes_and_no_static_frontend(self):
        for path in ["/", "/stats", "/static/index.html", "/static/app.css", "/static/monitor.js"]:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)
        self.assertEqual(self.client.get("/health").status_code, 200)
        self.assertEqual(self.client.get("/api/readings").json, [])
        self.assertEqual(self.client.get("/api/stats?interval=day").status_code, 200)


if __name__ == "__main__":
    unittest.main()
