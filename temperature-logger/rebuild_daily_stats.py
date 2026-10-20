"""Rebuild or verify the daily statistics derived from readings."""

import argparse
import json
import tomllib
from pathlib import Path

from src import storage

ROOT_DIR = Path(__file__).resolve().parent


def main():
    with (ROOT_DIR / "config.toml").open("rb") as source:
        config = tomllib.load(source)
    default_db = ROOT_DIR / config.get("storage", {}).get("path", "data/readings.db")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=default_db)
    parser.add_argument(
        "--check", action="store_true", help="verify without rebuilding"
    )
    args = parser.parse_args()
    if not args.db.is_file():
        parser.error(f"database does not exist: {args.db}")

    if not args.check:
        storage.rebuild_daily_stats(args.db)
    report = storage.validate_daily_stats(args.db)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
