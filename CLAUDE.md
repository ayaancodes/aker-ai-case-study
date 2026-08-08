# Aker AI — Round 2 Case Study

## Assignment (from Aker)
1. Design a relational database schema to store as much data as possible from the Excel files.
2. Develop a Python script to process all the files and load the data into the database.
3. Build a presentation layer (dashboard, LLM chatbot, or something else) that showcases skills.
Deadline: Monday, August 10.

## Status
Data investigated, schema built, loader built and validated, FastAPI backend built and
validated, dashboard built (still being iterated on visually). An independent audit pass
found and fixed real validation gaps in the loader (section 6) — fixes were cross-checked
against the raw Excel files with a second, differently-written parser, not just against
the database's own internal consistency. Next: finish dashboard polish, then LLM chatbot.

## How this file is organized
Each numbered section below is one phase of the build, in the order it actually happened.
Each one states the **goal** first, then **what was done**, then the **result** — so this
reads as an audit trail, not just a spec. Read top to bottom to follow the whole build.

---

## 1. Data investigation

**Goal:** understand the source data completely before making any schema or build
decisions — 25 Rent Roll files + 25 Unit Availability files, one pair per property.

**What was done:** walked all 25+25 files programmatically (not spot-checked), verified
structure held across every file, checked every charge amount, every balance, every date
field, cross-referenced Unit Availability against independently counting Rent Roll rows.

**Data location:**
- `Rent_Roll_with_Lease_Charges/` — 25 .xlsx files, one per property
- `Unit_Availability/` — 25 .xlsx files, one per property

### Result: Rent Roll structure
- Single sheet ("Report1") per file, identical layout across all 25 files (no header anomalies).
- Header rows 0–5: report title, property name + code, "As Of" date, month/year, column headers.
- Two sections per file, in this order:
  - "Current/Notice/Vacant Residents" — present tenancy
  - "Future Residents/Applicants" — upcoming lease, not yet moved in
  - Some units can appear in both sections (current lease ending, new one already signed) —
    doesn't actually occur in this dataset, but the schema allows for it.
- Within a section: one row per unit (unit #, unit type, sq ft, resident id/name, market rent,
  deposit, other deposit, move-in, lease expiration, move-out, balance), followed by one row per
  charge line item (charge code + amount) with a "Total" row closing out the unit.
- Vacant/Model/Down units carry that status in the **resident code field** (col 3), not the
  name field — e.g. resident_code="VACANT" with resident_name blank, or
  resident_code="DOWN" with resident_name still "Resident N".
- Bottom of file: property-level occupancy summary + a "Summary of Charges by Charge Code"
  table, closed out by a `Summary Groups` marker row present in all 25 files (even the 3
  empty ones). These are aggregates, not new source rows.
- 32 real charge codes total, verified by programmatic scan of every charge-line row across
  all 25 files (not hand-counted): RENT, RENTAFF, RENTHAP, RENTRETL, RNTPROF, CONRENT,
  PARKING, CONPARK, GARAGE, CONGAR, PETFEE, PETFEEM, CONPETM, STORAGE, CONSTOR, AMENITY,
  CONAMEN, TRASH, WATER, UTILCOM, BIKE, W/D, SDFEE, SALESTX, RETXEST, CAMEST, CAMINSR,
  SEC8CRD, SUBSIDY, MTM, HOMEPCKG, CONEMP.
  - RENTHAP/SEC8CRD/SUBSIDY → affordable/subsidized housing units present in the portfolio.
  - CAMEST/CAMINSR/RENTRETL/RNTPROF → some commercial-flavored leases mixed in — not every
    property is a standard residential apartment complex.

### Result: Unit Availability structure
- Single sheet per file, fixed 7-row x 18-col layout — a property-level summary snapshot,
  not per-unit data. Rock solid across all 25 files, no deviations.
- Fields: property code/name, avg sq ft, avg rent, total units, occupied, vacant
  rented/unrented, notice rented/unrented, available, model, down, admin, % occ, % occ
  w/non-rev, % leased, % trend.
- Row 5 is the real data row; row 6 duplicates it as a "Total" row (only one property per
  file) — the parser uses row 5, not row 6.

### Result: edge cases found (the ones that actually shaped the schema/loader)
- **5 of 15 properties (`175`, `176`, `183`, `184`, `185`) have 100% or near-100% of
  occupied tenancies missing charge lines entirely**, despite carrying real market rent,
  real residents, real lease dates. Kinwood Apartments (`175`): 365 of 367 occupied
  tenancies have zero charges, market rent sums to $823k but recorded revenue was only
  $4,144. This is the single biggest gap the original investigation missed — the
  "charge-line-to-Total math checked, zero mismatches" claim below is technically true
  and also misleading: a unit with 0 charges and a stated Total of 0 legitimately
  "matches," so that check has no way to catch a unit that's missing all its charges,
  only a unit whose charges don't sum to what the file claims they sum to. Two
  structurally different failure modes, and the investigation only ever tested for one
  of them. Found while building the dashboard's revenue-by-property view — Kinwood's
  bar was visibly, absurdly short next to every other property, not from re-running the
  investigation. Once found, checked across the full portfolio rather than assuming it
  was a one-off (same discipline as the CON* and property-count corrections) and it
  turned out to be systemic across 5 properties, not isolated to Kinwood. Now caught
  automatically at load time as a `missing_charges` flag (>50% of occupied tenancies
  with market_rent > 0 but zero charges) — see section 3. Revenue for these 5 properties
  in the current dataset is materially understated; any ranking or "top/bottom
  performer" view needs to account for this, not just display the raw numbers.
- **3 rent roll files are structurally empty** (no unit rows at all): `134land`, `183c`,
  `altapm`. `altapm` looks like a placeholder/test property, not a real one.
- **7 of 25 rent roll files have no Future Residents/Applicants section** — current
  residents only. Legitimate variant, not corruption.
- **25 rent roll files map to only 15 unique properties**, not 25 or 16. The a/c/r/land
  filename suffixes split one physical property across multiple files (residential,
  affordable, commercial, land parcel are different revenue *programs*, not different
  buildings). "55 Riverwalk Place" (134c, 134land) vs "Fifty-Five Riverwalk Place" (134r)
  is the same property (code 134), spelled two different ways across its own files — match
  properties by numeric code prefix, never by name string. (This count went through two
  corrections: first hand-counted as 16 during initial investigation, then the loader's
  actual dedup gave the authoritative 15 — see section 3.)
- **CON* charge codes are 214/216 negative, not 100%.** The 7 CON*-prefixed codes
  (CONRENT, CONPARK, CONGAR, CONPETM, CONSTOR, CONAMEN, CONEMP) are concessions/credits,
  overwhelmingly negative, confirming that read. 2 of 216 lines are positive: `153r` unit
  2-26 (RENT $2,852 + CONRENT **+$1,083.84** = Total $3,935.84) and `143a` unit 1315
  (PARKING $75 + CONPARK **+$75**). No clean business explanation from the data alone,
  likely a concession reversal or source-system inconsistency, not evidence the category
  is wrong — doesn't affect the schema since `v_effective_revenue_by_property` just SUMs
  regardless of sign. Caught by checking min/max across every CON* row instead of trusting
  a small sample — general lesson: verify "always X" claims against the full dataset before
  writing them down as fact.
- **331 of 4,106 tenancies have a lease_expiration date already in the past** relative to
  the data's As Of date (some by over a decade, e.g. 2015). Likely month-to-month
  holdovers — original lease term lapsed, resident stayed on, field never updated. Found
  while building the `/leases/expiring` API endpoint (see section 4) — worth its own
  "expired, never renewed" risk view in the dashboard, separate from "expiring soon."
- **427 rows have negative balances** (down to -$11,141.05, credits/large arrears), 67
  rows have |balance| > $5,000. Real business data, not errors. Top positive balances
  cluster in `139c` (The Mill Greenwich, commercial): 3 units carry $35,545.80 /
  $46,013.91 / $178,806.41 — far above the largest residential balance ($18,323.53 in
  `126r`). Keep commercial and residential delinquency in separate dashboard views, or
  one commercial property will visually swamp all residential risk.
- **Unit Availability vs Rent Roll cross-check: matches in 24 of 25 files.** The one
  break: `153c` (Abbot Mill commercial) Unit Availability is all-zeros while its Rent
  Roll has 7 real unit rows — stale/broken data for that specific file.
- **Model and Down are not Unit-Availability-exclusive** — they match resident_code =
  "MODEL"/"DOWN" rows in the Rent Roll exactly, same placeholder-status pattern as
  VACANT. Admin is 0 in every single Unit Availability file portfolio-wide, so it's
  untested whether Rent Roll has an equivalent signal for it.
- Charge-line-to-Total math checked across all 4,106 unit records: **zero mismatches.**
- No genuine duplicate residents. "VACANT" (3x in `134c`) and "DOWN" (8x in `184r`)
  repeat as resident codes but they're placeholder statuses, not real people.
- Missing Move In/Lease Expiration tracks VACANT units almost exactly (one stray case in
  `126r` worth a second look if it ever matters). Missing Move Out is expected for anyone
  who hasn't given notice yet, and near-100% for Future Residents.

---

## 2. Database schema

**Goal:** a normalized schema that stores as much of the source data as possible,
survives the messy edge cases found above without special-casing, and is lean enough
that the API/chatbot layers can query it directly without extra transform logic.

**Approach:** one table per real-world entity (property, unit, tenancy, charge), a
lookup table for charge categorization instead of hardcoded code lists anywhere in
application code, and a snapshot-based design so loading a second month later is
purely additive, not a redesign. See `db/schema.sql` for the actual DDL.

**DB engine: SQLite.** Single file, zero setup, plenty for this data size (~4-5k rows).
Gitignored, same as the raw Excel data, since it holds resident/financial data.

### Result: the tables
- **`properties`** — one row per real property (15 unique, not 25 files: 14 numbered
  properties + `altapm`). PK is the numeric code prefix stripped of its program suffix
  (`134`, not `134c`/`134r`/`134land`). `altapm` has no numeric prefix at all, kept as
  literal property_id `altapm` (it's the empty placeholder property anyway).
- **`property_name_aliases`** — handles "55 Riverwalk Place" vs "Fifty-Five Riverwalk
  Place" (same property, code 134, spelled two ways across its own files).
- **`data_snapshots`** — one row per source file ingested (property_id, program_type,
  source_type, as_of_date, source_filename). Everything else hangs off this, so loading
  a second month later is just more snapshot rows.
- **`program_type`** (on data_snapshots and units) — residential / affordable /
  commercial / land / unknown, derived from the filename suffix. The suffix isn't a
  different property, it's a different revenue program within the same physical
  property — this is what makes "% of this property's revenue that's commercial vs
  subsidized vs market-rate" queryable for the concentration-risk dashboard feature.
- **`units`** — unit_id, property_id, program_type, unit_number, unit_type, sq_ft.
  Unique on (property_id, program_type, unit_number), not just (property_id,
  unit_number), since unit numbering can collide across programs within one property.
- **`tenancies`** — one row per unit-resident-period, tied to a snapshot. Real `status`
  enum (current / future_applicant / vacant / model / down) instead of burying that in
  the resident name field the way the source Excel does.
- **`charges`** — one row per charge line item, tied to a tenancy (charge_code, amount).
- **`charge_codes`** — lookup table for the 32 known codes, each with a `category`
  (base_rent / ancillary / utility / commercial / subsidy / fee / concession) so revenue
  grouping never needs hardcoded code lists in application code. `concession` covers the
  7 CON*-prefixed codes — see the CON* finding in section 1 for why this category exists
  and what its two exceptions mean.
- **`unit_availability_snapshots`** — near-direct mirror of the Unit Availability Excel
  files, tied to property_id + snapshot_id. Requires no real transform logic, unlike
  tenancies/charges which need the nested section-splitting logic from the Rent Roll.
- **`data_quality_flags`** — computed at load time (flag_type, detail, tied to
  snapshot/property), not a separate later pass. Turns known issues (empty properties,
  153c's broken snapshot) into real queryable rows instead of tribal knowledge — this is
  what powers the "anomalies" feature in the API and eventually the chatbot.

### Result: hot-path views (all resolve to "latest snapshot per property")
- `v_effective_revenue_by_property` — gross revenue, concessions, net effective revenue
  per property (standard real estate "effective rent" framing).
- `v_revenue_by_property_category` — revenue broken down by charge category per property.
- `v_lease_expirations` — current, occupied tenancies with a lease_expiration date.
- `v_delinquent_tenancies` — tenancies with a positive balance owed.
- All four are built on `v_latest_rent_roll_snapshot`, which resolves each property to
  its most recent as_of_date. **This was a real bug fix, not just future-proofing:**
  the first version of these views grouped by snapshot_id directly, which meant
  properties with multiple program-type files (like The Halden, with separate
  residential + affordable snapshots) had their revenue split across multiple rows
  instead of combined into one property total — undercounting revenue *right now*, with
  just one month of data loaded. Fixed by resolving to latest-snapshot-per-property
  before aggregating. Caught by sanity-checking the views against real data before
  building the API on top of them, rather than assuming they were correct.

---

## 3. ETL loader

**Goal:** a Python script that loads all 50 files into the schema above, correctly,
and would still work the same way if there were 1,000 files instead of 25 — no
hardcoded file lists, no hardcoded property lists, identity derived from the data
itself.

**Approach:** parsing logic (`scripts/etl/rent_roll_parser.py`,
`unit_availability_parser.py`) is fully separated from database writes
(`scripts/etl/db.py`), so each piece can be tested independently. File discovery is
`glob`, not an enumerated list. Property identity comes from a filename regex
(`scripts/etl/filenames.py`), not a lookup table.

**Loader best practices applied:**
- Idempotent: re-running deletes and reinserts by source_filename rather than
  blind-appending (relies on `ON DELETE CASCADE` from data_snapshots down to
  tenancies/charges/ua_snapshots/flags). Verified by running it twice — identical
  counts both times.
- Transactional per source file: one file's insert is all-or-nothing.
- A single bad file doesn't abort the whole run — logged loudly in the final summary,
  the loader moves on. (This is the one place "fail loud" got refined during the
  build: still fails loud, but loud-and-logged-per-file rather than
  abort-the-whole-batch, since that's what actually scales to more files.)
- Charge-line-sum-vs-stated-Total is re-validated live as it loads, not just trusted
  from the investigation.
- Data quality flags get written during the load itself: empty rent rolls, a
  cross-check between each property's latest Rent Roll and Unit Availability unit
  counts (this is what catches `153c` automatically, the same check done by hand
  during investigation, now automated), and a check for occupied tenancies with real
  market rent but zero recorded charges (`missing_charges`, >50% of a property's
  occupied tenancies affected) — this one wasn't in the original investigation, added
  after the dashboard's revenue view surfaced it, see section 1 edge cases.

### Result: verified against the real data
- 25/25 rent roll files loaded, 25/25 unit availability files loaded.
- **15 properties** (this is the authoritative, programmatic dedup count — corrects the
  "16" hand-count from initial investigation).
- 4,106 tenancies, 9,177 charges.
- **10 data quality flags total** (grew from 4 to 10 after the missing_charges finding
  below — see that section for how the other 6 got caught): 3 empty properties
  (`134land`, `183c`, `altapm`) + 1 unit-availability mismatch (`153c`) + 6
  missing_charges flags (`175`, `176`, `183`x2, `184`, `185`).
- Zero charge-total mismatches.
- Idempotent re-run gives identical counts.

---

## 4. FastAPI backend (first loop)

**Goal:** a small number of clean, single-purpose endpoints that the dashboard and the
LLM chatbot both consume — same data path for both, no duplicated logic, and the
endpoints double as tool definitions for the chatbot's function-calling later.

**Approach:** build the first loop, validate it end to end against the real database,
then iterate rather than over-designing endpoints before anything's running. See
`api/main.py`.

### Result: the endpoints
- `GET /properties`, `GET /properties/{id}` — list + detail (name, aliases, program
  types, latest as-of dates per source type).
- `GET /revenue/portfolio`, `GET /revenue/{property_id}` — gross/concessions/net
  effective revenue, portfolio-wide and per-property, plus category breakdown.
- `GET /leases/expiring?days=N&property_id=` — leases expiring within N days of the
  data's latest as-of date.
- `GET /delinquent?min_balance=&property_id=` — positive-balance tenancies.
- `GET /anomalies?property_id=` — data_quality_flags rows.
- Read-only SQLite connection per request (`api/db.py`), reuses the same `db/aker.db`
  the loader writes to.

### Result: every endpoint manually tested against the real loaded DB
Not just written and assumed to work — each one was hit with real requests and the
responses checked for correctness (e.g. property 134 correctly resolves its Riverwalk
Place alias, `altapm` correctly 404s on `/revenue` since it has no charge data).

### Result: two real bugs found and fixed during that testing
- **as_of_date format bug.** Stored as raw `MM/DD/YYYY` text straight from the source
  file header, while every other date field (move_in, lease_expiration, move_out) is
  ISO (`YYYY-MM-DD`) from real Excel datetime cells. This broke SQL date comparisons
  silently — SQLite's `date()` function returns NULL on non-ISO input, so
  `/leases/expiring` returned zero results instead of erroring. The loader's own
  validation didn't catch this since it checks counts/sums, not date formats. Fixed at
  the parser level (`_mmddyyyy_to_iso` in both etl parsers), not patched around in the
  API query, so as_of_date is ISO everywhere in the database.
- **`/leases/expiring` date-window bug.** Only bounded the upper end of the date window
  (`lease_expiration <= as_of + N days`), which silently swept in the 331 tenancies
  with already-expired lease dates (see section 1) as if they were expiring soon.
  Fixed with a `BETWEEN as_of_date AND as_of_date + N days` bound on both ends.

---

## 5. What's next: dashboard + LLM chatbot (not started)

**Decided plan, not yet built:**
- **Chatbot**: Claude API (Anthropic), tool-calling against the FastAPI endpoints above.
  Not raw text-to-SQL — the model calls defined endpoints, never touches SQL directly.
- **Dashboard**: portfolio-aware view, reframed with an investment-fund lens since Aker
  is an investment company with real estate + AI holdings (not just a property manager
  tool) — NOI-style revenue per property/sq ft, portfolio concentration risk
  (subsidized/commercial/market-rate revenue mix), lease rollover risk (including the
  "expired, never renewed" holdover signal from section 1), underperformer flagging.
- **Data quality as a feature**: the `/anomalies` endpoint becomes a live feature the
  chatbot can report on, second priority after the portfolio-aware chatbot + dashboard
  itself.
- **Visual direction**: dark fintech aesthetic borrowed from a friend's project
  (vegalabs.vercel.app, full permission granted to reuse/adapt the code) — glass/blur
  cards, JetBrains Mono for all numbers, Bricolage Grotesque for headings, cyan accent,
  count-up stat tiles, a scrolling ticker strip (properties instead of stock tickers),
  and a marquee of property cards. Not cloning the marketing page wholesale, pulling the
  design system and component patterns onto real data from the API. Deliberate choice to
  lean into "theatrics" here, not just function — a live tool-calling demo and visible
  data-quality catches are meant to be a genuine wow moment in the demo, not just correct.
- **Stretch goal, not committed**: a 3D phone mockup showing the dashboard/chatbot on
  mobile, same visual trick as Vega's phone showcase. Cool but a lot of animation work
  for the time available — parked here so it's not lost, revisit only if everything else
  is done early.
- **Deployment**: keep it to one deployable service if possible (FastAPI serving API +
  frontend) given the Monday deadline. Render or Railway for hosting.

---

## 6. Audit: idempotency, validation coverage, and error-handling fixes

**Goal:** an outside audit (prompted by the missing_charges discovery) was asked to check
this pipeline against real ETL practice, not just internal consistency, and to fix what
it found rather than just report it.

**Approach:** for each gap, re-verify it's real against the live data first, fix the
narrowest correct thing, then re-run the full loader from scratch and independently
cross-check the result against the raw Excel files with a second, differently-written
parsing path — not just against the database's own internal consistency.

### Result: what the audit found and fixed
- **The missing_charges check had the same blind spot it was built to catch, for
  'notice' status tenants.** It only checked `status == 'occupied'`; 147 'notice' status
  tenancies (giving notice, still paying) carry real market rent, and 33 of them (22%)
  had the identical zero-charges problem, invisible to the flag. All 33 were inside the
  5 already-flagged properties, so the flag's own reported counts were undercounting
  even where it had already caught the issue (176's flag said "277 of 277," missing 15
  more). Fixed: `CHARGE_EXPECTED_STATUSES` now covers occupied + notice. `model`/`down`
  were deliberately checked and excluded — they carry real market_rent (avg
  $1,868-$2,652) but resident_name is a generic "Resident N" placeholder, not a real
  tenant, so zero charges there is correct, not a gap.
- **The 50%-threshold flag was a boolean with no visibility below the cliff.** A
  property with, say, 35% of charges missing would load clean with zero signal. Fixed:
  added `pct_value` to `data_quality_flags`, always computed and stored whenever
  nonzero. `flag_type` still distinguishes severe (`missing_charges`, >50%) from
  partial (`missing_charges_partial`, any nonzero amount below that), but the number is
  never hidden. Property `144` (1 of 759 tenancies, 0.1%) is the first
  `missing_charges_partial` case, exactly the kind of gap the old boolean would have
  silently passed.
- **Idempotency didn't handle a renamed or removed source file.**
  `delete_existing_snapshot` matched by exact filename; a rename left the old row as an
  orphan sharing the new row's as_of_date, which the revenue views would then silently
  sum together — reintroducing the double-counting bug already fixed once. Fixed:
  matching is now by identity (`property_id`, `program_type`, `source_type`,
  `as_of_date`), with a filename fallback only when `as_of_date` couldn't be parsed. A
  new end-of-run reconciliation pass (`reconcile_missing_files`) removes snapshots for
  files no longer present in the source folder at all, which identity-matching alone
  can't catch since it only fires on reprocessing. Verified with a scratch test: renamed
  one file and removed another mid-run, confirmed no orphan and no double-counted
  revenue in `v_effective_revenue_by_property`.
- **Two different definitions of "latest snapshot" existed.** The SQL views used
  `MAX(as_of_date)`; the loader's own Unit-Availability-vs-Rent-Roll cross-check used
  `loaded_at DESC`. They only agreed by coincidence with one snapshot per property/
  program. Fixed: `latest_rent_roll_snapshot` now orders by `as_of_date DESC` too,
  `loaded_at` only as a tiebreaker.
- **Exception handling couldn't tell a bad file from a loader bug.**
  `except (RentRollParseError, Exception)` was functionally `except Exception` —
  a genuine code bug and a malformed source file were handled identically and only ever
  printed to stdout. Fixed: known parse errors stay a normal per-file failure; anything
  else is now written to a new `loader_errors` table (new `/loader-errors` API
  endpoint), so a loader bug can never be mistaken for "the source file was just bad"
  after the fact.
- **`units` was first-write-wins forever.** A later file correcting `sq_ft` or
  `unit_type` was silently ignored. Fixed: `get_or_create_unit` now updates on change
  and logs a `unit_dimension_changed` flag, so a correction is both applied and
  auditable.
- **`db/schema.sql`'s own property-count comment was stale** ("16 unique"), corrected to 15.
- **No automated tests existed.** Added `tests/` (36 tests): idempotency/rename/
  reconciliation logic, unit-dimension updates, the exact known-good counts (15
  properties, 4,106 tenancies, 9,177 charges, 32 charge codes, zero charge-total
  mismatches), and regression coverage for all three previously-found-and-fixed bugs
  (as_of_date ISO format, leases/expiring bounded on both ends, missing_charges'
  notice-status coverage).

### Result: verified against the real data, and independently against the raw files
- Full reload from scratch (`rm -f db/aker.db && python3 scripts/load_data.py`):
  25/25 + 25/25 files, 15 properties, 4,106 tenancies, 9,177 charges unchanged (these
  fixes are validation-layer, not parsing-layer). Flags grew from 10 to 11 (the new
  `missing_charges_partial` case). Zero `loader_errors`. Idempotent re-run confirmed:
  identical counts on a second pass — re-verified independently, not just taken on the
  audit's word.
- **Cross-validated independently against the raw Excel files**, not just the
  database's internal consistency: a standalone pandas script using a *different*
  parsing strategy (vectorized block-segmentation instead of the loader's row-by-row
  state machine) recomputed total market rent, total recorded charges, billable-tenancy
  count, and missing-charges count directly from the source `.xlsx` files for all 5
  affected properties (175, 176, 183, 184, 185). Every number matched the database
  exactly. This also produced a corrected, exactly-reproducible figure for Kinwood
  (175): **$787,568** in market rent at risk (373 of 375 billable tenancies missing
  charges) — supersedes the rougher "$823k" estimate in section 1, which predated the
  notice-status fix and wasn't independently reproducible.
- Portfolio-wide, the missing_charges gap now accounts for **$2,045,964/month** in
  market rent with zero recorded charges, across the properties/programs affected.
- Separately, while iterating on the dashboard: `/revenue/portfolio` and
  `/revenue/{property_id}` were also fixed to `LEFT JOIN`/`COALESCE` instead of inner
  join, so a property with zero charges anywhere (176, 183, 184, 185, and the
  structurally-empty `altapm`) shows as a real $0 on the dashboard instead of silently
  disappearing from the list — the same "don't hide the gap" principle as the
  `pct_value` fix above, just caught from the frontend side instead of the loader side.

---

## Reference

### Tooling defaults
- Python + pandas for exploration and any parsing scripts.
- Prefer clarity over cleverness when parsing the nested Excel layout — forward-fill
  logic and section-splitting need to be easy to audit, since correctness here is the
  whole point of the exercise for this interview.
- No Claude Code skills for this project yet. Nothing here repeats often enough to be
  worth packaging while still mid-build. Revisit if "load a new month's data" becomes
  an actual recurring operation once the loader's proven correct.

### Working style
- Casual, direct tone. Plain English over jargon.
- No em dashes in written output (comments, docs, chat responses).
- Ask before making a build decision (schema shape, DB engine, framework choice) — flag
  it and wait rather than assuming.
- Never add a "Co-Authored-By" line (or any co-author) to git commits. Author is me only.
- Push to git frequently — after almost every discrete unit of work, not batched up.
