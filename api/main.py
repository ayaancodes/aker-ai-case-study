"""
FastAPI backend for the Aker portfolio. Each endpoint is deliberately narrow and
single-purpose -- these double as tool definitions for the LLM chatbot later, so a
clean, predictable shape here matters more than for a typical CRUD API.

Run: uvicorn api.main:app --reload
"""

from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from api.db import get_connection

app = FastAPI(title="Aker Portfolio API")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/stats")
def portfolio_stats(conn=Depends(get_connection)):
    """Portfolio-wide counts used for the dashboard's proof-of-rigor stat tiles --
    real numbers from the database, not display-layer guesses."""
    properties = conn.execute("SELECT COUNT(*) FROM properties").fetchone()[0]
    tenancies = conn.execute("SELECT COUNT(*) FROM tenancies").fetchone()[0]
    charges = conn.execute("SELECT COUNT(*) FROM charges").fetchone()[0]
    flags = conn.execute("SELECT COUNT(*) FROM data_quality_flags").fetchone()[0]
    mismatches = conn.execute(
        "SELECT COUNT(*) FROM data_quality_flags WHERE flag_type = 'charge_total_mismatch'"
    ).fetchone()[0]
    loader_errors = conn.execute("SELECT COUNT(*) FROM loader_errors").fetchone()[0]
    holdover_leases = conn.execute(
        """SELECT COUNT(*) FROM tenancies
           WHERE section = 'current' AND status = 'occupied'
             AND lease_expiration < (
                 SELECT MAX(as_of_date) FROM data_snapshots WHERE source_type = 'rent_roll'
             )"""
    ).fetchone()[0]

    return {
        "properties": properties,
        "tenancies": tenancies,
        "charges": charges,
        "charge_total_mismatches": mismatches,
        "data_quality_flags": flags,
        "holdover_leases": holdover_leases,
        "loader_errors": loader_errors,
    }


@app.get("/properties")
def list_properties(conn=Depends(get_connection)):
    rows = conn.execute(
        "SELECT property_id, canonical_name FROM properties ORDER BY property_id"
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/properties/{property_id}")
def get_property(property_id: str, conn=Depends(get_connection)):
    prop = conn.execute(
        "SELECT property_id, canonical_name FROM properties WHERE property_id = ?",
        (property_id,),
    ).fetchone()
    if prop is None:
        raise HTTPException(status_code=404, detail=f"Unknown property_id: {property_id}")

    aliases = conn.execute(
        "SELECT alias_name FROM property_name_aliases WHERE property_id = ?",
        (property_id,),
    ).fetchall()

    program_types = conn.execute(
        """SELECT DISTINCT program_type FROM data_snapshots
           WHERE property_id = ? ORDER BY program_type""",
        (property_id,),
    ).fetchall()

    snapshots = conn.execute(
        """SELECT source_type, MAX(as_of_date) AS latest_as_of_date
           FROM data_snapshots WHERE property_id = ? GROUP BY source_type""",
        (property_id,),
    ).fetchall()

    return {
        "property_id": prop["property_id"],
        "canonical_name": prop["canonical_name"],
        "aliases": [r["alias_name"] for r in aliases],
        "program_types": [r["program_type"] for r in program_types],
        "latest_as_of_date": {r["source_type"]: r["latest_as_of_date"] for r in snapshots},
    }


@app.get("/revenue/portfolio")
def portfolio_revenue(conn=Depends(get_connection)):
    """Portfolio-wide gross/concessions/net effective revenue, plus a per-property
    breakdown -- the NOI-style comparison view for spotting under/overperformers."""
    totals = conn.execute(
        """SELECT SUM(gross_revenue) AS total_gross_revenue,
                  SUM(concessions) AS total_concessions,
                  SUM(net_effective_revenue) AS total_net_effective_revenue
           FROM v_effective_revenue_by_property"""
    ).fetchone()

    # LEFT JOIN from properties, not the revenue view -- a property with zero recorded
    # charges anywhere (176, 183, 184, 185: the missing_charges properties, confirmed to
    # have zero charges across every one of their snapshots, not just most) has no row
    # in v_effective_revenue_by_property at all, since that view is built from an inner
    # join starting at `charges`. Querying from the view would silently drop those
    # properties from the dashboard instead of showing them at $0 -- making the
    # portfolio look smaller and healthier than it is, which is the opposite of this
    # project's whole point. COALESCE keeps the numeric fields real zeros, not null.
    by_property = conn.execute(
        """SELECT p.property_id, p.canonical_name,
                  COALESCE(v.gross_revenue, 0) AS gross_revenue,
                  COALESCE(v.concessions, 0) AS concessions,
                  COALESCE(v.net_effective_revenue, 0) AS net_effective_revenue
           FROM properties p
           LEFT JOIN v_effective_revenue_by_property v ON v.property_id = p.property_id
           ORDER BY net_effective_revenue DESC"""
    ).fetchall()

    by_category = conn.execute(
        """SELECT category, SUM(total_amount) AS amount
           FROM v_revenue_by_property_category
           GROUP BY category
           ORDER BY amount DESC"""
    ).fetchall()

    return {
        "total_gross_revenue": totals["total_gross_revenue"],
        "total_concessions": totals["total_concessions"],
        "total_net_effective_revenue": totals["total_net_effective_revenue"],
        "by_property": [dict(r) for r in by_property],
        "by_category": [dict(r) for r in by_category],
    }


@app.get("/revenue/{property_id}")
def property_revenue(property_id: str, conn=Depends(get_connection)):
    prop = conn.execute(
        "SELECT canonical_name FROM properties WHERE property_id = ?", (property_id,)
    ).fetchone()
    if prop is None:
        raise HTTPException(status_code=404, detail=f"Unknown property_id: {property_id}")

    effective = conn.execute(
        """SELECT gross_revenue, concessions, net_effective_revenue, as_of_date
           FROM v_effective_revenue_by_property WHERE property_id = ?""",
        (property_id,),
    ).fetchone()

    # A real property (exists in `properties`) with zero recorded charges anywhere is a
    # data quality problem (see /anomalies), not a 404 -- 404 here would mean "this
    # property doesn't exist," which is false. Return honest zeros instead, same fix
    # as /revenue/portfolio.
    by_category = conn.execute(
        """SELECT category, total_amount AS amount
           FROM v_revenue_by_property_category
           WHERE property_id = ?
           ORDER BY amount DESC""",
        (property_id,),
    ).fetchall()

    return {
        "property_id": property_id,
        "canonical_name": prop["canonical_name"],
        "as_of_date": effective["as_of_date"] if effective else None,
        "gross_revenue": effective["gross_revenue"] if effective else 0,
        "concessions": effective["concessions"] if effective else 0,
        "net_effective_revenue": effective["net_effective_revenue"] if effective else 0,
        "by_category": [dict(r) for r in by_category],
    }


@app.get("/leases/expiring")
def leases_expiring(
    days: int = Query(60, ge=0, description="Lookout window in days from the data's latest as-of date"),
    property_id: Optional[str] = None,
    conn=Depends(get_connection),
):
    cutoff = conn.execute(
        "SELECT MAX(as_of_date) FROM data_snapshots WHERE source_type = 'rent_roll'"
    ).fetchone()[0]

    query = """SELECT tenancy_id, property_id, unit_number, resident_name,
                      lease_expiration, market_rent
               FROM v_lease_expirations
               WHERE lease_expiration BETWEEN ? AND date(?, '+' || ? || ' days')"""
    params = [cutoff, cutoff, days]
    if property_id:
        query += " AND property_id = ?"
        params.append(property_id)
    query += " ORDER BY lease_expiration"

    rows = conn.execute(query, params).fetchall()
    return {
        "reference_date": cutoff,
        "window_days": days,
        "leases": [dict(r) for r in rows],
    }


@app.get("/delinquent")
def delinquent_tenancies(
    min_balance: float = Query(0, description="Only balances strictly greater than this"),
    property_id: Optional[str] = None,
    conn=Depends(get_connection),
):
    query = """SELECT tenancy_id, property_id, unit_number, resident_name, balance
               FROM v_delinquent_tenancies
               WHERE balance > ?"""
    params = [min_balance]
    if property_id:
        query += " AND property_id = ?"
        params.append(property_id)
    query += " ORDER BY balance DESC"

    rows = conn.execute(query, params).fetchall()
    return [dict(r) for r in rows]


@app.get("/anomalies")
def anomalies(property_id: Optional[str] = None, conn=Depends(get_connection)):
    query = """SELECT flag_id, property_id, snapshot_id, flag_type, detail, pct_value, flagged_at
               FROM data_quality_flags"""
    params = []
    if property_id:
        query += " WHERE property_id = ?"
        params.append(property_id)
    query += " ORDER BY flagged_at DESC"

    rows = conn.execute(query, params).fetchall()
    return [dict(r) for r in rows]


@app.get("/loader-errors")
def loader_errors(conn=Depends(get_connection)):
    """Unexpected (non-parse) exceptions hit during the last few loads -- almost
    certainly a bug in the loader itself, not a source data problem. Kept separate from
    /anomalies since those two failure classes shouldn't be conflated (see loader_errors
    table comment in db/schema.sql)."""
    rows = conn.execute(
        """SELECT error_id, source_filename, error_type, error_detail, occurred_at
           FROM loader_errors ORDER BY occurred_at DESC"""
    ).fetchall()
    return [dict(r) for r in rows]


# Mounted last, after every API route above -- Starlette matches declared routes
# before falling through to a mount, so this can't shadow /properties, /revenue/etc.
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="dashboard")
