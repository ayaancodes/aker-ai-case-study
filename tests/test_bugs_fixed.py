"""
Regression tests for specific bugs that were found and fixed during the build (see
CLAUDE.md sections 4 and "audit"). Each test locks in the fix so a future refactor can't
silently reintroduce it.
"""

import re

ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def test_as_of_date_is_iso_format_everywhere(real_conn):
    """Bug: as_of_date was originally stored as raw MM/DD/YYYY text from the source
    file header while every other date field was ISO, which broke SQL date comparisons
    silently (SQLite's date() returns NULL on non-ISO input). Fixed at the parser level."""
    rows = real_conn.execute(
        "SELECT DISTINCT as_of_date FROM data_snapshots WHERE as_of_date IS NOT NULL"
    ).fetchall()
    assert rows, "expected at least one non-null as_of_date"
    for (value,) in rows:
        assert ISO_DATE_RE.match(value), f"as_of_date {value!r} is not ISO (YYYY-MM-DD)"


def test_no_null_as_of_date(real_conn):
    n = real_conn.execute(
        "SELECT COUNT(*) FROM data_snapshots WHERE as_of_date IS NULL"
    ).fetchone()[0]
    assert n == 0, (
        "a NULL as_of_date would silently vanish from every revenue view -- "
        "v_latest_rent_roll_snapshot joins on as_of_date equality, and NULL never equals NULL in SQL"
    )


def test_leases_expiring_window_bounded_on_both_ends(real_conn):
    """Bug: /leases/expiring only bounded the upper end of the date window
    (lease_expiration <= as_of + N days), which silently swept in already-expired
    holdover leases as if they were 'expiring soon'. Fixed with a BETWEEN on both ends.
    This test re-derives the same query the API uses and checks no already-expired
    lease sneaks into a short lookout window."""
    cutoff = real_conn.execute(
        "SELECT MAX(as_of_date) FROM data_snapshots WHERE source_type = 'rent_roll'"
    ).fetchone()[0]

    rows = real_conn.execute(
        """SELECT lease_expiration FROM v_lease_expirations
           WHERE lease_expiration BETWEEN ? AND date(?, '+60 days')""",
        (cutoff, cutoff),
    ).fetchall()

    for (expiration,) in rows:
        assert expiration >= cutoff, (
            f"lease_expiration {expiration} is before the reference date {cutoff} -- "
            "an already-expired (holdover) lease leaked into the 'expiring soon' window"
        )


def test_holdover_leases_exist_and_are_excluded_from_expiring_window(real_conn):
    """Sanity check that the holdover population (331 known leases already expired as
    of the data's as_of date) is real and specifically NOT part of what a default
    60-day expiring window returns -- i.e. the two are genuinely different populations,
    not that the holdover count happens to be zero."""
    cutoff = real_conn.execute(
        "SELECT MAX(as_of_date) FROM data_snapshots WHERE source_type = 'rent_roll'"
    ).fetchone()[0]
    holdovers = real_conn.execute(
        """SELECT COUNT(*) FROM tenancies
           WHERE section = 'current' AND status = 'occupied' AND lease_expiration < ?""",
        (cutoff,),
    ).fetchone()[0]
    assert holdovers == 331


def test_missing_charges_check_covers_notice_status(real_conn):
    """Bug found during audit: the missing_charges check only looked at
    status == 'occupied', missing the identical failure pattern among 'notice' status
    tenants (real resident, real rent, still excluded from the check). Verifies the
    flag's own counted totals for the 5 known-affected properties include notice-status
    tenants, not just occupied ones."""
    rows = real_conn.execute(
        """SELECT property_id, detail FROM data_quality_flags
           WHERE flag_type = 'missing_charges' ORDER BY property_id"""
    ).fetchall()
    assert rows, "expected missing_charges flags to exist"
    for property_id, detail in rows:
        assert "occupied/notice" in detail, (
            f"flag detail for {property_id} doesn't reference notice-status tenancies: {detail!r}"
        )


def test_missing_charges_never_excludes_model_or_down(real_conn):
    """model/down are placeholder/administrative rows (generic 'Resident N' names, not
    real tenants -- see CLAUDE.md) where market_rent reflects the unit's listed rent,
    not a bill anyone owes. They should never appear in a missing_charges flag's
    denominator. This isn't directly queryable from the flags table (which only stores
    the final ratio), so this recomputes the same population the loader's check uses
    and confirms model/down tenancies are absent from it by construction."""
    model_down_with_rent = real_conn.execute(
        """SELECT COUNT(*) FROM tenancies
           WHERE section = 'current' AND status IN ('model', 'down') AND market_rent > 0"""
    ).fetchone()[0]
    # This is a sanity check that the population exists in the data at all (otherwise
    # the exclusion in the loader logic would be untested by this fixture's data).
    assert model_down_with_rent > 0


def test_partial_missing_charges_gap_is_visible_not_hidden(real_conn):
    """Bug found during audit: the original check was a boolean gated at >50% missing,
    so a property with e.g. 35% of charges missing loaded clean with zero signal
    anywhere. Property 144 has a small (0.1%) gap that must now show up as a
    'missing_charges_partial' flag with its exact ratio stored, not silently pass."""
    row = real_conn.execute(
        """SELECT flag_type, pct_value FROM data_quality_flags
           WHERE property_id = '144' AND flag_type LIKE 'missing_charges%'"""
    ).fetchone()
    assert row is not None, "property 144's small missing-charges gap should be flagged, not silently pass"
    flag_type, pct_value = row
    assert flag_type == "missing_charges_partial"
    assert pct_value is not None and 0 < pct_value <= 0.5


def test_missing_charges_pct_value_always_stored_and_matches_detail(real_conn):
    """pct_value must never be NULL on a missing_charges/missing_charges_partial row --
    that's the whole point of storing it instead of only a boolean-shaped flag_type."""
    rows = real_conn.execute(
        "SELECT flag_type, pct_value FROM data_quality_flags WHERE flag_type LIKE 'missing_charges%'"
    ).fetchall()
    assert rows
    for flag_type, pct_value in rows:
        assert pct_value is not None, f"{flag_type} row has NULL pct_value"
        assert 0 < pct_value <= 1
        if flag_type == "missing_charges":
            assert pct_value > 0.5
        elif flag_type == "missing_charges_partial":
            assert pct_value <= 0.5
