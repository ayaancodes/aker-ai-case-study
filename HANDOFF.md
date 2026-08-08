# HANDOFF — Aker AI Round 2 Case Study

If you are a fresh agent picking this up, read this whole file before touching anything.
`CLAUDE.md` is the auto-loaded build log (goal/approach/result per phase, in the order
things actually happened) and is the source of truth for what was built and why. This
file is the shorter, more direct briefing on top of it: what Ayaan actually wants, how
he wants to work, what's really done, and what's next.

---

## The assignment

1. Design a relational database schema to store as much data as possible from the Excel files.
2. Develop a Python script to process all the files and load the data into the database.
3. Build a presentation layer (dashboard, LLM chatbot, or something else) that showcases skills.

Deadline was Monday, August 10. Aker ASA is a real Norwegian investment company with
real estate holdings (Aker Property Group) and AI investments (stake in Nscale) — the
"investment fund lens" framing throughout this project is deliberate, not decorative.

---

## What Ayaan actually wants — read this carefully, it's the part that's easy to miss

- **He wants to see it working, not hear about it.** The single biggest source of
  friction this session was long planning/discussion cycles without visible output.
  When he says "keep busy," "go do a full rendition," or gives any kind of broad
  latitude, the right move is: build it, verify it against real data, report back
  concisely with what changed. Don't manufacture more clarifying questions to delay
  starting unless something is genuinely ambiguous or genuinely risky (data loss,
  destructive git ops, PII).
- **No mocked or fabricated numbers, anywhere, ever.** This is a hard rule, stated
  and re-stated across the whole session. Every number in the UI must trace back to a
  real API call against the real database. If real data can't support a feature (e.g. a
  multi-month trend line when only one month is loaded), say so explicitly and don't
  build a fake version of it.
- **Theatrics and dramatics matter, on purpose.** He said this directly: this is partly
  a demo, and a visually flat-but-correct dashboard undersells the work. Borrowing real
  visual language from real products (see Design Direction below) is the intended
  approach, not a shortcut — he gave explicit permission to reuse/adapt a friend's site
  (Vega, see `design-references/vega-reference.html`).
- **He will show you a screenshot from his actual browser and it is ground truth.**
  Early in the session a visual bug got initially misdiagnosed as "probably just the
  automated browser tool's rendering quirk" — the tool genuinely does have a real quirk
  (see note at the bottom of this file), but the bug the user was reporting was also a
  real CSS bug (a `mask-image` rendering issue) that needed to be found and fixed. Don't
  let a real tooling caveat become an excuse to dismiss a user-reported bug. Find the
  actual cause every time.
- **Ask before big pivots, then commit fully once agreed.** Schema shape, DB engine,
  framework choice, major visual/IA direction changes — flag and wait. But once a
  direction is confirmed, execute completely and show the result; don't re-litigate the
  same decision or keep asking smaller sub-questions about it.
- **Push to git constantly.** After nearly every discrete unit of work, not batched up.
  This has been the norm all session and should continue.
- Casual, direct tone. No em dashes anywhere in written output (comments, docs, chat).
  Never add a "Co-Authored-By" line to commits — author is Ayaan only.

---

## Current state (as of this handoff)

Everything below is built, tested against the real 25+25 source files, and pushed.

### Data layer
- **Schema** (`db/schema.sql`): properties, property_name_aliases, data_snapshots,
  units, tenancies, charges, charge_codes, unit_availability_snapshots,
  data_quality_flags, loader_errors. Snapshot-based design — a second month of data is
  purely additive, not a redesign. Property identity keyed on numeric code prefix
  (`134`, not `134c`/`134r`/`134land`), with `program_type` (residential/affordable/
  commercial/land) capturing what the suffix actually meant.
- **Loader** (`scripts/load_data.py` + `scripts/etl/`): idempotent (identity-based
  matching, not just filename — handles renames and removed files correctly), fully
  parses all 25 rent roll + 25 unit availability files, validates charge-line sums
  against stated totals live, writes data quality flags at load time.
- **36 pytest tests** (`tests/`), all passing — regression coverage for every bug found
  and fixed this session, plus known-good counts.
- **Verified numbers**: 15 properties (not 16 or 25), 4,106 tenancies, 9,177 charges,
  32 charge codes, zero charge-total mismatches, 11 data quality flags. Cross-validated
  independently against the raw Excel files using a second, differently-written parser
  (see CLAUDE.md section 6) — not just checked against the database's own internal
  consistency.
- **The raw Excel files and the built SQLite database (`db/aker.db`) are now committed
  to this repo**, per Ayaan's explicit instruction (previously kept local-only over PII
  concerns — he overrode that deliberately, don't re-exclude them without asking).

### Backend
`api/main.py` — FastAPI, read-only SQLite connection per request. Endpoints:
- `/properties`, `/properties/{id}`
- `/revenue/portfolio`, `/revenue/{id}`, `/revenue/concentration` (gross revenue by
  program_type — must stay declared *before* `/revenue/{id}` in the file, FastAPI
  matches routes in registration order and a literal path can get shadowed by an
  earlier variable one)
- `/occupancy/portfolio`, `/occupancy/{id}` — from `unit_availability_snapshots`,
  unused anywhere until this was built
- `/properties/{id}/units` — unit-level drill-down
- `/leases/expiring?days=N`, `/delinquent`, `/anomalies`, `/loader-errors`, `/stats`
- Static files (the `web/` directory) are mounted at `/` via FastAPI's StaticFiles,
  after every API route is declared, so it can't shadow them. One deployable service.

### Frontend — three pages, one shared design system
- **`web/index.html`** — the product landing page. Hero (particle-field background
  only, no chart competing with the headline), an interactive property explorer
  (search a property, watch a real gross → concessions → net effective waterfall
  animate in, see it ranked against the portfolio), revenue chart, revenue mix, risk
  panels, portfolio marquee. Login is a docked card over the visible hero (not a
  full-screen takeover), ~30-35% width on the right. Clicking Enter navigates to
  `dashboard.html`.
- **`web/dashboard.html`** — the actual analytics dashboard, reached after "login."
  Sidebar property picker + KPI strip. Default view is portfolio-wide (revenue by
  property, occupancy by property, revenue mix, concentration risk by program type,
  delinquency, lease rollover). **Selecting a property fully replaces the portfolio
  view** — not shown side by side, this was an explicit requirement — with that
  property's own KPIs, revenue waterfall, risk panels, and a **units table as a second
  drill-down layer** (every unit in that property, status, resident, rent, balance,
  lease expiration).
- **`web/how-it-works.html`** — the technical/proof page. Data quality stats,
  architecture pillars, pipeline diagram, a **test suite terminal showing real pytest
  output** (not fabricated), anomalies feed. This content used to be on the main
  landing page and was deliberately moved off it — Ayaan's words: "think of this as a
  product company trying to show you a really nice product, not the full breakdown of
  the app." One footer link away from the product page, not the first thing shown.
- **`web/shared.js`** — cursor-follow spotlight, magnetic buttons, reveal-on-scroll,
  count-up numbers, canvas helpers, the generic bar/donut chart drawing functions, the
  delinquent/lease list renderers. Used by all three pages so chart logic isn't
  duplicated.
- **`web/app.js`**, **`web/dashboard.js`**, **`web/technical.js`** — page-specific
  logic on top of `shared.js`.
- **`web/style.css`** — one stylesheet, all three pages, dark mode only (light mode was
  explicitly removed, don't reintroduce a theme toggle without being asked).

---

## Design direction — the visual language that was actually decided on

- **Dark mode only.** No toggle, no light theme CSS.
- **Typography**: Bricolage Grotesque for headings, JetBrains Mono for every number
  (this matters — it's what makes it read as a financial terminal), Instrument Sans for
  body copy.
- **Color**: near-black background, cyan accent (`#6fd2ff`), green/red for
  profit/loss-style signals, glass/blur cards.
- **Hero background**: a perspective particle-wave field, adapted directly from
  `design-references/vega-reference.html`'s canvas code (2D canvas version, not the
  Three.js one — simpler, no extra dependency). Full permission to reuse/adapt was
  granted by the site's owner (a friend of Ayaan's).
- **Copy tone**: plain and declarative, Robinhood/Wealthsimple register — short factual
  sentences, no "eyebrow" marketing badges, no persuasive section headlines. Explicitly
  *not* Vega's pitch-heavy marketing tone. Keep the visual theatrics (motion, real
  charts, huge type), drop the sales language.
- **Animation**: charts draw in from zero on scroll-into-view rather than appearing
  already-rendered, a subtle price-flash pulse on the ticker, a live-pulse dot next to
  the "AS OF" date, cursor-reactive magnetic buttons.
- **`design-references/vega-reference.html`** is the friend's actual site source,
  saved here for continued reference. There's also a FinRobot login screen (split
  layout, visual on one side + form on the other) that informed the docked-login-card
  pattern, and Robinhood's homepage that informed the copy tone — no local copies of
  those, just described in CLAUDE.md/this file.

---

## What's NOT done yet

1. **The LLM chatbot.** This is the big remaining piece and hasn't been started. Plan
   (unchanged from early in the project): Claude API (Anthropic), tool-calling against
   the existing FastAPI endpoints — the model calls defined endpoints, it never touches
   SQL directly, no raw text-to-SQL. The endpoints were deliberately kept narrow and
   single-purpose specifically so they'd double as clean tool definitions.
2. **Deployment.** Render or Railway, one service (FastAPI serving both API and the
   static frontend, which is already how it's structured locally).
3. **Not committed to, parked as a stretch goal only**: a 3D phone mockup à la Vega's
   phone showcase. Cool but expensive in time; only revisit if everything else is done
   early.

---

## Real bugs found and fixed this session — useful context so they don't get rediscovered

- **FastAPI route shadowing**: `/revenue/concentration` was declared after
  `/revenue/{property_id}` and always 404'd as "unknown property_id: concentration"
  until moved before it. Literal paths must be registered before variable ones that
  could also match.
- **INNER JOIN silently dropping properties with zero data**: `/revenue/portfolio` used
  to join from the revenue view (inner join on charges), so properties with zero
  recorded charges anywhere (176, 183, 184, 185, altapm) just vanished from the
  dashboard instead of showing as $0 — making the portfolio look smaller and healthier
  than it is. Fixed with `LEFT JOIN` + `COALESCE`. Same principle as the missing_charges
  flag: don't hide a gap, show it.
- **A real CSS `mask-image` bug caused visible text blur** in the user's actual Chrome/
  Safari, not just a tooling artifact. The old hero had a canvas (`#heroChart`) with a
  `mask-image` radial-gradient that rendered as a hazy blur over the headline. Fixed by
  removing that canvas entirely (also what was separately asked for — "keep the moving
  circles, remove the bar chart").
- **The docked login card didn't reserve layout space**, so the centered hero headline
  and full-width ticker ran straight through it at wide viewports (looked fine at one
  width by coincidence, broke at others). Fixed with a `gate-open` body class that
  shifts the hero content left instead of letting a `position:fixed` card just overlay
  on top of independently-centered text.
- **sqlite3 + FastAPI threading**: `check_same_thread=False` needed on the connection —
  FastAPI runs sync dependency generators through a thread pool, and open/close of one
  connection isn't guaranteed to land on the same worker thread.
- **The missing_charges validation check had the same blind spot it was built to catch**
  — see Data Quality Findings below, this is the big one.

---

## Data quality findings — the actual analytical substance, condensed

- **5 of 15 properties (175, 176, 183, 184, 185) have 100% or near-100% of occupied
  tenancies missing charge/revenue data entirely** despite real market rent, real
  residents, real lease dates. Found via the dashboard's revenue chart (Kinwood's bar
  was absurdly short), not the original investigation. Kinwood alone: $787,568/month in
  market rent with zero recorded revenue. Portfolio-wide the gap is ~$2M/month. An audit
  pass then found the fix itself had the identical blind spot for "notice" status
  tenants (still real residents, just giving notice) — 33 more affected, all inside
  properties already flagged, so even the flag's own counts were undercounting.
- **15 properties, not 16 or 25** — the a/c/r/land filename suffixes split one physical
  property across multiple files by revenue *program*, not by building. Match on
  numeric code prefix, never on name string (e.g. "55 Riverwalk Place" vs "Fifty-Five
  Riverwalk Place" are the same property, spelled two ways across its own files).
- **CON\* charge codes are 214/216 negative, not literally all** — confirmed by checking
  actual signs, not assumed. Still correctly categorized as concessions.
- **`153c`'s Unit Availability snapshot is broken** — reports all-zero while its rent
  roll has 7 real units. Caught automatically now via a cross-check flag.
- **331 tenancies have a lease_expiration date already in the past** relative to the
  data's As Of date — likely month-to-month holdovers. `/leases/expiring` originally
  only bounded one end of the date window and would've swept these in as "expiring
  soon"; fixed to bound both ends.
- **`altapm` is a structurally empty placeholder property** (zero unit rows) — not a
  real building.
- **The missing_charges check had a third blind spot** (found in a later deliberate
  re-audit): its `market_rent > 0` filter excluded commercial tenancies where that
  field isn't populated — including the unit carrying the portfolio's single largest
  delinquent balance ($178,806.41, The Mill Greenwich 328-104, occupied, zero charges).
  Filter dropped; 139 now carries a `missing_charges_partial` flag.
- **Impossible dates exist in the source files**: 6 tenancies with move_in after
  lease_expiration, and one lease "expiring" 2626-06-30 (typo for 2026). Flagged at
  load time as `implausible_dates`; the 30-year threshold deliberately spares a
  legitimate 2040 commercial lease.

Full detail with exact numbers and how each was found lives in `CLAUDE.md` sections 1,
6, and 7.

---

## How to run this locally

```bash
cd "Aker Case Study Data"  # not needed if db/aker.db already exists
python3 scripts/load_data.py      # loads from scratch, idempotent, safe to re-run
python3 -m pytest tests/ -q        # 36 tests, should all pass
python3 -m uvicorn api.main:app --port 8420
```

Then open `http://127.0.0.1:8420/` (product page), `/dashboard.html`, or
`/how-it-works.html`.

---

## A note on the browser testing tool, for whoever picks this up

The automated browser pane used for visual verification in this session has a real,
reproducible quirk: it sometimes reports the active tab as `document.hidden = true`
even when it's the frontmost tab, which pauses `requestAnimationFrame` and can produce
genuinely garbled screenshots (motion-smear-looking artifacts) that are **not** real
bugs in the page. This was confirmed multiple times by checking `document.hidden`
directly and cross-checking computed CSS (no `filter` applied, etc.).

**This is a real caveat, but it is not a license to dismiss user-reported visual bugs.**
One did get initially written off as "probably just the tool" and turned out to be a
real CSS bug the user could see in their own browser. The right process: verify via
direct DOM/computed-style inspection when a screenshot looks wrong, and if the
screenshot tool's `document.hidden` is true, that specific screenshot is unreliable —
but a bug the user is reporting from their own browser is never explained away by that,
it has to be found and fixed.
