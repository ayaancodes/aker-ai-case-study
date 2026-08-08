"""
Tests the FastAPI layer against the real loaded database via FastAPI's TestClient (in
process, no server needed). Sets AKER_DB_PATH explicitly to the real db/aker.db so this
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
REAL_DB_PATH = os.path.join(PROJECT_ROOT, "db", "aker.db")


@pytest.fixture
def client():
    if not os.path.exists(REAL_DB_PATH):
        pytest.skip("db/aker.db not found -- run scripts/load_data.py first")
    os.environ["AKER_DB_PATH"] = REAL_DB_PATH
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
