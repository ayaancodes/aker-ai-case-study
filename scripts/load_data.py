"""
Loads all Rent Roll and Unit Availability .xlsx files into the SQLite database.

Usage:
    python3 scripts/load_data.py
    python3 scripts/load_data.py --data-dir "Aker Case Study Data" --db db/aker.db

Design notes (see CLAUDE.md "Loader best practices" and the audit section for what
changed and why):
  - Idempotent: re-running deletes and reinserts by (property_id, program_type,
    source_type, as_of_date) -- a snapshot's real identity -- not by filename alone, so
    a renamed source file replaces its old row instead of sitting alongside it as an
    orphan. A reconciliation pass at the end of each run also removes snapshots whose
    source file is no longer present at all, so a file deleted from the source folder
    doesn't leave stale data behind forever either.
  - Transactional per file: one file's writes commit together or not at all.
  - A single bad (malformed) file doesn't abort the whole run -- it's logged loudly in
    the final summary and the loader moves on, since this needs to scale past a handful
    of files. An *unexpected* error (almost certainly a bug in the loader itself, not a
    bad file) is handled separately: it doesn't get silently lumped in with normal
    data-quality failures, it's written to the loader_errors table so it can't be missed
    the way stdout-only output can be.
  - Data quality flags (empty rent roll, rent-roll/unit-availability mismatch, missing
    charges) are written during the load itself, not as a separate pass.
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

# Statuses that represent a real resident who should be getting billed. 'occupied' was
# the only one originally checked for missing charges; 'notice' (giving notice, still
# living there, still owes rent) carries real market_rent too and was found -- during
# an audit, not the original investigation -- to have the identical missing-charges
# problem in the same properties, just invisible to the check because of this filter.
# 'model' and 'down' are deliberately excluded: those are placeholder/administrative
# rows (resident_name is a generic "Resident N", not a real tenant -- see CLAUDE.md) and
# market_rent there reflects the unit's listed rent, not a bill anyone is meant to pay,
# so zero charges is the CORRECT state for them, not a gap.
CHARGE_EXPECTED_STATUSES = {"occupied", "notice"}

# A property/program with ANY occupied-or-notice tenancy missing charges gets its exact
# ratio computed and stored (see pct_value on data_quality_flags) -- never hidden. Only
# ratios above this bar get the more serious 'missing_charges' flag_type; anything below
# it still gets a 'missing_charges_partial' flag so it's visible in /anomalies instead of
# silently passing under a threshold the way the original 50%-cliff boolean check did.
MISSING_CHARGES_SEVERE_THRESHOLD = 0.5


def load_rent_roll_file(conn, filepath):
    filename = os.path.basename(filepath)
    parsed = parse_rent_roll(filepath, filename)
    property_id, program_type, raw_code = filenames.resolve(filename)

    db.get_or_create_property(conn, property_id, parsed["property_name"])
    db.delete_existing_snapshot(
        conn, property_id, program_type, "rent_roll", parsed["as_of_date"], filename,
    )
    snapshot_id = db.insert_snapshot(
        conn, property_id, program_type, "rent_roll",
        parsed["as_of_date"], parsed["month_year"], filename,
    )

    total_mismatches = 0
    for unit in parsed["units"]:
        unit_id = db.get_or_create_unit(
            conn, property_id, program_type,
            unit["unit_number"], unit["unit_type"], unit["sq_ft"],
            snapshot_id=snapshot_id,
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
    # showed ~$4k total revenue against ~$770k in summed market rent. Checking the full
    # portfolio showed this isn't a one-off: 5 of 15 properties have 100% or near-100%
    # of occupied tenancies missing charges entirely (see CLAUDE.md edge cases).
    #
    # Two gaps in this check were found by a later audit and fixed here:
    #   1. It only looked at status == 'occupied', missing the identical pattern among
    #      'notice' status tenants (same real resident, same real rent, still excluded).
    #   2. It was a boolean gated at >50%, so a property with e.g. 35% of its charges
    #      missing loaded clean with zero signal anywhere. The ratio is now always
    #      computed and stored (pct_value) whenever it's nonzero, with flag_type only
    #      distinguishing "severe" from "partial" -- never hiding the number itself.
    billable = [
        u for u in parsed["units"]
        if u["section"] == "current"
        and u["status"] in CHARGE_EXPECTED_STATUSES
        and (u["market_rent"] or 0) > 0
    ]
    missing_charges = [u for u in billable if not u["charges"]]
    if billable and missing_charges:
        ratio = len(missing_charges) / len(billable)
        pct = 100 * ratio
        flag_type = (
            "missing_charges" if ratio > MISSING_CHARGES_SEVERE_THRESHOLD
            else "missing_charges_partial"
        )
        db.add_flag(
            conn, property_id, snapshot_id, flag_type,
            f"{len(missing_charges)} of {len(billable)} occupied/notice tenancies "
            f"({pct:.1f}%) have zero recorded charges despite nonzero market rent -- "
            f"revenue for this property/program is understated",
            pct_value=ratio,
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
    db.delete_existing_snapshot(
        conn, property_id, program_type, "unit_availability", parsed["as_of_date"], filename,
    )
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

    # Known, expected-shape failures (a malformed file) vs. unexpected ones (almost
    # certainly a loader bug) are handled differently: the former is a normal, logged
    # data-quality-shaped failure; the latter gets written to loader_errors as well, so
    # it can never look identical to "this source file was just bad" after the fact.
    rr_results, rr_failures, rr_unexpected = [], [], []
    for f in rr_files:
        filename = os.path.basename(f)
        try:
            rr_results.append(load_rent_roll_file(conn, f))
        except (RentRollParseError, filenames.UnresolvableFilename) as e:
            conn.rollback()
            rr_failures.append((filename, str(e)))
        except Exception as e:
            conn.rollback()
            rr_unexpected.append((filename, repr(e)))
            db.log_loader_error(conn, filename, type(e).__name__, repr(e))
            conn.commit()

    ua_results, ua_failures, ua_unexpected = [], [], []
    for f in ua_files:
        filename = os.path.basename(f)
        try:
            ua_results.append(load_unit_availability_file(conn, f))
        except (UnitAvailabilityParseError, filenames.UnresolvableFilename) as e:
            conn.rollback()
            ua_failures.append((filename, str(e)))
        except Exception as e:
            conn.rollback()
            ua_unexpected.append((filename, repr(e)))
            db.log_loader_error(conn, filename, type(e).__name__, repr(e))
            conn.commit()

    # Reconciliation pass: remove snapshots for files that were previously loaded but
    # are no longer present in the source folder for this run. Runs after the main
    # loops so a mid-run failure can't wipe data for files that just haven't been
    # reprocessed yet in this same run.
    seen_rr = {os.path.basename(f) for f in rr_files}
    seen_ua = {os.path.basename(f) for f in ua_files}
    removed_rr = db.reconcile_missing_files(conn, "rent_roll", seen_rr)
    removed_ua = db.reconcile_missing_files(conn, "unit_availability", seen_ua)
    conn.commit()

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

    if removed_rr or removed_ua:
        print(f"\nRemoved stale snapshots for files no longer present ({len(removed_rr) + len(removed_ua)}):")
        for name in removed_rr + removed_ua:
            print(f"   {name}")

    failures = rr_failures + ua_failures
    if failures:
        print(f"\nFAILURES -- malformed source file ({len(failures)}):")
        for name, err in failures:
            print(f"   {name}: {err}")

    unexpected = rr_unexpected + ua_unexpected
    if unexpected:
        print(f"\nUNEXPECTED ERRORS -- likely a loader bug, not a bad file ({len(unexpected)}):")
        print(f"   (also written to the loader_errors table, see /anomalies or query it directly)")
        for name, err in unexpected:
            print(f"   {name}: {err}")

    conn.close()
    return 1 if (failures or unexpected) else 0


if __name__ == "__main__":
    sys.exit(main())
