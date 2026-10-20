"""Import Ambient CSV exports into a new SQLite database."""

import argparse
import csv
import json
import os
import sqlite3
import tempfile
from datetime import datetime, timezone as utc_timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from src import storage

REQUIRED_COLUMNS = ("created", "気温 (℃)", "湿度 (%)")


def import_files(paths, output, timezone):
    output = Path(output)
    if output.exists():
        raise FileExistsError(f"output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".db", dir=output.parent
    )
    os.close(fd)
    temporary = Path(temporary_name)
    report = {
        "timezone": str(timezone),
        "files": [],
        "imported": 0,
        "duplicates": 0,
        "invalid": 0,
        "oldest_ms": None,
        "newest_ms": None,
    }
    try:
        storage.initialize(temporary)
        with storage.connect(temporary) as db:
            for path in paths:
                file_report = {
                    "file": str(path),
                    "rows": 0,
                    "imported": 0,
                    "duplicates": 0,
                    "invalid": 0,
                    "errors": [],
                }
                with Path(path).open("r", encoding="utf-8-sig", newline="") as source:
                    reader = csv.DictReader(source)
                    if reader.fieldnames is None or any(
                        name not in reader.fieldnames for name in REQUIRED_COLUMNS
                    ):
                        raise ValueError(f"missing required CSV headers: {path}")
                    for row in reader:
                        line_number = reader.line_num
                        file_report["rows"] += 1
                        try:
                            if None in row:
                                raise ValueError("unexpected extra columns")
                            date_text, separator, millisecond_text = (
                                row["created"].strip().rpartition(".")
                            )
                            if not separator or not (
                                1 <= len(millisecond_text) <= 3
                                and millisecond_text.isascii()
                                and millisecond_text.isdigit()
                            ):
                                raise ValueError(
                                    "created must end in 1-3 millisecond digits"
                                )
                            stamp = datetime.strptime(date_text, "%Y/%m/%d %H:%M:%S")
                            elapsed = stamp.replace(tzinfo=timezone) - datetime(
                                1970, 1, 1, tzinfo=utc_timezone.utc
                            )
                            measured_at_ms = (
                                elapsed.days * 86400000
                                + elapsed.seconds * 1000
                                + int(millisecond_text)
                            )
                            temperature = float(row["気温 (℃)"].strip())
                            humidity = float(row["湿度 (%)"].strip())
                            storage.validate_values(temperature, humidity)
                            cursor = db.execute(
                                "INSERT OR IGNORE INTO readings "
                                "(measured_at_ms, temperature, humidity, ambient_sent_at_ms) "
                                "VALUES (?, ?, ?, ?)",
                                (measured_at_ms, temperature, humidity, measured_at_ms),
                            )
                            if cursor.rowcount:
                                file_report["imported"] += 1
                                report["oldest_ms"] = (
                                    min(report["oldest_ms"], measured_at_ms)
                                    if report["oldest_ms"] is not None
                                    else measured_at_ms
                                )
                                report["newest_ms"] = (
                                    max(report["newest_ms"], measured_at_ms)
                                    if report["newest_ms"] is not None
                                    else measured_at_ms
                                )
                            else:
                                file_report["duplicates"] += 1
                        except (TypeError, ValueError, OverflowError) as error:
                            file_report["invalid"] += 1
                            file_report["errors"].append(
                                {"line": line_number, "reason": str(error), "row": row}
                            )
                report["files"].append(file_report)
                for key in ("imported", "duplicates", "invalid"):
                    report[key] += file_report[key]
        storage.rebuild_daily_stats(temporary)
        storage.rebuild_hourly_stats(temporary)
        with storage.connect(temporary) as db:
            report["integrity_check"] = db.execute("PRAGMA integrity_check").fetchone()[
                0
            ]
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        if report["integrity_check"] != "ok":
            raise sqlite3.DatabaseError(f"integrity_check: {report['integrity_check']}")
        report["oldest"] = (
            datetime.fromtimestamp(report["oldest_ms"] / 1000, timezone).isoformat()
            if report["oldest_ms"] is not None
            else None
        )
        report["newest"] = (
            datetime.fromtimestamp(report["newest_ms"] / 1000, timezone).isoformat()
            if report["newest_ms"] is not None
            else None
        )
        os.link(temporary, output)  # Atomic creation: never replace an existing DB.
        return report
    finally:
        temporary.unlink(missing_ok=True)
        temporary.with_name(temporary.name + "-wal").unlink(missing_ok=True)
        temporary.with_name(temporary.name + "-shm").unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_files", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--timezone",
        required=True,
        help="IANA timezone of CSV created values, e.g. Asia/Tokyo",
    )
    args = parser.parse_args()
    try:
        timezone = ZoneInfo(args.timezone)
    except ZoneInfoNotFoundError as error:
        parser.error(str(error))
    report = import_files(args.csv_files, args.output, timezone)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
