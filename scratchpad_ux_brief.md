# UX polish pass: nav clarity, copilot chrome, Verify modal depth

## Context
Read CLAUDE.md and HANDOFF.md first. This is a small, targeted UX pass on top of
everything already built (dashboard, copilot chat with tool calling + Verify
receipts + grounding checks). Nothing here touches the ETL, schema, or backend logic
except the one Verify-modal enhancement below, which is additive.

## 1. Remove "AM Copilot" button from the dashboard's top-right nav
`web/dashboard.html`'s `<nav id="nav">` has a `btn btn-grad` linking to copilot.html
next to the live clock. Remove it -- the left sidebar's PRODUCT SUITE block is
already the nav for switching between AM Dashboard and AM Copilot; having the same
destination reachable from two different chrome elements is redundant.

## 2. Make the two products visually distinct in the sidebar
Right now `AM Dashboard` and `AM Copilot` are two plain text links in a list, same
weight, same style, differing only by an `.on` state. Give AM Copilot a small
distinguishing mark next to its label -- a sparkle/spark icon (small inline SVG,
consistent with the other icon usage in this app, no external icon library) -- so
the AI-powered product reads as a different kind of thing from the dashboard.
Applies to the sidebar on BOTH dashboard.html and copilot.html (the PRODUCT SUITE
block exists on both). Reasonable place for the icon: inline, left of the label
text or as a small badge after it -- try both, pick whichever reads cleaner at the
sidebar's width.

## 3. Copilot page sidebar: back-to-dashboard only, no other nav
Currently copilot.html's sidebar lists Home, AM Dashboard, AM Copilot (on), How
it's built. Simplify to a single "&larr; Back to dashboard" link/button at the top
of the sidebar (styled distinctly from a regular nav link, e.g. like
`.dash-back` already used elsewhere in this app) -- once you're in the copilot,
the only planned exit is back to the dashboard, not a full site nav. Keep the
PRODUCT SUITE label and the sparkle-marked AM Copilot indicator (item 2) if it
still makes sense once this is simplified; use judgment on whether the label is
still needed with only one destination.

## 4. Verify modal: explain what each tool call actually does, not just dump args
Real observed problem: a call like `rent_summary` currently renders as:
```
01  Pulling rent aggregates by property     rent_summary
    no parameters
```
"no parameters" reads as broken/empty, especially compared to a `query_database`
call which shows a full SQL query right there. Every tool call deserves an
explanation of HOW it computes its answer, whether or not it takes arguments.

Implementation: `api/chat.py`'s `TOOLS` list already has a `description` field per
tool (used for the model's own tool selection) -- these descriptions are detailed
and accurate (e.g. rent_summary's says exactly what it averages and where it comes
from). Thread that description through to the frontend: either (a) include it in
the `tool_call` SSE event payload alongside `tool`/`label`/`args` so `web/chat.js`
already has it without a new fetch, or (b) keep a small `TOOL_DESCRIPTIONS` map
client-side in chat.js mirroring the backend ones (more duplication, avoid if (a)
is easy). Prefer (a).

In the Verify modal (`openVerifyModal` in chat.js, `.verify-call` markup in
style.css), render that description as a "HOW THIS WORKS" line under the args/SQL
block for every call -- always visible, not click-to-expand (a modal that's already
open doesn't need a second layer of clicking to see one more line of text). For
`query_database` calls, the SQL stays as the primary "how" and the tool's generic
description can be a shorter sub-line above it (query_database's own description
is generic -- "runs one read-only SELECT" -- so lead with the SQL, not the
description, for that one tool specifically).

Concretely, for the rent_summary example above, this should end up rendering
something like:
```
01  Pulling rent aggregates by property                    rent_summary
    no parameters
    HOW THIS WORKS: Per-property rent aggregates -- average market rent across
    occupied/notice tenancies, net effective revenue, and revenue per occupied
    square foot. Latest snapshot per property.
```
(exact wording = the tool's existing `description` string, don't rewrite it, just
surface it.)

## Verify before done
- Screenshot dashboard.html and copilot.html nav/sidebar before and after.
- Open Verify on a multi-tool-call answer (e.g. ask "revenue concentration then
  commercial residential split") and confirm every call -- including no-arg ones --
  shows a HOW THIS WORKS line.
- Confirm copilot.html's sidebar only offers a path back to the dashboard, nothing
  else, and that this doesn't strand the user (dashboard nav still has Home / How
  it's built / AM Copilot as before -- only the copilot page's own sidebar is
  narrowed).
- pytest suite still green (no backend logic should have changed except threading
  an existing description string through the SSE payload, which needs no new test
  but shouldn't break existing ones).

---

## 5. how-it-works.html: a real bottom-up architecture diagram, and a Pipeline that
## deepens on scroll instead of staying a static 4-icon strip

This is the big one. Ayaan wants to actually learn the stack through this page, not
just look at it, so accuracy matters as much as motion -- every diagram node and
every "deeper dive" panel must point at a real file/table/function, not an
illustration of a generic pipeline. Read `db/schema.sql`, `scripts/etl/rent_roll_parser.py`,
`scripts/load_data.py`, `api/main.py`, and `api/chat.py` before building this --
the content comes from those files, not from invention.

### 5a. Bottom-up architecture diagram (new section, replaces or sits alongside the
existing 3-card `.pillars` grid in `web/how-it-works.html`)

Build it bottom-up, literally stacked with the foundation at the bottom of the
screen and each layer built on top of it as you scroll up through the section (or
scroll down reveals it top-down with the diagram itself drawn bottom-up -- either
reads fine, pick whichever animates cleaner). Layers, in order:

1. **Source data** -- 50 Excel files (25 Rent Roll + 25 Unit Availability), shown as
   a small stack of file icons.
2. **ETL / loader** -- `scripts/load_data.py` + `scripts/etl/rent_roll_parser.py` +
   `scripts/etl/unit_availability_parser.py` + `scripts/etl/filenames.py` +
   `scripts/etl/db.py`. Label this layer with what it actually does: parse, validate
   inline (charge-total checks, missing_charges, implausible_dates, idempotent
   reconciliation), write.
3. **Database** -- SQLite, `db/aker.db`, built from `db/schema.sql`. Show the real
   table names as small connected nodes: properties, units, tenancies, charges,
   charge_codes, data_snapshots, data_quality_flags, unit_availability_snapshots,
   loader_errors -- plus the hot-path views (v_effective_revenue_by_property,
   v_delinquent_tenancies, v_lease_expirations, v_latest_rent_roll_snapshot). A
   small ER-style connector diagram, not just a list.
4. **API layer** -- `api/main.py` (every REST endpoint, grouped: properties,
   revenue, occupancy, leases, delinquent, anomalies, metrics, /query) and
   `api/db.py` (read-only connection). Note honestly that this layer is pure SQL,
   no LLM involved.
5. **AI layer** -- `api/chat.py`: the TOOLS schema list, the agent loop, the
   grounding check. This is the only layer where an LLM appears at all -- make that
   visually distinct (different accent, e.g. the existing --warn amber or a
   dedicated AI glow) so it's clear the "AI" is a thin layer on top of a normal API,
   not the whole system.
6. **Surfaces** -- dashboard.html and copilot.html, both shown as consuming the SAME
   API layer (this is the "One API, every surface" claim already in the existing
   pillar card -- make it a real visual fact, two boxes with arrows from the same
   API layer, not just a caption).

Interaction: as each layer scrolls into view, animate it drawing in (the existing
`.reveal`/`.stagger` classes + IntersectionObserver pattern in `web/shared.js` is
the right mechanism, reuse it) with a moving connector -- a small dot or pulse
traveling along the line from the layer below into the layer above, timed to
suggest data flowing upward through the stack as you scroll. Reuse the dashed-line
`.loop-track::before` `repeating-linear-gradient` technique already in style.css
for the connector lines themselves; add a genuinely moving element (translate along
the path, not just a static dashed line) for the "something is flowing" feel Ayaan
asked for.

### 5b. Pipeline section deepens instead of staying static

Currently `#loop` in `web/how-it-works.html` is a static 4-node strip (INGEST /
VALIDATE / STRUCTURE / UNDERSTAND, `web/style.css` `.loop-track`/`.loop-node`).
Keep this top-level strip exactly as it is -- it's a good compressed summary -- but
make each node openable (click, or scroll-triggered expansion, pick whichever
feels less janky) into a deeper panel with REAL content for that stage:

- **01 INGEST**: show one real raw row from an actual source file (e.g. the
  176r row already documented in CLAUDE.md/HANDOFF: unit 1101, market rent 1711,
  zero charges) next to the filename-derived identity logic in
  `scripts/etl/filenames.py` (how "176r" becomes property_id=176,
  program_type=residential).
- **02 VALIDATE**: show 2-3 real checks from `scripts/load_data.py` as they'd
  appear against real data -- charge-total-vs-stated-Total reconciliation, the
  missing_charges threshold check, implausible_dates. Use REAL numbers already
  established and independently verified this session (175: 373 of 375 zero-charge
  tenancies; 143 unit 1-114's 2626-06-30 typo; 153c's unit-availability mismatch,
  0 vs 7). These are proven-true, not invented for the demo.
- **03 STRUCTURE**: show an actual trimmed snippet of `db/schema.sql` (e.g. the
  `tenancies` table definition) with a couple of its columns visually mapped back
  to the raw Excel columns they came from -- a real before/after, not abstract art.
- **04 UNDERSTAND**: show one real endpoint call and response shape (e.g.
  `GET /revenue/portfolio` -> its JSON shape) transitioning into a copilot tool
  call using that same endpoint (`portfolio_revenue` tool -> same data). This is
  the "one API, every surface" claim made concrete at the pipeline-step level too.

Animation for the expansion: the connector dots along `.loop-track::before` should
visibly travel toward whichever node is expanded (again, a moving element, not a
static dash pattern) before the panel opens, so it reads as "data flowing into this
stage" rather than an accordion just popping open.

### Verify before done (section 5 specifically)
- Every number, filename, column name, and code snippet shown anywhere in the new
  diagram or the expanded pipeline panels must be checked against the real file
  it's supposedly from -- open the file, confirm the exact text, don't paraphrase
  from memory. This section exists so Ayaan can learn the real system; a plausible
  fabrication defeats the entire point and would be worse than not building it.
- Confirm reduced-motion users get the fully-expanded, non-animated version
  immediately (existing `REDUCED` check pattern in shared.js/chat.js).
- Screenshot the full scroll sequence (collapsed strip -> expanding node -> full
  architecture diagram) for the record.

## Ground rules
No em dashes in written output. Small commits, pushed frequently. No co-author
lines. Delete this file when done and report back with screenshots/observed
behavior.
