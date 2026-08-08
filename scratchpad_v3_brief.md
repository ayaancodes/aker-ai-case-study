# v3: Aker palette everywhere, dashboard restyled like Aker's real product, copilot polish

## Context
Read `CLAUDE.md` and `HANDOFF.md` first. Current state: copilot.html carries the Aker
charcoal-green palette via `.copilot-page` CSS variable overrides and the user loves
it. The dashboard still has the old cyan look. Reference for everything visual in
this brief: Aker's own AM Dashboard product screenshot (described precisely below,
since you can't see it). The copilot works well but has pacing, prose, scroll, and
table-size issues listed below.

## 1. Roll the Aker palette out to the whole app
The `.copilot-page` variable overrides in `web/style.css` (charcoal-green void, cream
ink, #7FC79B green accent, #C9A96A amber, green --grad) become the app-wide `:root`
values. Kill the cyan theme entirely; delete the now-redundant `.copilot-page` scope.
Check every hardcoded cyan/blue left outside variables (canvas chart gradients in
shared.js and dashboard.js draw with literal #6fd2ff/#3fa9e8 strings, the donut
CATEGORY_COLORS map, particle field colors in app.js, tick-flash keyframe, chip
backgrounds with rgba(111,210,255,...)). Convert those to the green family. Landing,
dashboard, how-it-works, copilot: one colourway.

## 2. Restyle the dashboard toward Aker's real AM Dashboard screenshot
What their screenshot shows, adapted honestly to our single-snapshot data:
- Header block above the KPI strip: small eyebrow label ("AM DASHBOARD"), big title
  ("Portfolio intelligence"), a row of small chips with real facts (15 properties,
  4,106 tenancies, as-of date), and status chips on the right computed from real
  data quality flags: "N Healthy" (properties with zero flags) and "N Watch"
  (properties carrying missing_charges/implausible_dates/etc flags), green and amber
  dots respectively. All real, queryable from /anomalies + /properties.
- KPI cards get their look: icon chip top-left, label, big number, and a subdued
  mini-visual at the bottom of the card. IMPORTANT HONESTY CONSTRAINT: their cards
  show month-over-month trend sparklines; we have ONE snapshot and will not fake a
  time series. Keep our composition mini-bars but restyle them into their soft
  area/graph aesthetic (thin line + soft gradient fill under it, drawn from the
  per-property distribution rather than time). No "+1.0% MoM" style deltas, ever.
- Tab-style chips under the KPI strip (like their Overview / Financial /
  Operational) to switch the portfolio charts between existing views: Overview
  (revenue + occupancy by property), Financial (revenue mix + concentration donuts),
  Risk (delinquency + rollover lists). Same data, less vertical stacking, more
  product feel. Property drill-down stays as is.
- An "AM Copilot signals" style card in the portfolio view (like their screenshot's
  right-hand card): 2-3 short real findings pulled from /anomalies and /stats (the
  $2.05M missing-charges gap, 331 holdover leases, the 2626 date typo), each with
  small tag chips, and a "View evidence" link that goes to how-it-works.html#anomalies
  or opens the copilot with the question pre-filled. Real data only, no invented
  narrative.
- Sidebar: add a PRODUCT SUITE block ABOVE the property finder, exactly like their
  screenshot's left rail: "AM Dashboard" (active) and "AM Copilot" links styled like
  the copilot page's side links (this is also the "embed the copilot as a bar on the
  left, on top of the property finder" ask). The PROPERTIES search/list stays below it.

## 3. Copilot chat fixes
- **Slower, downward generation.** Cut the typewriter rate roughly in half
  (CHARS_PER_SEC 150 -> ~70-80) so it visibly writes down the page. Keep time-based
  pacing and click-to-skip exactly as they are.
- **De-AI the prose.** The model's answers read AI-generated. System prompt changes
  in api/chat.py: no em dashes in responses, ever (the project-wide rule applies to
  the model too). Short plain sentences, one idea per sentence. Numbers rounded in
  prose ($7.56M, not $7,559,862.25) since the card carries exact figures. Lead with
  the answer, put the caveat second. Ban the "X leads at A, followed by B at C, and
  D at E" enumeration pattern outright; the card shows the ranking.
- **Scroll behavior.** Auto-scroll currently fights the user: it forces the bottom on
  every tick. Only auto-scroll while the user is already within ~80px of the bottom;
  if they scrolled up to read, leave them alone until the next turn starts. Test by
  scrolling up mid-generation.
- **Table caps, two layers.**
  (a) Client: chat table cards cap at 10 rows with the existing "+ N more" note, and
  get an inner max-height (~320px) with overflow-y auto so a long card scrolls inside
  itself instead of stretching the thread.
  (b) Server: add an explicit limit to the list endpoints the chat calls most
  (/delinquent, /leases/expiring, /leases/holdover, /properties/{id}/units): a
  `limit` query param defaulting to something sane (50) plus a returned `total_count`
  so both the model and the card can say "showing 50 of 705" honestly. Update the
  tool schemas so the model knows the limit exists and that asking for "all tenants"
  will return a capped list with a total. Keep MODEL_LIST_CAP as the second fence.
  Add tests for limit + total_count on each endpoint touched.

## 4. Make the AI more confident and better tooled (design decisions, implement what's checked)
The failure mode to kill: plausible-sounding synthesis beyond what tools returned.
Directions to implement, in priority order:
- **Aggregate tools instead of raw-list synthesis.** The model currently gets raw
  rows and does its own mental math. Add small aggregate endpoints/tools where
  questions actually cluster: revenue per square foot by property (computable:
  charges + sq_ft), average market rent by property/unit type (tenancies), unit-mix
  summary per property (unit_type counts), delinquency summary (count, total, max,
  per-property split). Each is one focused SQL view/endpoint + tool + test, same
  pattern as /leases/holdover. Aggregates mean the number the model cites IS a tool
  output, which also makes the grounding check hit instead of miss.
- **Tool-coverage refusals.** Extend the system prompt's refusal rule with a short
  list of what the dataset genuinely cannot answer (trends over time, geography,
  unit-level history, anything about people beyond name/balance/dates) so the model
  refuses by category, not by luck.
- **Confidence framing.** When a tool result is partial (a missing_charges property,
  a truncated list), the model must say so in the first sentence, not as a trailing
  note. Add to system prompt.
Do NOT add speculative tools nobody asked about (no forecasting, no what-if). Every
new tool needs: endpoint + view if needed, TOOLS schema entry, _LABELS entry,
TOOL_DISPATCH entry, a card renderer case in chat.js, and a pytest.

## Verify before done
- Palette: screenshot landing, dashboard, copilot, how-it-works; zero cyan remnants
  (grep for 6fd2ff / 3fa9e8 / 111,210,255 in web/).
- Dashboard: Healthy/Watch counts match /anomalies reality (property count with and
  without flags); signals card facts each traceable to an endpoint; tabs switch views
  without re-fetching (data is already cached in PORTFOLIO).
- Copilot: ask "show me all tenants at winners circle" and confirm capped table +
  "showing N of M" honesty end to end (server cap, card cap, model phrasing); scroll
  up mid-generation and confirm the thread stops yanking to the bottom; confirm no em
  dash appears in five consecutive model answers.
- pytest suite green (48 + whatever you add). Update HANDOFF.md palette references.

## Ground rules
No em dashes anywhere. Small commits, pushed frequently. No co-author lines. Don't
touch loader/schema beyond any new aggregate views. Delete this file when done and
report observed behavior with the actual questions asked.
