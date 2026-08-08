"""
All SQLite writes live here, separated from parsing (rent_roll_parser.py /
unit_availability_parser.py) so parsing logic can be tested without touching a
database at all, and so the write/idempotency logic isn't tangled up with the
Excel-specific parsing quirks.
"""

import sqlite3
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent.parent.parent / "db" / "schema.sql"
SEED_PATH = Path(__file__).resolve().parent.parent.parent / "db" / "seed_charge_codes.sql"


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn):
    """Idempotent: only creates tables/seed data if they don't already exist."""
    cur = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='properties'"
    )
    already_initialized = cur.fetchone()[0] > 0
    if already_initialized:
        return
    with open(SCHEMA_PATH) as f:
        conn.executescript(f.read())
    with open(SEED_PATH) as f:
        conn.executescript(f.read())
    conn.commit()


def get_or_create_property(conn, property_id, name):
    """
    First file seen for a property_id sets canonical_name. Later files with a
    different name get recorded as an alias instead of overwriting the canonical
    name, since which one is "correct" isn't knowable from the data alone
    (e.g. Riverwalk Place spelled two ways across its own files).
    """
    cur = conn.execute(
        "SELECT canonical_name FROM properties WHERE property_id = ?", (property_id,)
    )
    row = cur.fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO properties (property_id, canonical_name) VALUES (?, ?)",
            (property_id, name),
        )
        return
    canonical_name = row[0]
    if name != canonical_name:
        conn.execute(
            "INSERT OR IGNORE INTO property_name_aliases (property_id, alias_name) "
            "VALUES (?, ?)",
            (property_id, name),
        )


def delete_existing_snapshot(conn, property_id, program_type, source_type, as_of_date, source_filename):
    """Makes re-running the loader idempotent: wipe the old snapshot (and everything
    that cascades from it) before reinserting the new one.

    A snapshot's true identity is (property_id, program_type, source_type, as_of_date)
    -- the same property's data for the same program and period, not the filename it
    happened to arrive under. Matching by filename alone (the original approach) meant
    a renamed source file (e.g. a typo fix upstream) would leave the old row behind as
    an orphan with the same as_of_date as the new one, and the revenue views (which
    group by as_of_date, not filename) would then silently sum both together -- the
    exact double-counting bug already found and fixed once for a different reason.
    Matching by identity means a rename correctly replaces the old row.

    Falls back to matching by source_filename alone when as_of_date couldn't be parsed
    (None) from the file -- identity-by-date isn't usable in that case, so this keeps
    the original filename-based behavior rather than deleting nothing or over-deleting."""
    if as_of_date is not None:
        conn.execute(
            """DELETE FROM data_snapshots
               WHERE property_id = ? AND program_type = ? AND source_type = ? AND as_of_date = ?""",
            (property_id, program_type, source_type, as_of_date),
        )
    else:
        conn.execute(
            "DELETE FROM data_snapshots WHERE source_filename = ? AND source_type = ?",
            (source_filename, source_type),
        )


def reconcile_missing_files(conn, source_type, current_filenames):
    """Deletes any snapshot (and everything cascading from it) whose source_filename is
    no longer present in this run's source folder for source_type. Handles a file being
    removed from the source data entirely -- delete_existing_snapshot alone can't catch
    this, since it only fires when a file with a matching identity is being reprocessed;
    a removed file is never reprocessed at all, so without this its old snapshot would
    sit in the database forever. Returns the list of removed filenames for reporting."""
    cur = conn.execute(
        "SELECT snapshot_id, source_filename FROM data_snapshots WHERE source_type = ?",
        (source_type,),
    )
    stale = [(sid, fname) for sid, fname in cur.fetchall() if fname not in current_filenames]
    for sid, _ in stale:
        conn.execute("DELETE FROM data_snapshots WHERE snapshot_id = ?", (sid,))
    return [fname for _, fname in stale]


def insert_snapshot(conn, property_id, program_type, source_type, as_of_date, month_year, source_filename):
    cur = conn.execute(
        """INSERT INTO data_snapshots
           (property_id, program_type, source_type, as_of_date, month_year, source_filename)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (property_id, program_type, source_type, as_of_date, month_year, source_filename),
    )
    return cur.lastrowid


def get_or_create_unit(conn, property_id, program_type, unit_number, unit_type, sq_ft, snapshot_id=None):
    """Units are a dimension table shared across snapshots (a unit persists even as its
    tenancy changes month to month), so this stays get-or-create rather than
    insert-per-snapshot. But the original version was first-write-wins forever: once a
    unit existed, a later file with a corrected sq_ft or unit_type was silently ignored,
    with no record that a correction had even been offered. This now updates the
    dimension fields to the latest file's values (last-write-wins, the standard approach
    for a slowly-changing dimension) and flags it when a real change happens, so a
    correction is both applied and auditable instead of one or the other."""
    conn.execute(
        """INSERT OR IGNORE INTO units (property_id, program_type, unit_number, unit_type, sq_ft)
           VALUES (?, ?, ?, ?, ?)""",
        (property_id, program_type, unit_number, unit_type, sq_ft),
    )
    cur = conn.execute(
        """SELECT unit_id, unit_type, sq_ft FROM units
           WHERE property_id = ? AND program_type = ? AND unit_number = ?""",
        (property_id, program_type, unit_number),
    )
    unit_id, existing_type, existing_sq_ft = cur.fetchone()

    changed = (existing_type != unit_type) or (existing_sq_ft != sq_ft)
    if changed:
        conn.execute(
            "UPDATE units SET unit_type = ?, sq_ft = ? WHERE unit_id = ?",
            (unit_type, sq_ft, unit_id),
        )
        add_flag(
            conn, property_id, snapshot_id, "unit_dimension_changed",
            f"unit {unit_number} ({program_type}): unit_type {existing_type!r}->{unit_type!r}, "
            f"sq_ft {existing_sq_ft!r}->{sq_ft!r}",
        )
    return unit_id


def insert_tenancy(conn, snapshot_id, unit_id, unit_data):
    cur = conn.execute(
        """INSERT INTO tenancies
           (snapshot_id, unit_id, section, status, resident_code, resident_name,
            market_rent, resident_deposit, other_deposit, move_in, lease_expiration,
            move_out, balance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            snapshot_id,
            unit_id,
            unit_data["section"],
            unit_data["status"],
            unit_data["resident_code"],
            unit_data["resident_name"],
            unit_data["market_rent"],
            unit_data["resident_deposit"],
            unit_data["other_deposit"],
            unit_data["move_in"],
            unit_data["lease_expiration"],
            unit_data["move_out"],
            unit_data["balance"],
        ),
    )
    return cur.lastrowid


def insert_charges(conn, tenancy_id, charges):
    conn.executemany(
        "INSERT INTO charges (tenancy_id, charge_code, amount) VALUES (?, ?, ?)",
        [(tenancy_id, c["charge_code"], c["amount"]) for c in charges],
    )


def insert_ua_snapshot(conn, snapshot_id, property_id, ua_data):
    conn.execute(
        """INSERT INTO unit_availability_snapshots
           (snapshot_id, property_id, avg_sq_ft, avg_rent, total_units,
            occupied_no_notice, vacant_rented, vacant_unrented, notice_rented,
            notice_unrented, available, model, down, admin, pct_occ,
            pct_occ_w_nonrev, pct_leased, pct_trend)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            snapshot_id,
            property_id,
            ua_data["avg_sq_ft"],
            ua_data["avg_rent"],
            ua_data["total_units"],
            ua_data["occupied_no_notice"],
            ua_data["vacant_rented"],
            ua_data["vacant_unrented"],
            ua_data["notice_rented"],
            ua_data["notice_unrented"],
            ua_data["available"],
            ua_data["model"],
            ua_data["down"],
            ua_data["admin"],
            ua_data["pct_occ"],
            ua_data["pct_occ_w_nonrev"],
            ua_data["pct_leased"],
            ua_data["pct_trend"],
        ),
    )


def add_flag(conn, property_id, snapshot_id, flag_type, detail, pct_value=None):
    conn.execute(
        """INSERT INTO data_quality_flags (property_id, snapshot_id, flag_type, detail, pct_value)
           VALUES (?, ?, ?, ?, ?)""",
        (property_id, snapshot_id, flag_type, detail, pct_value),
    )


def log_loader_error(conn, source_filename, error_type, error_detail):
    """Records an unexpected (non-parse) exception hit while loading a file. Kept
    separate from data_quality_flags on purpose: this table is for bugs in the loader
    itself, flags are for problems in the source data -- conflating the two would make
    it impossible to tell, after the fact, whether a given file's failure means 'the
    source data is bad' or 'the loader has a bug and this file's data may be missing or
    wrong for reasons that have nothing to do with the source file.'"""
    conn.execute(
        """INSERT INTO loader_errors (source_filename, error_type, error_detail)
           VALUES (?, ?, ?)""",
        (source_filename, error_type, error_detail),
    )


def latest_rent_roll_snapshot(conn, property_id, program_type):
    """'Latest' means latest reporting period (as_of_date), the same definition the SQL
    views (v_latest_rent_roll_snapshot) use -- not latest to be loaded into the database
    (loaded_at). The two only agree by coincidence today, when every property has at
    most one rent-roll snapshot ever loaded. The moment a second month is loaded out of
    chronological order (e.g. backfilling an older month after the current one is
    already in), ordering by loaded_at would pick the wrong snapshot to cross-check
    Unit Availability against, silently producing a wrong (or missed)
    unit_availability_mismatch flag. loaded_at is kept as a tiebreaker only, for the
    case for two snapshots sharing an as_of_date (shouldn't happen given the identity-
    based delete in delete_existing_snapshot, but costs nothing to be defensive here)."""
    cur = conn.execute(
        """SELECT snapshot_id FROM data_snapshots
           WHERE property_id = ? AND program_type = ? AND source_type = 'rent_roll'
           ORDER BY as_of_date DESC, loaded_at DESC LIMIT 1""",
        (property_id, program_type),
    )
    row = cur.fetchone()
    return row[0] if row else None


def count_current_tenancies(conn, snapshot_id):
    cur = conn.execute(
        "SELECT COUNT(*) FROM tenancies WHERE snapshot_id = ? AND section = 'current'",
        (snapshot_id,),
    )
    return cur.fetchone()[0]
