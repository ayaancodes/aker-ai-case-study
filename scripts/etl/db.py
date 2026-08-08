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


def delete_existing_snapshot(conn, source_filename):
    """Makes re-running the loader on the same file idempotent: wipe the old
    snapshot (and everything that cascades from it) before reinserting."""
    conn.execute(
        "DELETE FROM data_snapshots WHERE source_filename = ?", (source_filename,)
    )


def insert_snapshot(conn, property_id, program_type, source_type, as_of_date, month_year, source_filename):
    cur = conn.execute(
        """INSERT INTO data_snapshots
           (property_id, program_type, source_type, as_of_date, month_year, source_filename)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (property_id, program_type, source_type, as_of_date, month_year, source_filename),
    )
    return cur.lastrowid


def get_or_create_unit(conn, property_id, program_type, unit_number, unit_type, sq_ft):
    conn.execute(
        """INSERT OR IGNORE INTO units (property_id, program_type, unit_number, unit_type, sq_ft)
           VALUES (?, ?, ?, ?, ?)""",
        (property_id, program_type, unit_number, unit_type, sq_ft),
    )
    cur = conn.execute(
        """SELECT unit_id FROM units
           WHERE property_id = ? AND program_type = ? AND unit_number = ?""",
        (property_id, program_type, unit_number),
    )
    return cur.fetchone()[0]


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


def add_flag(conn, property_id, snapshot_id, flag_type, detail):
    conn.execute(
        """INSERT INTO data_quality_flags (property_id, snapshot_id, flag_type, detail)
           VALUES (?, ?, ?, ?)""",
        (property_id, snapshot_id, flag_type, detail),
    )


def latest_rent_roll_snapshot(conn, property_id, program_type):
    cur = conn.execute(
        """SELECT snapshot_id FROM data_snapshots
           WHERE property_id = ? AND program_type = ? AND source_type = 'rent_roll'
           ORDER BY loaded_at DESC LIMIT 1""",
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
