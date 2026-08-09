"""
Portfolio copilot: an agentic tool-calling loop over the Anthropic API, where every
tool is a thin wrapper around an existing FastAPI route handler in api/main.py -- the
chatbot answers through the same functions the dashboard does, never touches SQL
directly. This module has no import of api.main (avoids a circular import, since
main.py imports this module); the actual dispatch table gets built in main.py, where
those handler functions already exist, and handed in at call time.

Model: claude-haiku-4-5-20251001. Cheap/fast tier on purpose -- this is a scoped
~13-tool agent, not a reasoning-heavy task, and the project is still being iterated on.
"""

import json
import logging
import os
import re
import sqlite3

from anthropic import Anthropic
from dotenv import load_dotenv
from pydantic import BaseModel

from api.db import DB_PATH

load_dotenv()

logger = logging.getLogger("aker.chat.grounding")

MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 450
MAX_TOOL_ITERATIONS = 6

# Cap on list length sent to the MODEL inside tool_result blocks (token cost). The
# frontend gets the untouched, full result over a separate SSE event -- rendering a
# table/chart client-side is free, it never passes through the LLM. Source queries are
# already ordered by relevance (balance DESC, lease_expiration ASC, etc.), so keeping
# the first N keeps the part a human would actually look at.
MODEL_LIST_CAP = 20

SYSTEM_PROMPT = """You are the Aker Portfolio Terminal copilot -- a real estate portfolio
analyst embedded in a dashboard covering 15 properties, ~4,100 tenancies, loaded from a
single month's Rent Roll and Unit Availability snapshot.

The interface renders your FIRST tool result as a real table or chart right after your
answer; any additional datasets appear as chips the user can expand. So your job is NOT
to restate the data. Write 1-3 short sentences: the direct answer plus one genuine
insight or caveat. Never use markdown headers or bullet lists. You may bold at most one
figure with **that** if it's the single number that matters. If the question was
genuinely ambiguous about scope (which property, which time window, which cut of the
data), end with ONE short clarifying offer like "Want the full table?" or "Did you mean
a specific property?" -- but only when actually ambiguous, never as a reflex.

How to write (this is a product, not an essay):
- Never use an em dash or en dash. Use a period and start a new sentence.
- Lists you receive are often capped, and the on-screen table shows at most 10 rows
  with a "showing N of M" note. Never claim the full list is displayed. If total_count
  exceeds the rows you saw, that IS the partial-data case: say it first.
- Short plain sentences. One idea per sentence.
- Round dollar figures in prose ($7.56M, $144K). The card carries exact numbers.
- Never enumerate rankings in prose ("X leads at A, followed by B at C, and D at E").
  The table shows the ranking. Name at most the single top item if it matters.
- If a tool result is partial (a capped list where total_count exceeds the rows shown,
  or a property with the missing-charges gap), say so in your FIRST sentence, not as a
  trailing note.
- Do not do arithmetic in prose. If the number you want isn't in a tool result, get it
  from rent_summary, delinquency_summary, or a query_database SELECT. Your query is
  shown to the user as the receipt for how the number was computed. This includes
  COUNTS: never sum counts across rows yourself (a QA pass caught "636 tenancies
  combined" when the real cross-property sum was 1,009). Quote per-row figures, or
  run a SQL SUM and cite that.
- Data quality flags are per SOURCE FILE (one property program), not per property. A
  property can have a rich rent roll overall while one program file is empty (134 has
  362 tenancies; only its land-program file is empty). Attribute a flag to the program
  file its detail names, never to the whole property, unless every one of its files
  carries the flag (altapm is the only truly empty property).

Rules:
- Call a tool for every real number. Never estimate, round from memory, or recall a
  figure from a previous tool call in this conversation without re-checking if the
  question is about a different property or metric. Wrong numbers in a real estate
  portfolio tool are worse than no answer.
- Call tools silently -- no "Let me check..." or "Now I'll pull..." narration before or
  between tool calls. The interface already shows the user each tool call as it runs.
  Write text only once you have what you need for the final answer.
- The dataset contains NO geography, market, location, or property-age information.
  Never invent or imply any (no "mid-Atlantic markets", no "urban assets"). More
  broadly: never attribute a characteristic to a property that a tool result did not
  actually contain.
- Never guess an ID. If you need a specific unit, use unit_lookup with the property_id
  and unit_number -- do not fish through unit lists or try plausible-looking unit_ids.
  If you genuinely cannot resolve an identifier, say so.
- When a question spans two data domains (revenue AND occupancy, leases AND
  delinquency), call a tool for each domain in the same turn -- never answer half of
  it from memory or from an earlier turn's results.
- When no tool covers the question, say so in one plain sentence and name what you CAN
  answer instead. Never pad a partial answer with filler to look complete. Categories
  this dataset can NEVER answer, refuse these outright: trends or changes over time
  (one snapshot), geography or market location, unit or resident history, demographics
  or anything about people beyond name, balance, and lease dates, and anything about
  properties outside this portfolio.
- Refer to properties by name AND code together on first mention, e.g. "Winners Circle
  (144)" -- the code is the real join key across the dataset, but nobody thinks in codes.
- Known data quality gap, mention it when relevant: properties 175 (Kinwood Apartments),
  176, 183, 184, and 185 have occupied/notice tenancies with real market rent but zero
  recorded charge lines in the source file -- their true revenue is understated in this
  dataset, not zero. If a question touches one of these properties' revenue, say so.
  Property 139 (The Mill Greenwich) has a smaller, partial version of the same gap.
- Only one snapshot is loaded -- there is no month-over-month trend data. Do not imply
  history or trajectory that isn't in the data.
- Be direct and concise. Lead with the number, then the context. No filler.
"""

TOOLS = [
    {
        "name": "list_properties",
        "description": "List all 15 properties in the portfolio with their property_id (the real join key) and canonical name. Use this to resolve a property name to its ID, or to see the full portfolio list.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_property",
        "description": "Detail for one property: canonical name, known name aliases, which revenue programs it has (residential/affordable/commercial/land), and the latest as-of date for its rent roll and unit availability data.",
        "input_schema": {
            "type": "object",
            "properties": {"property_id": {"type": "string", "description": "The property's numeric code, e.g. '144'"}},
            "required": ["property_id"],
        },
    },
    {
        "name": "portfolio_revenue",
        "description": "Portfolio-wide gross revenue, concessions, and net effective revenue, plus a per-property breakdown sorted by net effective revenue, plus a breakdown by charge category (base_rent, ancillary, utility, commercial, subsidy, fee, concession).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "revenue_concentration",
        "description": "Portfolio gross revenue broken down by program type (residential/affordable/commercial/land) -- the concentration-risk view: what share of income depends on subsidized vs market-rate vs commercial tenants.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "property_revenue",
        "description": "Revenue for one specific property: gross, concessions, net effective, and a breakdown by charge category.",
        "input_schema": {
            "type": "object",
            "properties": {"property_id": {"type": "string", "description": "The property's numeric code, e.g. '144'"}},
            "required": ["property_id"],
        },
    },
    {
        "name": "leases_expiring",
        "description": "Leases expiring within a window of days AFTER the data's as-of date -- forward-looking only, it cannot see leases that already expired. For leases whose expiration date is already in the past (expired-but-still-occupied holdovers), use leases_holdover instead. Returns resident, unit (with unit_id for drill-down), property name, expiration date, and market rent.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "Lookout window in days. Defaults to 60."},
                "property_id": {"type": "string", "description": "Optional: scope to one property's numeric code."},
            },
        },
    },
    {
        "name": "leases_holdover",
        "description": "Occupied tenancies whose lease expiration date is already in the PAST relative to the as-of date -- residents who stayed on after their lease term lapsed ('expired, never renewed'). There are 331 of these portfolio-wide, some expired by over a decade. This is the right tool for 'which leases already expired', 'holdover tenants', or month-to-month risk questions; leases_expiring cannot see these.",
        "input_schema": {
            "type": "object",
            "properties": {"property_id": {"type": "string", "description": "Optional: scope to one property's numeric code."}},
        },
    },
    {
        "name": "delinquent_tenancies",
        "description": "Tenancies with a positive balance owed (delinquent). Portfolio-wide by default, or scoped to one property, optionally filtered to balances above a minimum.",
        "input_schema": {
            "type": "object",
            "properties": {
                "min_balance": {"type": "number", "description": "Only return balances strictly greater than this. Defaults to 0 (any positive balance)."},
                "property_id": {"type": "string", "description": "Optional: scope to one property's numeric code."},
            },
        },
    },
    {
        "name": "anomalies",
        "description": "Data quality flags caught at load time: empty properties, missing charge data, implausible dates, unit-availability mismatches, etc. Portfolio-wide by default, or scoped to one property.",
        "input_schema": {
            "type": "object",
            "properties": {"property_id": {"type": "string", "description": "Optional: scope to one property's numeric code."}},
        },
    },
    {
        "name": "occupancy_portfolio",
        "description": "Portfolio-wide occupancy: total units, occupied, vacant, on-notice, and percent occupied, plus a per-property breakdown.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "occupancy_property",
        "description": "Occupancy for one specific property: units, occupied, vacant, on-notice, percent occupied, average rent, average square footage.",
        "input_schema": {
            "type": "object",
            "properties": {"property_id": {"type": "string", "description": "The property's numeric code, e.g. '144'"}},
            "required": ["property_id"],
        },
    },
    {
        "name": "property_units",
        "description": "Unit-level list for one property: every unit with its type, square footage, status (occupied/notice/vacant/model/down), resident, market rent, balance, and lease expiration.",
        "input_schema": {
            "type": "object",
            "properties": {"property_id": {"type": "string", "description": "The property's numeric code, e.g. '144'"}},
            "required": ["property_id"],
        },
    },
    {
        "name": "unit_detail",
        "description": "Full detail for one unit by its internal unit_id: dimensions, tenancy facts (deposits, move-in/out dates), and the actual charge line items with categories. unit_id comes from property_units, delinquent_tenancies, leases_expiring, or leases_holdover results. If you only have a unit NUMBER (like '328-104'), use unit_lookup instead -- never guess a unit_id.",
        "input_schema": {
            "type": "object",
            "properties": {"unit_id": {"type": "integer", "description": "Internal unit ID from a prior tool result"}},
            "required": ["unit_id"],
        },
    },
    {
        "name": "unit_lookup",
        "description": "Resolve a unit by property code + the human-readable unit number (e.g. property 139, unit '328-104') straight to the same full detail unit_detail returns: tenancy facts, deposits, dates, and charge line items. Use this whenever you have a unit number but not its internal unit_id.",
        "input_schema": {
            "type": "object",
            "properties": {
                "property_id": {"type": "string", "description": "The property's numeric code, e.g. '139'"},
                "unit_number": {"type": "string", "description": "The unit number as displayed, e.g. '328-104'"},
            },
            "required": ["property_id", "unit_number"],
        },
    },
    {
        "name": "portfolio_stats",
        "description": "Portfolio-wide proof-of-rigor counts: number of properties, tenancies, charges, data quality flags, charge-total mismatches, holdover leases, loader errors.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "rent_summary",
        "description": "Per-property rent aggregates, precomputed: average market rent across occupied/notice tenancies, billable tenancy count, occupied square footage, net effective revenue, and revenue per square foot. Use this for 'average rent', 'rent per square foot', or per-property efficiency questions instead of computing from raw rows.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "delinquency_summary",
        "description": "Delinquency rolled up per property (count, total balance, largest single balance) plus portfolio totals. Use this for 'how much is owed', 'which property has the worst delinquency' style questions instead of summing raw rows yourself.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "query_database",
        "description": (
            "Run ONE read-only SQL SELECT against the portfolio database when no other tool covers the "
            "question. The exact query is shown to the user as the receipt for how the number was computed, "
            "so keep it simple and readable. A LIMIT is enforced server-side. Schema: "
            "properties(property_id, canonical_name); "
            "units(unit_id, property_id, program_type, unit_number, unit_type, sq_ft); "
            "tenancies(tenancy_id, unit_id, snapshot_id, section['current'|'future'], status['occupied'|'notice'|'vacant'|'model'|'down'], "
            "resident_name, market_rent, resident_deposit, other_deposit, move_in, lease_expiration, move_out, balance); "
            "charges(charge_id, tenancy_id, charge_code, amount); "
            "charge_codes(code, category, description); "
            "data_quality_flags(flag_id, property_id, flag_type, detail, pct_value); "
            "unit_availability_snapshots(property_id, total_units, occupied_no_notice, vacant_rented, vacant_unrented, notice_rented, notice_unrented, avg_rent, avg_sq_ft). "
            "Prefer these views, which already resolve latest-snapshot-per-property: "
            "v_effective_revenue_by_property(property_id, gross_revenue, concessions, net_effective_revenue); "
            "v_revenue_by_property_category(property_id, category, total_amount); "
            "v_lease_expirations(tenancy_id, unit_id, property_id, canonical_name, unit_number, resident_name, lease_expiration, market_rent); "
            "v_delinquent_tenancies(same columns plus balance). "
            "If you query tenancies/charges directly you MUST scope to the latest snapshot via the views or you will double count."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"sql": {"type": "string", "description": "A single SELECT statement"}},
            "required": ["sql"],
        },
    },
]

# Plain-English label shown in the frontend's "thinking" line while a tool call is in
# flight -- real, driven by the actual tool name + args the model chose, not faked.
# tool name -> its schema description, for the Verify modal's HOW THIS WORKS line
TOOL_DESCRIPTIONS = {t["name"]: t["description"] for t in TOOLS}

_LABELS = {
    "list_properties": lambda a: "Listing properties",
    "get_property": lambda a: f"Looking up property {a.get('property_id', '')}",
    "portfolio_revenue": lambda a: "Pulling portfolio revenue",
    "revenue_concentration": lambda a: "Checking revenue concentration by program type",
    "property_revenue": lambda a: f"Checking revenue for {a.get('property_id', '')}",
    "leases_expiring": lambda a: f"Checking leases expiring in {a.get('days', 60)} days"
        + (f" at {a['property_id']}" if a.get("property_id") else " portfolio-wide"),
    "leases_holdover": lambda a: "Checking expired-but-occupied holdover leases"
        + (f" at {a['property_id']}" if a.get("property_id") else " portfolio-wide"),
    "delinquent_tenancies": lambda a: "Checking delinquent balances"
        + (f" at {a['property_id']}" if a.get("property_id") else " portfolio-wide"),
    "anomalies": lambda a: "Checking data quality flags"
        + (f" at {a['property_id']}" if a.get("property_id") else " portfolio-wide"),
    "occupancy_portfolio": lambda a: "Checking portfolio occupancy",
    "occupancy_property": lambda a: f"Checking occupancy for {a.get('property_id', '')}",
    "property_units": lambda a: f"Pulling units for {a.get('property_id', '')}",
    "unit_detail": lambda a: f"Looking up unit {a.get('unit_id', '')}",
    "unit_lookup": lambda a: f"Looking up unit {a.get('unit_number', '')} at {a.get('property_id', '')}",
    "rent_summary": lambda a: "Pulling rent aggregates by property",
    "delinquency_summary": lambda a: "Pulling the delinquency rollup",
    "query_database": lambda a: "Running a query",
    "portfolio_stats": lambda a: "Pulling portfolio stats",
}


def describe_tool_call(name, args):
    fn = _LABELS.get(name)
    return fn(args) if fn else f"Calling {name}"


# ── grounding check ──────────────────────────────────────────────────────────────
# Every hallucination the QA pass found was a specific, checkable claim (a dollar
# figure, a property name, a made-up location). Names/locations are now handled by
# giving the model correct data and telling it not to invent attributes -- there's no
# mechanical way to verify a proper noun. But dollar amounts and percentages ARE
# mechanically checkable: after the model writes its final answer, every $ and %
# figure it stated gets compared against the actual tool results returned this turn
# (with tolerance, since "$7.56M" is a legitimate rounding of 7,559,862.25). Anything
# that doesn't trace back to real data gets flagged to the frontend and logged --
# never silently trusted, same "surface it, don't hide it" principle as the
# data_quality_flags table.

_DOLLAR_RE = re.compile(r"\$\s?([\d,]+\.?\d*)\s?([KkMmBb])?\b")
_PERCENT_RE = re.compile(r"(\d+\.?\d*)\s?%")
_SUFFIX_MULT = {"k": 1e3, "m": 1e6, "b": 1e9}


def _extract_claims(text):
    """Returns a list of (kind, raw_matched_text, parsed_value)."""
    claims = []
    for m in _DOLLAR_RE.finditer(text):
        value = float(m.group(1).replace(",", ""))
        mult = _SUFFIX_MULT.get((m.group(2) or "").lower(), 1)
        claims.append(("dollar", m.group(0).strip(), value * mult))
    for m in _PERCENT_RE.finditer(text):
        claims.append(("percent", m.group(0).strip(), float(m.group(1))))
    return claims


def _flatten_numbers(obj, out):
    """Recursively collects every numeric value out of a tool result (dict/list of
    dicts), plus its absolute value -- a concession or balance is often stored signed
    in the data but stated as a plain positive figure in prose ('$144K in
    concessions' for a stored -144087.14)."""
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        out.add(float(obj))
        out.add(abs(float(obj)))
    elif isinstance(obj, dict):
        for v in obj.values():
            _flatten_numbers(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _flatten_numbers(v, out)


def _is_grounded(kind, value, numbers, rel_tol=0.02):
    """A claim is grounded if it's within tolerance of some number the model actually
    saw -- covers exact figures and rounded/abbreviated ones like $7.56M for
    7,559,862.25. Deliberately NOT doing ratio-of-any-two-numbers matching for percent
    claims (e.g. treating 88.4% as grounded because SOME pair in the pool happens to
    divide out near that value): with a dozen-plus numbers in a typical tool result,
    the pairwise ratio space is dense enough that an accidental match near almost any
    target percentage is common, not rare -- caught by test_fabricated_percentage_is_
    flagged in tests/test_chat_grounding.py, which is exactly the false-negative this
    would reintroduce. The accepted tradeoff: a genuinely correct derived percentage
    that isn't literally present in the source data (e.g. computed by the model from
    two raw amounts) gets flagged too. For a trust check, a false positive that just
    says "couldn't verify" is the safe failure mode -- a false negative that waves a
    fabricated number through is not."""
    tol = max(1.0, rel_tol * abs(value))
    return any(abs(value - n) <= tol for n in numbers)


def _check_grounding(text, tool_numbers):
    """Returns the list of claim strings (e.g. '$178,806.41', '14.3%') that could not
    be traced to any tool result returned this turn. Deliberately no early-exit on an
    empty tool_numbers set -- a $ or % claim made with zero tool calls this turn is
    exactly the case this exists to catch, not a reason to skip checking."""
    unverified = []
    for kind, raw, value in _extract_claims(text):
        if not _is_grounded(kind, value, tool_numbers):
            unverified.append(raw)
    return unverified


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


_client = None


def get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key or api_key == "your-key-here":
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set. Add your real key to the .env file at "
                "the project root."
            )
        _client = Anthropic(api_key=api_key)
    return _client


def _open_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _truncate_for_model(result, limit=MODEL_LIST_CAP):
    """Trims long lists before they go into the model's tool_result content -- the
    frontend still gets the full, untouched result via the separate tool_result SSE
    event below, so nothing the user sees is capped, only what costs tokens."""
    if isinstance(result, list):
        if len(result) > limit:
            return result[:limit] + [{"_truncated_note": f"{len(result) - limit} more rows omitted here (shown in full on screen)"}]
        return result
    if isinstance(result, dict):
        out = {}
        for k, v in result.items():
            if isinstance(v, list) and len(v) > limit:
                out[k] = v[:limit] + [{"_truncated_note": f"{len(v) - limit} more rows omitted here (shown in full on screen)"}]
            else:
                out[k] = v
        return out
    return result


def _sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def stream_chat(history, tool_dispatch):
    """Generator of SSE-formatted strings. `tool_dispatch` maps tool name ->
    callable(args_dict, conn) -> JSON-serializable result, built in main.py from the
    handler functions that already exist there."""
    try:
        client = get_client()
    except Exception as e:
        yield _sse("error", {"message": str(e)})
        return

    messages = [{"role": m.role, "content": m.content} for m in history]
    # every numeric value seen in any tool result this turn (across every iteration of
    # the loop below) -- the pool the final answer's $ and % claims get checked against
    turn_numbers = set()

    for _ in range(MAX_TOOL_ITERATIONS):
        try:
            with client.messages.stream(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=messages,
            ) as stream:
                for event in stream:
                    if event.type == "content_block_delta" and event.delta.type == "text_delta":
                        # deterministic backstop for the no-dash rule: the prompt asks,
                        # this enforces. A dash is a single character, so it can never
                        # be split across two deltas.
                        yield _sse("text_delta", {"text": event.delta.text.replace("—", ", ").replace("–", ", ")})
                final_message = stream.get_final_message()
        except Exception as e:
            yield _sse("error", {"message": str(e)})
            return

        messages.append({"role": "assistant", "content": final_message.content})

        if final_message.stop_reason != "tool_use":
            final_text = "".join(b.text for b in final_message.content if b.type == "text")
            unverified = _check_grounding(final_text, turn_numbers)
            if unverified:
                logger.warning("Unverified claim(s) in chat response: %s | text=%r", unverified, final_text)
                yield _sse("grounding", {"unverified": unverified})
            yield _sse("done", {})
            return

        tool_result_blocks = []
        for block in final_message.content:
            if block.type != "tool_use":
                continue
            # args included so the frontend's Verify modal can show exactly what was
            # requested, not just a friendly label
            # label for the live chip, args + the tool's own schema description for
            # the Verify modal -- so "how this works" is the same text the model
            # itself read when choosing the tool, not a separate copy to drift
            yield _sse("tool_call", {
                "tool": block.name,
                "label": describe_tool_call(block.name, block.input),
                "args": block.input,
                "description": TOOL_DESCRIPTIONS.get(block.name, ""),
            })

            conn = _open_conn()
            is_error = False
            try:
                fn = tool_dispatch.get(block.name)
                if fn is None:
                    raise ValueError(f"Unknown tool: {block.name}")
                result = fn(block.input, conn)
                # full, untouched result -> frontend, rendered as a table/chart. This
                # never passes through the LLM, so it costs zero extra tokens.
                yield _sse("tool_result", {"tool": block.name, "result": result})
                _flatten_numbers(result, turn_numbers)
                content = json.dumps(_truncate_for_model(result), default=str)
            except Exception as e:
                is_error = True
                content = str(e)
            finally:
                conn.close()

            block_result = {"type": "tool_result", "tool_use_id": block.id, "content": content}
            if is_error:
                block_result["is_error"] = True
            tool_result_blocks.append(block_result)

        messages.append({"role": "user", "content": tool_result_blocks})

    yield _sse("error", {"message": "Stopped after too many tool calls in a row."})
