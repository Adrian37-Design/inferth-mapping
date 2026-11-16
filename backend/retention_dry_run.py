"""
Retention dry-run CLI — read-only.

Usage (from the backend/ directory, with DATABASE_URL set):

    python retention_dry_run.py                 # all tenants, human table
    python retention_dry_run.py --tenant 7      # one tenant
    python retention_dry_run.py --json          # machine-readable
    python retention_dry_run.py --csv out.csv   # spreadsheet

This script only issues SELECT statements. It never deletes or updates rows.
"""

import argparse
import asyncio
import csv
import json
import os
import sys

from app.db import AsyncSessionLocal
from app.services.retention import dry_run_report


def _fmt(value) -> str:
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if hasattr(value, "isoformat"):
        return value.isoformat(timespec="minutes")
    return str(value)


def print_table(report: dict) -> None:
    s = report["summary"]
    print("")
    print("INFERTH GPS RETENTION — DRY RUN (no data will be changed)")
    print(f"Generated: {report['generated_at']}")
    print(
        f"positions rows: {report['positions_total_rows']:,}   "
        f"table size: {report['positions_table_size']}   "
        f"keep latest/device: {report['keep_latest_per_device']}"
    )
    print(
        f"unowned positions (exempt): {report['unowned_positions_rows']:,} "
        f"across {report['unowned_devices']} devices"
    )
    print(
        f"eligible tenants: {s['eligible_tenants']}/{s['tenants_reported']}   "
        f"expired rows: {s['expired_rows']:,}   "
        f"would delete: {s['would_delete_rows']:,}"
    )
    print("")
    header = (
        f"{'ID':>4}  {'Tenant':<26} {'Tier':<13} {'Days':>4}  "
        f"{'Rows':>9} {'Expired':>9} {'Keep':>6} {'Delete':>9}  {'Eligible':<8} Reason"
    )
    print(header)
    print("-" * len(header))
    for t in report["tenants"]:
        print(
            f"{t['tenant_id']:>4}  {t['tenant_name'][:26]:<26} {t['tier']:<13} "
            f"{_fmt(t['retention_days']):>4}  {t.get('total_rows', 0):>9,} "
            f"{t.get('expired_rows', 0):>9,} {t.get('protected_last_fixes', 0):>6,} "
            f"{t.get('would_delete_rows', 0):>9,}  {_fmt(t['eligible']):<8} {t['reason']}"
        )
    print("")


def write_csv(report: dict, path: str) -> None:
    fields = [
        "tenant_id", "tenant_name", "tier", "retention_days", "eligible", "reason",
        "plan", "billing_cycle", "devices", "total_rows", "expired_rows",
        "protected_last_fixes", "would_delete_rows", "oldest_timestamp", "newest_timestamp",
    ]
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in report["tenants"]:
            writer.writerow({k: _fmt(row.get(k)) for k in fields})
    print(f"CSV written to {path}")


async def main() -> int:
    parser = argparse.ArgumentParser(description="Inferth retention dry run (read-only)")
    parser.add_argument("--tenant", type=int, default=None, help="limit to one tenant id")
    parser.add_argument("--json", action="store_true", help="print JSON instead of a table")
    parser.add_argument("--csv", metavar="PATH", default=None, help="write per-tenant CSV")
    args = parser.parse_args()

    if not os.getenv("DATABASE_URL"):
        print("DATABASE_URL is not set. Run this inside the backend environment.", file=sys.stderr)
        return 2

    async with AsyncSessionLocal() as db:
        report = await dry_run_report(db, tenant_id=args.tenant)

    if args.json:
        print(json.dumps(report, indent=2, default=str))
    else:
        print_table(report)
    if args.csv:
        write_csv(report, args.csv)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
