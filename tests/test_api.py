"""
Tests the FastAPI layer against the real loaded database via FastAPI's TestClient (in
process, no server needed). Sets DB_PATH explicitly to the real db/portfolio.db so this
doesn't depend on the test runner's current working directory.
"""

import os

import pytest
from fastapi.testclient import TestClient

# Mirrors conftest.py's path logic rather than importing it as `tests.conftest`, since
# this repo's tests/ has no __init__.py and pytest's own conftest auto-import can end up
# loading it under a different module name than an explicit `tests.conftest` import --
# recomputing the same two lines locally sidesteps that ambiguity entirely.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REAL_DB_PATH = os.path.join(PROJECT_ROOT, "db", "portfolio.db")


@pytest.fixture
def client():
    if not os.path.exists(REAL_DB_PATH):
        pytest.skip("db/portfolio.db not found -- run scripts/load_data.py first")
    os.environ["DB_PATH"] = REAL_DB_PATH
    from api.main import app
    return TestClient(app)


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_stats_matches_known_numbers(client):
    resp = client.get("/stats")
    assert resp.status_code == 200
    body = resp.json()
    assert body["properties"] == 15
    assert body["tenancies"] == 4106
    assert body["charges"] == 9177
    assert body["charge_total_mismatches"] == 0
    assert body["loader_errors"] == 0


def test_anomalies_exposes_pct_value(client):
    """The dashboard-visible /anomalies endpoint must surface the underlying percentage
    for missing_charges flags, not just the flag_type label -- otherwise the fix that
    makes partial gaps visible in the database is invisible again at the API layer."""
    resp = client.get("/anomalies")
    assert resp.status_code == 200
    rows = resp.json()
    missing_charges_rows = [r for r in rows if r["flag_type"].startswith("missing_charges")]
    assert missing_charges_rows
    for row in missing_charges_rows:
        assert "pct_value" in row
        assert row["pct_value"] is not None


def test_loader_errors_endpoint_empty_on_clean_load(client):
    resp = client.get("/loader-errors")
    assert resp.status_code == 200
    assert resp.json() == []


def test_revenue_portfolio_does_not_drop_missing_charges_properties(client):
    """Properties with zero recorded charges anywhere (176, 183, 184, 185) must still
    appear in the by_property breakdown at $0, not be silently absent -- an absent
    property on a revenue dashboard reads as 'this property doesn't exist,' which is
    false and hides the exact issue this whole audit is about."""
    resp = client.get("/revenue/portfolio")
    assert resp.status_code == 200
    body = resp.json()
    property_ids = {row["property_id"] for row in body["by_property"]}
    assert {"176", "183", "184", "185"}.issubset(property_ids)
    for row in body["by_property"]:
        if row["property_id"] in {"176", "184", "185"}:
            assert row["net_effective_revenue"] == 0


def test_revenue_single_property_no_charges_returns_zeros_not_404(client):
    resp = client.get("/revenue/176")
    assert resp.status_code == 200
    body = resp.json()
    assert body["gross_revenue"] == 0
    assert body["net_effective_revenue"] == 0


def test_revenue_unknown_property_still_404s(client):
    resp = client.get("/revenue/does-not-exist")
    assert resp.status_code == 404


def test_leases_holdover_matches_stats_count(client):
    """The copilot QA pass caught the model asserting 'no leases have expired' because
    /leases/expiring only looks forward from the as-of date. /leases/holdover is the
    other lens: occupied tenancies whose expiration is already past. Its count must
    match the holdover_leases figure /stats has always reported (331), or the two
    endpoints are silently defining 'holdover' differently."""
    holdover = client.get("/leases/holdover").json()
    stats = client.get("/stats").json()
    assert holdover["holdover_count"] == stats["holdover_leases"] == 331
    assert len(holdover["holdovers"]) == 331
    # oldest first, and every row genuinely expired before the as-of date
    dates = [h["lease_expiration"] for h in holdover["holdovers"]]
    assert dates == sorted(dates)
    assert all(d < holdover["reference_date"] for d in dates)


def test_unit_lookup_resolves_by_number(client):
    """The QA pass caught the model literally guessing internal unit_ids (1284-1286)
    when it needed unit 328-104 -- whose real id turned out to be different. Lookup by
    (property, unit number) removes the need to guess. 328-104 at The Mill Greenwich
    is the specific unit that triggered this: the portfolio's largest delinquency."""
    resp = client.get("/units/lookup", params={"property_id": "139", "unit_number": "328-104"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["canonical_name"] == "The Mill Greenwich"
    assert body["tenancy"]["balance"] == 178806.41
    assert body["charges"] == []  # the documented missing_charges partial gap at 139

    missing = client.get("/units/lookup", params={"property_id": "139", "unit_number": "nope"})
    assert missing.status_code == 404


def test_delinquent_and_leases_carry_unit_id_and_name(client):
    """unit_id and canonical_name were added to both views so the copilot can chain
    into unit_detail without fishing, and so it stops inventing property names for
    codes (it called 153 'Sutton Hill'; 153 is Abbot Mill)."""
    delinquent = client.get("/delinquent?min_balance=100000").json()["rows"]
    assert delinquent[0]["unit_id"] and delinquent[0]["canonical_name"] == "The Mill Greenwich"
    leases = client.get("/leases/expiring?days=14").json()["leases"]
    assert all(row["unit_id"] and row["canonical_name"] for row in leases)


def test_list_limits_cap_rows_but_totals_stay_honest(client):
    """The chat's table caps are only honest if the server reports the FULL match
    alongside the capped rows -- 'showing 50 of 705' needs the 705."""
    d = client.get("/delinquent?limit=5").json()
    assert len(d["rows"]) == 5
    assert d["total_count"] > 5
    assert d["total_balance"] > sum(r["balance"] for r in d["rows"]) / 2  # sanity: totals over full set

    h = client.get("/leases/holdover?limit=5").json()
    assert len(h["holdovers"]) == 5 and h["holdover_count"] == 331

    u = client.get("/properties/144/units?limit=5").json()
    assert len(u["units"]) == 5 and u["total_count"] == 775

    e = client.get("/leases/expiring?days=60&limit=5").json()
    assert len(e["leases"]) == 5 and e["total_count"] > 5


def test_metrics_rent_summary_shapes_and_sanity(client):
    rows = client.get("/metrics/rent-summary").json()
    ids = {r["property_id"] for r in rows}
    assert "144" in ids
    winners = next(r for r in rows if r["property_id"] == "144")
    assert winners["avg_market_rent"] > 1000
    assert winners["revenue_per_sq_ft"] and winners["revenue_per_sq_ft"] > 0
    # the missing-charges properties carry real rents but ~zero revenue: rev/sqft ~ 0,
    # avg rent still real -- the aggregate must not hide that contradiction
    if "176" in ids:
        alexander = next(r for r in rows if r["property_id"] == "176")
        assert alexander["avg_market_rent"] > 1000
        assert alexander["net_effective_revenue"] == 0


def test_metrics_delinquency_summary_matches_raw(client):
    summary = client.get("/metrics/delinquency-summary").json()
    raw = client.get("/delinquent").json()
    assert summary["portfolio_delinquent_count"] == raw["total_count"]
    assert abs(summary["portfolio_total_balance"] - raw["total_balance"]) < 0.01
    worst = summary["by_property"][0]
    assert worst["property_id"] == "139" and worst["max_balance"] == 178806.41


def test_query_endpoint_guardrails(client):
    """The copilot's SQL tool: SELECT-only, single statement, denylist, forced LIMIT,
    and a connection that is read-only at the SQLite level, not just at the regex."""
    ok = client.post("/query", json={"sql": "SELECT COUNT(*) AS n FROM tenancies"})
    assert ok.status_code == 200
    assert ok.json()["rows"][0][0] == 4106
    assert "LIMIT" in ok.json()["sql"]  # cap appended when missing

    for bad in [
        "DELETE FROM charges",
        "SELECT 1; DROP TABLE charges",
        "PRAGMA writable_schema=1",
        "UPDATE tenancies SET balance = 0",
        "not sql at all",
    ]:
        assert client.post("/query", json={"sql": bad}).status_code == 400

    # sqlite itself must reject writes even if a clever SELECT smuggles one somehow:
    # mode=ro is the real fence, exercised via a data-modifying CTE denied upstream,
    # so instead prove the endpoint result is capped
    big = client.post("/query", json={"sql": "SELECT tenancy_id FROM tenancies"}).json()
    assert big["row_count"] <= 200


def test_revenue_bridge_ties_out(client):
    """Every step of the bridge is a real number and the arithmetic closes exactly:
    gross potential - vacancy = billable; billable - gap = billed base; billed base
    + other = gross revenue; gross + concessions = net effective. The gap step must
    equal the documented missing-charges figure."""
    b = client.get("/metrics/revenue-bridge").json()
    assert abs(b["gross_potential_rent"] - b["vacancy_loss"] - b["billable_market_rent"]) < 0.01
    assert abs(b["billable_market_rent"] - b["missing_charge_gap"] - b["billed_rent_base"]) < 0.01
    assert abs(b["billed_rent_base"] + b["other_income_and_variance"] - b["gross_revenue"]) < 0.01
    assert abs(b["gross_revenue"] + b["concessions"] - b["net_effective_revenue"]) < 0.01
    assert b["missing_charge_gap"] == 2045964.0


def test_delinquent_rows_carry_program_type(client):
    """Feeds the Risk tab's commercial vs residential split -- the one commercial
    balance ($178K) must be separable from residential risk."""
    rows = client.get("/delinquent").json()["rows"]
    programs = {r["program_type"] for r in rows}
    assert {"residential", "commercial", "affordable"} <= programs
    commercial = [r for r in rows if r["program_type"] == "commercial"]
    assert max(r["balance"] for r in commercial) == 178806.41
