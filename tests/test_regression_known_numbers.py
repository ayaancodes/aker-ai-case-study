"""
Regression tests against the real, loaded db/aker.db (built by `python3
scripts/load_data.py` from the actual 25+25 source files).

These lock in the numbers that were independently re-verified during the August 2026
audit (see CLAUDE.md), so a future change to a parser, the schema, or the loader's
validation logic that silently breaks one of these fails a test run instead of waiting
for someone to notice a wrong number on a dashboard -- which is exactly how the
missing_charges gap slipped through in the first place.

If a source file changes (e.g. a new month is loaded) these numbers are expected to
change too and the assertions should be updated deliberately, not just to make tests
pass.
"""


def test_property_count(real_conn):
    n = real_conn.execute("SELECT COUNT(*) FROM properties").fetchone()[0]
    assert n == 15, "25 source files map to 15 unique properties (a/c/r/land program suffixes, not separate properties)"


def test_tenancy_count(real_conn):
    n = real_conn.execute("SELECT COUNT(*) FROM tenancies").fetchone()[0]
    assert n == 4106


def test_charge_count(real_conn):
    n = real_conn.execute("SELECT COUNT(*) FROM charges").fetchone()[0]
    assert n == 9177


def test_charge_code_count(real_conn):
    n = real_conn.execute("SELECT COUNT(*) FROM charge_codes").fetchone()[0]
    assert n == 32, "32 real charge codes confirmed by full-portfolio scan, not 33 (see CLAUDE.md correction)"


def test_zero_charge_total_mismatches(real_conn):
    n = real_conn.execute(
        "SELECT COUNT(*) FROM data_quality_flags WHERE flag_type = 'charge_total_mismatch'"
    ).fetchone()[0]
    assert n == 0, "charge-line-sum-vs-stated-Total checked clean across all 4,106 unit records"


def test_no_unexpected_loader_errors(real_conn):
    """loader_errors is for bugs in the loader itself, not data-quality issues. A clean
    load of the real 25+25 files should never produce one -- if it does, something in
    the loader broke, not something in the source data."""
    n = real_conn.execute("SELECT COUNT(*) FROM loader_errors").fetchone()[0]
    assert n == 0


def test_no_orphaned_rows_or_fk_violations(real_conn):
    violations = real_conn.execute("PRAGMA foreign_key_check").fetchall()
    assert violations == []

    orphan_tenancies = real_conn.execute(
        """SELECT COUNT(*) FROM tenancies t
           LEFT JOIN data_snapshots s ON s.snapshot_id = t.snapshot_id
           WHERE s.snapshot_id IS NULL"""
    ).fetchone()[0]
    assert orphan_tenancies == 0

    orphan_charges = real_conn.execute(
        """SELECT COUNT(*) FROM charges c
           LEFT JOIN tenancies t ON t.tenancy_id = c.tenancy_id
           WHERE t.tenancy_id IS NULL"""
    ).fetchone()[0]
    assert orphan_charges == 0


def test_known_missing_charges_properties_flagged_severe(real_conn):
    """The 5 properties found (during dashboard-building, not the original investigation)
    to have systemic missing charges must still trip the severe flag_type."""
    rows = real_conn.execute(
        "SELECT DISTINCT property_id FROM data_quality_flags WHERE flag_type = 'missing_charges'"
    ).fetchall()
    flagged = {r[0] for r in rows}
    assert flagged == {"175", "176", "183", "184", "185"}


def test_empty_rent_roll_properties_flagged(real_conn):
    rows = real_conn.execute(
        "SELECT property_id FROM data_quality_flags WHERE flag_type = 'empty_rent_roll' ORDER BY property_id"
    ).fetchall()
    assert {r[0] for r in rows} == {"134", "183", "altapm"}


def test_153c_unit_availability_mismatch_flagged(real_conn):
    rows = real_conn.execute(
        "SELECT property_id FROM data_quality_flags WHERE flag_type = 'unit_availability_mismatch'"
    ).fetchall()
    assert [r[0] for r in rows] == ["153"]
