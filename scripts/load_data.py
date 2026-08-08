"""
Loads all Rent Roll and Unit Availability .xlsx files into the SQLite database.

Usage:
    python3 scripts/load_data.py
    python3 scripts/load_data.py --data-dir "Aker Case Study Data" --db db/aker.db

Design notes (see CLAUDE.md "Loader best practices"):
  - Idempotent: re-running deletes and reinserts by source_filename, doesn't double rows.
  - Transactional per file: one file's writes commit together or not at all.
  - A single bad file doesn't abort the whole run -- it's logged loudly in the final
    summary and the loader moves on, since this needs to scale past a handful of files.
  - Data quality flags (empty rent roll, rent-roll/unit-availability mismatch) are
    written during the load itself, not as a separate pass.
  - Charge-line-sum-vs-stated-Total is re-validated live as a safety net, even though
    it was already confirmed clean across all 4,106 known unit records during
    investigation.
"""

import argparse
import glob
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))

from etl import db, filenames
from etl.rent_roll_parser import parse_rent_roll, RentRollParseError
from etl.unit_availability_parser import parse_unit_availability, UnitAvailabilityParseError

TOTAL_MISMATCH_TOLERANCE = 0.01
UNIT_COUNT_MISMATCH_TOLERANCE = 0  # exact match expected; see CLAUDE.md 153c finding


def load_rent_roll_file(conn, filepath):
    filename = os.path.basename(filepath)
    parsed = parse_rent_roll(filepath, filename)
    property_id, program_type, raw_code = filenames.resolve(filename)

    db.get_or_create_property(conn, property_id, parsed["property_name"])
    db.delete_existing_snapshot(conn, filename)
    snapshot_id = db.insert_snapshot(
        conn, property_id, program_type, "rent_roll",
        parsed["as_of_date"], parsed["month_year"], filename,
    )

    total_mismatches = 0
    for unit in parsed["units"]:
        unit_id = db.get_or_create_unit(
            conn, property_id, program_type,
            unit["unit_number"], unit["unit_type"], unit["sq_ft"],
        )
        tenancy_id = db.insert_tenancy(conn, snapshot_id, unit_id, unit)
        if unit["charges"]:
            db.insert_charges(conn, tenancy_id, unit["charges"])

        stated = unit["stated_total"]
        if stated is not None:
            actual = sum(c["amount"] for c in unit["charges"])
            if abs(actual - stated) > TOTAL_MISMATCH_TOLERANCE:
                total_mismatches += 1
                db.add_flag(
                    conn, property_id, snapshot_id, "charge_total_mismatch",
                    f"unit {unit['unit_number']}: charges sum to {actual}, "
                    f"file states Total {stated}",
                )

    if len(parsed["units"]) == 0:
        db.add_flag(
            conn, property_id, snapshot_id, "empty_rent_roll",
            f"{filename} contains zero unit rows",
        )

    # A unit with market_rent > 0 and Total = 0 doesn't trip the mismatch check above
    # (0 charges legitimately sums to a stated Total of 0), but it's still a real data
    # problem: a resident paying real rent with no recorded charge lines at all. Found
    # by comparing revenue across properties on the dashboard -- Kinwood Apartments
    # showed ~$4k total revenue against $823k in summed market rent. Checking the full
    # portfolio showed this isn't a one-off: 5 of 15 properties have 100% or near-100%
    # of occupied tenancies missing charges entirely (see CLAUDE.md edge cases).
    occupied_with_rent = [
        u for u in parsed["units"]
        if u["section"] == "current" and u["status"] == "occupied" and (u["market_rent"] or 0) > 0
    ]
    missing_charges = [u for u in occupied_with_rent if not u["charges"]]
    if occupied_with_rent and len(missing_charges) / len(occupied_with_rent) > 0.5:
        pct = 100 * len(missing_charges) / len(occupied_with_rent)
        db.add_flag(
            conn, property_id, snapshot_id, "missing_charges",
            f"{len(missing_charges)} of {len(occupied_with_rent)} occupied tenancies "
            f"({pct:.0f}%) have zero recorded charges despite nonzero market rent -- "
            f"revenue for this property/program is understated",
        )

    conn.commit()
    return {
        "filename": filename,
        "property_id": property_id,
        "program_type": program_type,
        "units": len(parsed["units"]),
        "total_mismatches": total_mismatches,
    }


def load_unit_availability_file(conn, filepath):
    filename = os.path.basename(filepath)
    parsed = parse_unit_availability(filepath, filename)
    property_id, program_type, raw_code = filenames.resolve(filename)

    db.get_or_create_property(conn, property_id, parsed["property_name"])
    db.delete_existing_snapshot(conn, filename)
    snapshot_id = db.insert_snapshot(
        conn, property_id, program_type, "unit_availability",
        parsed["as_of_date"], None, filename,
    )
    db.insert_ua_snapshot(conn, snapshot_id, property_id, parsed)

    mismatch = None
    rr_snapshot_id = db.latest_rent_roll_snapshot(conn, property_id, program_type)
    if rr_snapshot_id is not None and parsed["total_units"] is not None:
        actual_units = db.count_current_tenancies(conn, rr_snapshot_id)
        stated_units = parsed["total_units"]
        if abs(actual_units - stated_units) > UNIT_COUNT_MISMATCH_TOLERANCE:
            mismatch = (actual_units, stated_units)
            db.add_flag(
                conn, property_id, snapshot_id, "unit_availability_mismatch",
                f"{filename} states total_units={stated_units}, but the matching "
                f"rent roll has {actual_units} current-section unit rows",
            )

    conn.commit()
    return {
        "filename": filename,
        "property_id": property_id,
        "program_type": program_type,
        "total_units": parsed["total_units"],
        "mismatch": mismatch,
    }


def main():
    parser = argparse.ArgumentParser(description="Load Aker rent roll / unit availability Excel data into SQLite")
    parser.add_argument("--data-dir", default="Aker Case Study Data")
    parser.add_argument("--db", default="db/aker.db")
    args = parser.parse_args()

    rent_roll_dir = os.path.join(args.data_dir, "Rent_Roll_with_Lease_Charges")
    unit_avail_dir = os.path.join(args.data_dir, "Unit_Availability")

    conn = db.connect(args.db)
    db.init_db(conn)

    started = time.time()
    rr_files = sorted(glob.glob(os.path.join(rent_roll_dir, "*.xlsx")))
    ua_files = sorted(glob.glob(os.path.join(unit_avail_dir, "*.xlsx")))

    print(f"Found {len(rr_files)} rent roll files, {len(ua_files)} unit availability files")

    rr_results, rr_failures = [], []
    for f in rr_files:
        try:
            rr_results.append(load_rent_roll_file(conn, f))
        except (RentRollParseError, Exception) as e:
            conn.rollback()
            rr_failures.append((os.path.basename(f), str(e)))

    ua_results, ua_failures = [], []
    for f in ua_files:
        try:
            ua_results.append(load_unit_availability_file(conn, f))
        except (UnitAvailabilityParseError, Exception) as e:
            conn.rollback()
            ua_failures.append((os.path.basename(f), str(e)))

    elapsed = time.time() - started

    total_units = sum(r["units"] for r in rr_results)
    empty_properties = [r for r in rr_results if r["units"] == 0]
    ua_mismatches = [r for r in ua_results if r["mismatch"]]

    cur = conn.execute("SELECT COUNT(*) FROM properties")
    n_properties = cur.fetchone()[0]
    cur = conn.execute("SELECT COUNT(*) FROM tenancies")
    n_tenancies = cur.fetchone()[0]
    cur = conn.execute("SELECT COUNT(*) FROM charges")
    n_charges = cur.fetchone()[0]
    cur = conn.execute("SELECT COUNT(*) FROM data_quality_flags")
    n_flags = cur.fetchone()[0]

    print()
    print(f"--- Load complete in {elapsed:.1f}s ---")
    print(f"Rent roll files loaded: {len(rr_results)}/{len(rr_files)}  ({total_units} unit rows)")
    print(f"Unit availability files loaded: {len(ua_results)}/{len(ua_files)}")
    print(f"Properties: {n_properties}  Tenancies: {n_tenancies}  Charges: {n_charges}  Flags: {n_flags}")

    if empty_properties:
        print(f"\nEmpty rent roll files ({len(empty_properties)}):")
        for r in empty_properties:
            print(f"   {r['filename']}")

    if ua_mismatches:
        print(f"\nUnit availability mismatches ({len(ua_mismatches)}):")
        for r in ua_mismatches:
            actual, stated = r["mismatch"]
            print(f"   {r['filename']}: file says {stated}, rent roll has {actual}")

    if rr_failures or ua_failures:
        print(f"\nFAILURES ({len(rr_failures) + len(ua_failures)}):")
        for name, err in rr_failures + ua_failures:
            print(f"   {name}: {err}")

    conn.close()
    return 1 if (rr_failures or ua_failures) else 0


if __name__ == "__main__":
    sys.exit(main())
