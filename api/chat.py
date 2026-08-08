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
import os
import sqlite3

from anthropic import Anthropic
from dotenv import load_dotenv
from pydantic import BaseModel

from api.db import DB_PATH

load_dotenv()

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

The dashboard already renders every tool's raw result as a real table or bar chart the
instant the tool returns -- the user sees the actual numbers on screen before you finish
writing. Your job is NOT to restate the data. Write 1-3 short sentences: the direct
answer plus one genuine insight or caveat. Never use markdown headers or bullet lists.
You may bold at most one figure with **that** if it's the single number that matters.
Do not enumerate a list of properties/units/residents in prose -- the table already
shows them.

Rules:
- Call a tool for every real number. Never estimate, round from memory, or recall a
  figure from a previous tool call in this conversation without re-checking if the
  question is about a different property or metric. Wrong numbers in a real estate
  portfolio tool are worse than no answer.
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
        "description": "Leases expiring within a window of days from the data's latest as-of date. Portfolio-wide by default, or scoped to one property. Returns resident, unit, expiration date, and market rent for each.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "Lookout window in days. Defaults to 60."},
                "property_id": {"type": "string", "description": "Optional: scope to one property's numeric code."},
            },
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
        "description": "Full detail for one unit by its internal unit_id: dimensions, tenancy facts (deposits, move-in/out dates), and the actual charge line items with categories. Get unit_id from property_units first.",
        "input_schema": {
            "type": "object",
            "properties": {"unit_id": {"type": "integer", "description": "Internal unit ID, from property_units"}},
            "required": ["unit_id"],
        },
    },
    {
        "name": "portfolio_stats",
        "description": "Portfolio-wide proof-of-rigor counts: number of properties, tenancies, charges, data quality flags, charge-total mismatches, holdover leases, loader errors.",
        "input_schema": {"type": "object", "properties": {}},
    },
]

# Plain-English label shown in the frontend's "thinking" line while a tool call is in
# flight -- real, driven by the actual tool name + args the model chose, not faked.
_LABELS = {
    "list_properties": lambda a: "Listing properties",
    "get_property": lambda a: f"Looking up property {a.get('property_id', '')}",
    "portfolio_revenue": lambda a: "Pulling portfolio revenue",
    "revenue_concentration": lambda a: "Checking revenue concentration by program type",
    "property_revenue": lambda a: f"Checking revenue for {a.get('property_id', '')}",
    "leases_expiring": lambda a: f"Checking leases expiring in {a.get('days', 60)} days"
        + (f" at {a['property_id']}" if a.get("property_id") else " portfolio-wide"),
    "delinquent_tenancies": lambda a: "Checking delinquent balances"
        + (f" at {a['property_id']}" if a.get("property_id") else " portfolio-wide"),
    "anomalies": lambda a: "Checking data quality flags"
        + (f" at {a['property_id']}" if a.get("property_id") else " portfolio-wide"),
    "occupancy_portfolio": lambda a: "Checking portfolio occupancy",
    "occupancy_property": lambda a: f"Checking occupancy for {a.get('property_id', '')}",
    "property_units": lambda a: f"Pulling units for {a.get('property_id', '')}",
    "unit_detail": lambda a: f"Looking up unit {a.get('unit_id', '')}",
    "portfolio_stats": lambda a: "Pulling portfolio stats",
}


def describe_tool_call(name, args):
    fn = _LABELS.get(name)
    return fn(args) if fn else f"Calling {name}"


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
                        yield _sse("text_delta", {"text": event.delta.text})
                final_message = stream.get_final_message()
        except Exception as e:
            yield _sse("error", {"message": str(e)})
            return

        messages.append({"role": "assistant", "content": final_message.content})

        if final_message.stop_reason != "tool_use":
            yield _sse("done", {})
            return

        tool_result_blocks = []
        for block in final_message.content:
            if block.type != "tool_use":
                continue
            yield _sse("tool_call", {"tool": block.name, "label": describe_tool_call(block.name, block.input)})

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
