import csv
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR))
sys.path.insert(0, str(PROJECT_DIR / "src"))
from import_csv import import_files  # noqa: E402
import storage  # noqa: E402


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
                [["2026/6/1 1:30:00.4", "22", "60", ""], ["bad", "22", "60", ""]],
            ],
        ):
            with path.open("w", encoding="utf-8-sig", newline="") as output:
                writer = csv.writer(output)
                writer.writerow(header)
                writer.writerows(rows)
        report = import_files(paths, self.db_path, ZoneInfo("Asia/Tokyo"))
        self.assertEqual(
            (report["imported"], report["duplicates"], report["invalid"]), (2, 1, 1)
        )
        self.assertEqual([f["imported"] for f in report["files"]], [1, 1])
        self.assertEqual(report["files"][1]["errors"][0]["line"], 3)
        self.assertEqual(report["integrity_check"], "ok")
        self.assertEqual(report["oldest"], "2026-06-01T00:30:00.123000+09:00")
        self.assertEqual(len(storage.pending(self.db_path)), 0)
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
        response = types.SimpleNamespace(raise_for_status=lambda: None)
        with patch.object(self.main.requests, "post", return_value=response) as post:
            self.main.send_pending()
        self.assertEqual(
            post.call_args.kwargs["json"]["data"][0]["created"], 1780249200000
        )
        self.assertEqual(len(storage.pending(self.db_path)), 0)


if __name__ == "__main__":
    unittest.main()
