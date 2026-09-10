"""
FastAPI backend for the real estate portfolio. Each endpoint is deliberately narrow and
single-purpose -- these double as tool definitions for the LLM chatbot later, so a
clean, predictable shape here matters more than for a typical CRUD API.

Run: uvicorn api.main:app --reload
"""

import re
import sqlite3
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from api.chat import ChatRequest, stream_chat
from api.db import DB_PATH, get_connection

app = FastAPI(title="Portfolio API")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


@app.middleware("http")
async def no_cache_static(request, call_next):
    """Browsers were serving stale copies of the dashboard's HTML/JS/CSS from HTTP
    cache across iterations (StaticFiles responses are cacheable by default), which
    made every frontend change look broken until a hard refresh. no-cache keeps
    revalidation cheap (304s via Last-Modified still work) but guarantees the browser
    always checks with the server first."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css")):
        response.headers["Cache-Control"] = "no-cache"
    return response


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


@app.get("/revenue/concentration")
def revenue_concentration(conn=Depends(get_connection)):
    """Gross revenue by program_type (residential/affordable/commercial/land), portfolio
    wide -- the concentration-risk view: what share of the portfolio's income depends on
    subsidized vs market-rate vs commercial tenants. Excludes concessions (a credit
    against revenue, not a revenue source) so the mix reflects where gross income
    actually comes from. Declared before /revenue/{property_id} -- FastAPI matches
    routes in registration order, and a literal path segment must come before a
    variable one that could also match it, or this always 404s as "unknown property
    'concentration'"."""
    rows = conn.execute(
        """SELECT u.program_type, SUM(c.amount) AS amount
           FROM charges c
           JOIN charge_codes cc ON cc.code = c.charge_code
           JOIN tenancies t ON t.tenancy_id = c.tenancy_id
           JOIN units u ON u.unit_id = t.unit_id
           JOIN data_snapshots s ON s.snapshot_id = t.snapshot_id
           JOIN v_latest_rent_roll_snapshot latest
               ON latest.property_id = u.property_id AND latest.as_of_date = s.as_of_date
           WHERE cc.category != 'concession'
           GROUP BY u.program_type
           ORDER BY amount DESC"""
    ).fetchall()
    return [dict(r) for r in rows]


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
    limit: Optional[int] = Query(None, ge=1, description="Cap the returned rows; total_count always reflects the full match"),
    conn=Depends(get_connection),
):
    cutoff = conn.execute(
        "SELECT MAX(as_of_date) FROM data_snapshots WHERE source_type = 'rent_roll'"
    ).fetchone()[0]

    query = """SELECT tenancy_id, unit_id, property_id, canonical_name, unit_number,
                      resident_name, lease_expiration, market_rent
               FROM v_lease_expirations
               WHERE lease_expiration BETWEEN ? AND date(?, '+' || ? || ' days')"""
    params = [cutoff, cutoff, days]
    if property_id:
        query += " AND property_id = ?"
        params.append(property_id)
    query += " ORDER BY lease_expiration"

    rows = conn.execute(query, params).fetchall()
    total = len(rows)
    if limit is not None:
        rows = rows[:limit]
    return {
        "reference_date": cutoff,
        "window_days": days,
        "total_count": total,
        "leases": [dict(r) for r in rows],
    }


@app.get("/leases/holdover")
def leases_holdover(
    property_id: Optional[str] = None,
    limit: Optional[int] = Query(None, ge=1, description="Cap the returned rows; holdover_count always reflects the full match"),
    conn=Depends(get_connection),
):
    """Occupied tenancies whose lease_expiration is already in the PAST relative to the
    data's as-of date -- residents who stayed on after their lease term lapsed and the
    field was never updated (331 portfolio-wide, some by over a decade; see CLAUDE.md
    section 1). This is a different risk view from /leases/expiring, which only looks
    forward: the copilot QA pass caught the model flatly asserting "no leases have
    expired" because the forward-looking endpoint was the only lens it had."""
    cutoff = conn.execute(
        "SELECT MAX(as_of_date) FROM data_snapshots WHERE source_type = 'rent_roll'"
    ).fetchone()[0]

    query = """SELECT tenancy_id, unit_id, property_id, canonical_name, unit_number,
                      resident_name, lease_expiration, market_rent
               FROM v_lease_expirations
               WHERE lease_expiration < ?"""
    params = [cutoff]
    if property_id:
        query += " AND property_id = ?"
        params.append(property_id)
    query += " ORDER BY lease_expiration"

    rows = conn.execute(query, params).fetchall()
    total = len(rows)
    if limit is not None:
        rows = rows[:limit]
    return {
        "reference_date": cutoff,
        "holdover_count": total,
        "holdovers": [dict(r) for r in rows],
    }


@app.get("/delinquent")
def delinquent_tenancies(
    min_balance: float = Query(0, description="Only balances strictly greater than this"),
    property_id: Optional[str] = None,
    limit: Optional[int] = Query(None, ge=1, description="Cap the returned rows; total_count/total_balance always reflect the full match"),
    conn=Depends(get_connection),
):
    query = """SELECT tenancy_id, unit_id, property_id, canonical_name, unit_number,
                      program_type, resident_name, balance
               FROM v_delinquent_tenancies
               WHERE balance > ?"""
    params = [min_balance]
    if property_id:
        query += " AND property_id = ?"
        params.append(property_id)
    query += " ORDER BY balance DESC"

    rows = conn.execute(query, params).fetchall()
    total = len(rows)
    total_balance = sum(r["balance"] for r in rows)
    if limit is not None:
        rows = rows[:limit]
    return {
        "total_count": total,
        "total_balance": total_balance,
        "rows": [dict(r) for r in rows],
    }


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


@app.get("/occupancy/portfolio")
def occupancy_portfolio(conn=Depends(get_connection)):
    """Portfolio-wide occupancy, from unit_availability_snapshots -- data that's been
    loaded since the beginning but never surfaced anywhere in the dashboard until now.
    Sums units/occupied per property first (a property can have multiple program-type
    snapshots, e.g. residential + affordable), then computes a weighted pct_occ rather
    than averaging the per-program percentages, which would misrepresent properties
    with very differently sized programs."""
    rows = conn.execute(
        """SELECT p.property_id, p.canonical_name,
                  SUM(ua.total_units) AS total_units,
                  SUM(ua.occupied_no_notice) AS occupied,
                  SUM(ua.vacant_rented) + SUM(ua.vacant_unrented) AS vacant,
                  SUM(ua.notice_rented) + SUM(ua.notice_unrented) AS on_notice
           FROM unit_availability_snapshots ua
           JOIN properties p ON p.property_id = ua.property_id
           GROUP BY p.property_id
           ORDER BY p.property_id"""
    ).fetchall()

    by_property = []
    total_units_all = total_occupied_all = 0
    for r in rows:
        d = dict(r)
        d["pct_occ"] = round(100 * d["occupied"] / d["total_units"], 1) if d["total_units"] else None
        by_property.append(d)
        total_units_all += d["total_units"] or 0
        total_occupied_all += d["occupied"] or 0

    return {
        "total_units": total_units_all,
        "total_occupied": total_occupied_all,
        "pct_occ": round(100 * total_occupied_all / total_units_all, 1) if total_units_all else None,
        "by_property": by_property,
    }


@app.get("/occupancy/{property_id}")
def occupancy_property(property_id: str, conn=Depends(get_connection)):
    prop = conn.execute(
        "SELECT canonical_name FROM properties WHERE property_id = ?", (property_id,)
    ).fetchone()
    if prop is None:
        raise HTTPException(status_code=404, detail=f"Unknown property_id: {property_id}")

    row = conn.execute(
        """SELECT SUM(total_units) AS total_units, SUM(occupied_no_notice) AS occupied,
                  SUM(vacant_rented) + SUM(vacant_unrented) AS vacant,
                  SUM(notice_rented) + SUM(notice_unrented) AS on_notice,
                  AVG(avg_rent) AS avg_rent, AVG(avg_sq_ft) AS avg_sq_ft
           FROM unit_availability_snapshots WHERE property_id = ?""",
        (property_id,),
    ).fetchone()
    d = dict(row) if row else {}
    total_units = d.get("total_units") or 0
    occupied = d.get("occupied") or 0
    return {
        "property_id": property_id,
        "canonical_name": prop["canonical_name"],
        "total_units": total_units,
        "occupied": occupied,
        "vacant": d.get("vacant") or 0,
        "on_notice": d.get("on_notice") or 0,
        "pct_occ": round(100 * occupied / total_units, 1) if total_units else None,
        "avg_rent": d.get("avg_rent"),
        "avg_sq_ft": d.get("avg_sq_ft"),
    }


@app.get("/properties/{property_id}/units")
def property_units(
    property_id: str,
    limit: Optional[int] = Query(None, ge=1, description="Cap the returned rows; total_count always reflects the full unit count"),
    conn=Depends(get_connection),
):
    """Unit-level drill-down for a property -- the second layer under the property view.
    Joins each unit to its current-section tenancy from that unit's program's latest
    rent-roll snapshot, so vacant units show with no tenancy fields rather than being
    dropped. No default limit: the dashboard filters/searches the full list client
    side; the chatbot's tool dispatch passes an explicit limit instead."""
    prop = conn.execute(
        "SELECT canonical_name FROM properties WHERE property_id = ?", (property_id,)
    ).fetchone()
    if prop is None:
        raise HTTPException(status_code=404, detail=f"Unknown property_id: {property_id}")

    rows = conn.execute(
        """SELECT u.unit_id, u.unit_number, u.unit_type, u.program_type, u.sq_ft,
                  t.status, t.resident_name, t.market_rent, t.balance, t.lease_expiration
           FROM units u
           LEFT JOIN tenancies t ON t.unit_id = u.unit_id
               AND t.section = 'current'
               AND t.snapshot_id = (
                   SELECT s.snapshot_id FROM data_snapshots s
                   WHERE s.property_id = u.property_id AND s.program_type = u.program_type
                     AND s.source_type = 'rent_roll'
                   ORDER BY s.as_of_date DESC LIMIT 1
               )
           WHERE u.property_id = ?
           ORDER BY u.unit_number""",
        (property_id,),
    ).fetchall()
    total = len(rows)
    if limit is not None:
        rows = rows[:limit]
    return {"total_count": total, "units": [dict(r) for r in rows]}


@app.get("/metrics/revenue-bridge")
def revenue_bridge(conn=Depends(get_connection)):
    """The CFO-style bridge from gross potential rent down to net effective revenue,
    every step a real number from the loaded data:
      gross potential (market rent, every current-section unit)
      - vacancy loss (market rent parked in vacant/model/down units)
      = billable market rent (occupied + notice)
      - missing-charge gap (billable tenancies with ZERO recorded charge lines --
        the portfolio's known data quality finding, as a financial line item)
      = billed rent base
      + other income & billing variance (ancillary, fees, subsidies, and the gap
        between stated market rent and what's actually billed on billed tenancies)
      = gross revenue (actual recorded charges)
      - concessions
      = net effective revenue
    The 'other' step is a residual and is labeled as such -- it makes the bridge tie
    out exactly to recorded revenue instead of pretending market rent bills itself."""
    row = conn.execute(
        """SELECT
             SUM(t.market_rent) AS gross_potential,
             SUM(CASE WHEN t.status IN ('vacant','model','down') THEN t.market_rent ELSE 0 END) AS vacancy_loss,
             SUM(CASE WHEN t.status IN ('occupied','notice')
                       AND NOT EXISTS (SELECT 1 FROM charges c WHERE c.tenancy_id = t.tenancy_id)
                      THEN t.market_rent ELSE 0 END) AS missing_charge_gap
           FROM tenancies t
           JOIN units u ON u.unit_id = t.unit_id
           JOIN data_snapshots s ON s.snapshot_id = t.snapshot_id
           JOIN v_latest_rent_roll_snapshot latest
               ON latest.property_id = u.property_id AND latest.as_of_date = s.as_of_date
           WHERE t.section = 'current'"""
    ).fetchone()
    totals = conn.execute(
        """SELECT SUM(gross_revenue) AS gross_revenue, SUM(concessions) AS concessions,
                  SUM(net_effective_revenue) AS net_effective
           FROM v_effective_revenue_by_property"""
    ).fetchone()

    gross_potential = round(row["gross_potential"] or 0, 2)
    vacancy_loss = round(row["vacancy_loss"] or 0, 2)
    billable = round(gross_potential - vacancy_loss, 2)
    gap = round(row["missing_charge_gap"] or 0, 2)
    billed_base = round(billable - gap, 2)
    gross_revenue = round(totals["gross_revenue"] or 0, 2)
    other_income = round(gross_revenue - billed_base, 2)
    concessions = round(totals["concessions"] or 0, 2)
    net_effective = round(totals["net_effective"] or 0, 2)
    return {
        "gross_potential_rent": gross_potential,
        "vacancy_loss": vacancy_loss,
        "billable_market_rent": billable,
        "missing_charge_gap": gap,
        "billed_rent_base": billed_base,
        "other_income_and_variance": other_income,
        "gross_revenue": gross_revenue,
        "concessions": concessions,
        "net_effective_revenue": net_effective,
    }


@app.get("/metrics/rent-summary")
def rent_summary(conn=Depends(get_connection)):
    """Per-property rent aggregates so the chatbot cites tool outputs instead of doing
    its own arithmetic in prose: average market rent across occupied/notice tenancies,
    and net effective revenue per occupied square foot. Latest snapshot per property,
    same resolution rule as every revenue view."""
    rows = conn.execute(
        """SELECT u.property_id, p.canonical_name,
                  ROUND(AVG(t.market_rent), 0) AS avg_market_rent,
                  COUNT(*) AS billable_tenancies,
                  ROUND(SUM(u.sq_ft), 0) AS occupied_sq_ft
           FROM tenancies t
           JOIN units u ON u.unit_id = t.unit_id
           JOIN properties p ON p.property_id = u.property_id
           JOIN data_snapshots s ON s.snapshot_id = t.snapshot_id
           JOIN v_latest_rent_roll_snapshot latest
               ON latest.property_id = u.property_id AND latest.as_of_date = s.as_of_date
           WHERE t.section = 'current' AND t.status IN ('occupied', 'notice')
             AND t.market_rent > 0
           GROUP BY u.property_id
           ORDER BY avg_market_rent DESC""",
    ).fetchall()
    revenue = {
        r["property_id"]: r["net_effective_revenue"]
        for r in conn.execute("SELECT property_id, net_effective_revenue FROM v_effective_revenue_by_property")
    }
    out = []
    for r in rows:
        d = dict(r)
        net = revenue.get(d["property_id"], 0)
        d["net_effective_revenue"] = net
        d["revenue_per_sq_ft"] = round(net / d["occupied_sq_ft"], 2) if d["occupied_sq_ft"] else None
        out.append(d)
    return out


@app.get("/metrics/delinquency-summary")
def delinquency_summary(conn=Depends(get_connection)):
    """Delinquency rolled up per property (count, total, largest single balance) plus
    a portfolio rollup -- the aggregate answer to 'who owes the most' style questions,
    so the model never sums raw rows itself."""
    rows = conn.execute(
        """SELECT property_id, canonical_name,
                  COUNT(*) AS delinquent_count,
                  ROUND(SUM(balance), 2) AS total_balance,
                  ROUND(MAX(balance), 2) AS max_balance
           FROM v_delinquent_tenancies
           GROUP BY property_id
           ORDER BY total_balance DESC""",
    ).fetchall()
    by_property = [dict(r) for r in rows]
    return {
        "portfolio_delinquent_count": sum(r["delinquent_count"] for r in by_property),
        "portfolio_total_balance": round(sum(r["total_balance"] for r in by_property), 2),
        "by_property": by_property,
    }


# ── guarded read-only SQL for the copilot ────────────────────────────────────────
# The model can run a SELECT when no endpoint covers the question, instead of doing
# arithmetic in prose. Guardrails, in depth order: the connection is opened read-only
# at the SQLite level (mode=ro -- writes fail in the engine, not in our regex), the
# statement must be a single SELECT, a keyword denylist rejects anything that isn't
# plain querying, and a LIMIT is appended when missing. The executed SQL is returned
# so the frontend can show exactly how a number was computed.

_SQL_DENY = re.compile(
    r"\b(insert|update|delete|drop|alter|create|replace|pragma|attach|detach|vacuum|reindex)\b",
    re.IGNORECASE,
)
_QUERY_ROW_CAP = 200


class SqlRequest(BaseModel):
    sql: str


@app.post("/query")
def run_query(payload: SqlRequest):
    sql = payload.sql.strip().rstrip(";").strip()
    if ";" in sql:
        raise HTTPException(status_code=400, detail="One statement only.")
    if not re.match(r"^select\b", sql, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="SELECT statements only.")
    if _SQL_DENY.search(sql):
        raise HTTPException(status_code=400, detail="Query contains a disallowed keyword.")
    if not re.search(r"\blimit\s+\d+\b", sql, re.IGNORECASE):
        sql = f"{sql} LIMIT {_QUERY_ROW_CAP}"

    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.execute(sql)
        rows = cur.fetchmany(_QUERY_ROW_CAP)
        columns = [c[0] for c in cur.description] if cur.description else []
        return {
            "sql": sql,
            "columns": columns,
            "rows": [list(r) for r in rows],
            "row_count": len(rows),
        }
    except sqlite3.Error as e:
        raise HTTPException(status_code=400, detail=f"SQL error: {e}")
    finally:
        conn.close()


@app.get("/units/lookup")
def unit_lookup(
    property_id: str,
    unit_number: str,
    conn=Depends(get_connection),
):
    """Resolve a unit by (property, unit number) straight to its full detail -- the
    copilot QA pass caught the model literally GUESSING internal unit_ids after the
    units list truncated before it reached the unit it wanted; a wrong guess would
    have presented the wrong unit's data as the right one. Declared before
    /units/{unit_id} (route registration order matters, same reasoning as
    /revenue/concentration). If unit numbering collides across program types within
    the property, all matches are returned so the caller picks by program."""
    rows = conn.execute(
        """SELECT unit_id FROM units
           WHERE property_id = ? AND unit_number = ?
           ORDER BY program_type""",
        (property_id, unit_number),
    ).fetchall()
    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No unit '{unit_number}' at property {property_id}",
        )
    details = [unit_detail(r["unit_id"], conn) for r in rows]
    if len(details) == 1:
        return details[0]
    return {"multiple_matches": True, "matches": details}


@app.get("/units/{unit_id}")
def unit_detail(unit_id: int, conn=Depends(get_connection)):
    """Full detail for one unit: dimensions, its current-section tenancy from the
    latest snapshot (deposits and dates included -- fields the units list omits),
    and the actual charge line items. Everything here is real loaded data; there is
    deliberately no history section because only one snapshot is loaded."""
    unit = conn.execute(
        """SELECT u.unit_id, u.property_id, p.canonical_name, u.program_type,
                  u.unit_number, u.unit_type, u.sq_ft
           FROM units u JOIN properties p ON p.property_id = u.property_id
           WHERE u.unit_id = ?""",
        (unit_id,),
    ).fetchone()
    if unit is None:
        raise HTTPException(status_code=404, detail=f"Unknown unit_id: {unit_id}")

    tenancy = conn.execute(
        """SELECT t.tenancy_id, t.status, t.resident_name, t.market_rent,
                  t.resident_deposit, t.other_deposit, t.move_in, t.lease_expiration,
                  t.move_out, t.balance
           FROM tenancies t
           WHERE t.unit_id = ? AND t.section = 'current'
             AND t.snapshot_id = (
                 SELECT s.snapshot_id FROM data_snapshots s
                 WHERE s.property_id = ? AND s.program_type = ?
                   AND s.source_type = 'rent_roll'
                 ORDER BY s.as_of_date DESC LIMIT 1
             )""",
        (unit_id, unit["property_id"], unit["program_type"]),
    ).fetchone()

    charges = []
    if tenancy:
        charges = [dict(r) for r in conn.execute(
            """SELECT c.charge_code, c.amount, cc.category, cc.description
               FROM charges c JOIN charge_codes cc ON cc.code = c.charge_code
               WHERE c.tenancy_id = ? ORDER BY c.amount DESC""",
            (tenancy["tenancy_id"],),
        ).fetchall()]

    return {
        **dict(unit),
        "tenancy": dict(tenancy) if tenancy else None,
        "charges": charges,
        "total_charges": sum(c["amount"] for c in charges),
    }


# Chat tool calls always carry an explicit row cap (default 50) -- the dashboard
# fetches these endpoints uncapped for client-side filtering/aggregation, but the
# model never needs more than the top of an ordered list plus the honest total_count.
CHAT_LIST_LIMIT = 50

TOOL_DISPATCH = {
    "list_properties": lambda args, conn: list_properties(conn),
    "get_property": lambda args, conn: get_property(args["property_id"], conn),
    "portfolio_revenue": lambda args, conn: portfolio_revenue(conn),
    "revenue_concentration": lambda args, conn: revenue_concentration(conn),
    "property_revenue": lambda args, conn: property_revenue(args["property_id"], conn),
    "leases_expiring": lambda args, conn: leases_expiring(args.get("days", 60), args.get("property_id"), min(int(args.get("limit", CHAT_LIST_LIMIT)), CHAT_LIST_LIMIT), conn),
    "leases_holdover": lambda args, conn: leases_holdover(args.get("property_id"), min(int(args.get("limit", CHAT_LIST_LIMIT)), CHAT_LIST_LIMIT), conn),
    "delinquent_tenancies": lambda args, conn: delinquent_tenancies(args.get("min_balance", 0), args.get("property_id"), min(int(args.get("limit", CHAT_LIST_LIMIT)), CHAT_LIST_LIMIT), conn),
    "anomalies": lambda args, conn: anomalies(args.get("property_id"), conn),
    "occupancy_portfolio": lambda args, conn: occupancy_portfolio(conn),
    "occupancy_property": lambda args, conn: occupancy_property(args["property_id"], conn),
    "property_units": lambda args, conn: property_units(args["property_id"], min(int(args.get("limit", CHAT_LIST_LIMIT)), CHAT_LIST_LIMIT), conn),
    "unit_detail": lambda args, conn: unit_detail(int(args["unit_id"]), conn),
    "unit_lookup": lambda args, conn: unit_lookup(args["property_id"], args["unit_number"], conn),
    "portfolio_stats": lambda args, conn: portfolio_stats(conn),
    "rent_summary": lambda args, conn: rent_summary(conn),
    "delinquency_summary": lambda args, conn: delinquency_summary(conn),
    "query_database": lambda args, conn: run_query(SqlRequest(sql=args["sql"])),
}


@app.post("/chat")
def chat(payload: ChatRequest):
    """Streams an SSE response: `text_delta` events carry response text as it's
    generated, `tool_call` events fire before each tool executes (name + a plain-English
    label, for the frontend's "thinking" indicator), `done` closes out a normal turn,
    `error` carries anything that went wrong. Every tool is a direct call into the
    handler functions above -- the chatbot answers through the same code path as the
    dashboard, never touches SQL on its own."""
    return StreamingResponse(
        stream_chat(payload.messages, TOOL_DISPATCH),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
