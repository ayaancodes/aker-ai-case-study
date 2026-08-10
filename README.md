# Aker AI: Round 2 Case Study

A relational schema, an ETL loader, an API, a dashboard, and a tool-calling chatbot,
all built on top of 50 real Excel exports (25 properties' worth of rent rolls and
unit availability reports).

**Live:** [aker-ai-terminal.onrender.com](https://aker-ai-terminal.onrender.com)
(free tier, so the first load after a while can take ~30s to wake up)

## The assignment

1. Design a relational database schema to store as much data as possible from the
   Excel files.
2. Develop a Python script to process all the files and load the data into the
   database.
3. Build a presentation layer (dashboard, LLM chatbot, or something else) that
   showcases skills.

## What's actually here

- **Schema** (`db/schema.sql`): properties, units, tenancies, charges, snapshot-based
  so a second month of data is purely additive, not a redesign.
- **Loader** (`scripts/load_data.py`, `scripts/etl/`): idempotent, identity derived
  from filenames rather than a hardcoded property list, validates charge totals live
  as it loads instead of trusting the source files.
- **API** (`api/main.py`): narrow single-purpose endpoints that double as the
  chatbot's tool definitions, so the dashboard and the copilot read through the exact
  same code path.
- **Dashboard** (`web/dashboard.html`): portfolio and per-property views, real charts,
  a revenue bridge, a commercial/residential risk split.
- **Copilot** (`web/copilot.html`, `api/chat.py`): tool-calling chat over the Claude
  API. Every answer carries a "Verify" receipt showing exactly which calls it made and
  why, and a grounding check flags any number that doesn't trace back to a real tool
  result.
- **How it's built** (`web/how-it-works.html`): the technical walkthrough, schema,
  pipeline, test suite output, and every data quality issue actually caught, not
  written up after the fact.

Fifteen properties came out of the 25 source files once duplicates and program
variants (residential/affordable/commercial) got resolved to the same physical
building. A handful of those files turned out to have real gaps in them (missing
charge data, impossible dates, a stale unit availability snapshot), and those are
documented and flagged automatically at load time rather than smoothed over. `CLAUDE.md`
has the full build log if you want the play-by-play.

## Running it locally

```bash
pip install -r requirements.txt
python3 scripts/load_data.py        # builds db/aker.db from the source Excel files
uvicorn api.main:app --reload       # serves the API + the frontend on :8000
```

The chatbot needs a real Anthropic API key. Drop `ANTHROPIC_API_KEY=your-key-here`
into a `.env` file at the project root (gitignored). Everything else works without it.

```bash
pytest tests/ -v   # 54 tests, no API key needed
```
