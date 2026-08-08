"""
Unit tests for the idempotency/identity logic in scripts/etl/db.py.

These operate directly on db.py functions against a fresh, isolated SQLite database
(the tmp_conn fixture) -- no real Excel files needed, since the thing under test is
purely "does a snapshot's identity get resolved and replaced correctly," which is a
database-logic question, not a parsing question. Covers three bugs found and fixed
during an audit of the original loader:

  1. delete_existing_snapshot matched by filename only, so a renamed source file left
     an orphaned duplicate snapshot behind instead of replacing it.
  2. Nothing ever removed a snapshot for a file that was deleted from the source folder.
  3. latest_rent_roll_snapshot picked "latest" by load order (loaded_at), not by
     reporting period (as_of_date) -- fine with one snapshot per property/program, wrong
     the moment two snapshots for the same property/program exist out of chronological
     load order.
"""

from etl import db


def test_rename_replaces_old_snapshot_not_orphans_it(tmp_conn):
    """Same property/program/source_type/as_of_date under a new filename must replace
    the old snapshot, not sit alongside it -- an orphan here is exactly what would let
    the revenue views double-count a property (both snapshots share the same as_of_date,
    so both would match v_latest_rent_roll_snapshot's join condition)."""
    db.get_or_create_property(tmp_conn, "999", "Test Property")

    db.delete_existing_snapshot(tmp_conn, "999", "residential", "rent_roll", "2026-02-25", "original_name.xlsx")
    snap1 = db.insert_snapshot(tmp_conn, "999", "residential", "rent_roll", "2026-02-25", "02/2026", "original_name.xlsx")
    tmp_conn.commit()

    # "Rename": same property/program/type/date, different filename.
    db.delete_existing_snapshot(tmp_conn, "999", "residential", "rent_roll", "2026-02-25", "renamed_name.xlsx")
    snap2 = db.insert_snapshot(tmp_conn, "999", "residential", "rent_roll", "2026-02-25", "02/2026", "renamed_name.xlsx")
    tmp_conn.commit()

    rows = tmp_conn.execute(
        "SELECT snapshot_id, source_filename FROM data_snapshots WHERE property_id = '999'"
    ).fetchall()
    assert len(rows) == 1, f"expected the rename to replace the old snapshot, got {rows}"
    assert rows[0][0] == snap2
    assert rows[0][1] == "renamed_name.xlsx"
    assert snap1 != snap2


def test_rename_falls_back_to_filename_match_when_as_of_date_missing(tmp_conn):
    """When as_of_date couldn't be parsed (None), identity-by-date isn't usable, so this
    must fall back to matching by filename -- not silently match nothing (which would
    accumulate duplicate snapshots forever) and not over-match by property alone (which
    could delete an unrelated snapshot)."""
    db.get_or_create_property(tmp_conn, "999", "Test Property")
    db.delete_existing_snapshot(tmp_conn, "999", "residential", "rent_roll", None, "broken_date.xlsx")
    db.insert_snapshot(tmp_conn, "999", "residential", "rent_roll", None, None, "broken_date.xlsx")
    tmp_conn.commit()

    # Re-running on the exact same (still-broken) file should replace, not duplicate.
    db.delete_existing_snapshot(tmp_conn, "999", "residential", "rent_roll", None, "broken_date.xlsx")
    db.insert_snapshot(tmp_conn, "999", "residential", "rent_roll", None, None, "broken_date.xlsx")
    tmp_conn.commit()

    rows = tmp_conn.execute(
        "SELECT source_filename FROM data_snapshots WHERE property_id = '999'"
    ).fetchall()
    assert len(rows) == 1


def test_reconcile_removes_snapshot_for_file_no_longer_present(tmp_conn):
    """A file that's simply deleted from the source folder (not renamed, not reloaded)
    is never reprocessed, so delete_existing_snapshot never fires for it -- only an
    explicit reconciliation pass can catch this."""
    db.get_or_create_property(tmp_conn, "111", "Property A")
    db.get_or_create_property(tmp_conn, "222", "Property B")
    db.insert_snapshot(tmp_conn, "111", "residential", "rent_roll", "2026-02-25", "02/2026", "a.xlsx")
    db.insert_snapshot(tmp_conn, "222", "residential", "rent_roll", "2026-02-25", "02/2026", "b.xlsx")
    tmp_conn.commit()

    # This run only saw a.xlsx -- b.xlsx was removed from the source folder.
    removed = db.reconcile_missing_files(tmp_conn, "rent_roll", {"a.xlsx"})
    tmp_conn.commit()

    assert removed == ["b.xlsx"]
    remaining = tmp_conn.execute("SELECT source_filename FROM data_snapshots").fetchall()
    assert [r[0] for r in remaining] == ["a.xlsx"]


def test_reconcile_only_touches_the_given_source_type(tmp_conn):
    """Reconciling rent_roll files must not delete unit_availability snapshots for the
    same filename set, and vice versa -- they're independent source folders."""
    db.get_or_create_property(tmp_conn, "111", "Property A")
    db.insert_snapshot(tmp_conn, "111", "residential", "rent_roll", "2026-02-25", "02/2026", "a.xlsx")
    db.insert_snapshot(tmp_conn, "111", "residential", "unit_availability", "2026-02-25", None, "a.xlsx")
    tmp_conn.commit()

    db.reconcile_missing_files(tmp_conn, "rent_roll", set())  # a.xlsx "missing" for rent_roll only
    tmp_conn.commit()

    remaining = tmp_conn.execute(
        "SELECT source_type FROM data_snapshots"
    ).fetchall()
    assert [r[0] for r in remaining] == ["unit_availability"]


def test_latest_snapshot_uses_as_of_date_not_load_order(tmp_conn):
    """Load an OLDER month's snapshot AFTER a NEWER one already exists (e.g. a backfill)
    -- latest_rent_roll_snapshot must still resolve to the newer as_of_date, matching
    what the SQL views (v_latest_rent_roll_snapshot, MAX(as_of_date)) would pick. Before
    the fix this ordered by loaded_at DESC, which would have wrongly returned the
    backfilled older snapshot here since it was inserted last."""
    db.get_or_create_property(tmp_conn, "333", "Property C")
    newer = db.insert_snapshot(tmp_conn, "333", "residential", "rent_roll", "2026-03-25", "03/2026", "march.xlsx")
    tmp_conn.commit()
    # Backfilled afterwards -- loaded_at is later, but as_of_date is earlier.
    older = db.insert_snapshot(tmp_conn, "333", "residential", "rent_roll", "2026-01-25", "01/2026", "january.xlsx")
    tmp_conn.commit()

    result = db.latest_rent_roll_snapshot(tmp_conn, "333", "residential")
    assert result == newer, "latest_rent_roll_snapshot picked the backfilled OLDER snapshot instead of the newer one"
    assert result != older
