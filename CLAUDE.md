# Aker AI — Round 2 Case Study

## Status
Schema, loader, and first-loop FastAPI backend (api/main.py) all built and validated end
to end (every endpoint hit manually against the real loaded DB). Building dashboard +
LLM chatbot next.

## API (api/main.py, first loop)
- `/properties`, `/properties/{id}` — list + detail (name, aliases, program types,
  latest as-of dates per source type).
- `/revenue/portfolio`, `/revenue/{property_id}` — gross/concessions/net effective
  revenue, portfolio-wide and per-property, plus category breakdown. Backed by the
  `v_effective_revenue_by_property` / `v_revenue_by_property_category` views.
- `/leases/expiring?days=N&property_id=` — leases expiring within N days of the data's
  latest as-of date. Bounded on both ends (not just an upper bound), see edge cases.
- `/delinquent?min_balance=&property_id=` — positive-balance tenancies.
- `/anomalies?property_id=` — data_quality_flags rows.
- Read-only SQLite connection per request (api/db.py), reuses the same db/aker.db the
  loader writes to.
- Fixed two real bugs found while manually testing endpoints against real data (not
  caught by the loader's own validation, since those check counts/sums, not date
  formats/query logic):
  - `as_of_date` was stored as raw `MM/DD/YYYY` text from the source file header, while
    every other date field is ISO (`YYYY-MM-DD`) from real Excel datetime cells. Broke
    SQL date comparisons silently (SQLite's `date()` returns NULL on non-ISO input, so
    `/leases/expiring` returned zero results instead of erroring). Fixed at the parser
    level (`_mmddyyyy_to_iso` in both etl parsers) so as_of_date is ISO everywhere,
    not patched around in the API query.
  - `/leases/expiring` only bounded the upper end of the date window
    (`lease_expiration <= as_of + N days`), which silently swept in the 331 tenancies
    with already-expired lease dates (see edge cases) as if they were expiring soon.
    Fixed with a `BETWEEN` on both ends.

## Loader architecture (scripts/etl/)
- `filenames.py` — derives property_id/program_type from filename pattern alone (regex,
  no hardcoded property list). Handles the altapm no-numeric-prefix case.
- `rent_roll_parser.py` — parses one rent roll file into plain dicts, no DB code. Stops
  at the `Summary Groups` marker row (confirmed present in all 25 files, including the
  3 empty ones) so the footer occupancy/charge-code summary tables never get misread as
  fake unit rows. Verified against all 25 files: 4,106 units parsed, matches the original
  investigation exactly; 0 charge-total mismatches.
- `unit_availability_parser.py` — parses one UA file (fixed 7-row/18-col layout, uses
  the row-5 data row, not the row-6 duplicate "Total" row).
- `db.py` — all SQLite writes. get_or_create for properties/units so re-running is safe;
  delete-by-filename-then-reinsert per snapshot for idempotency (relies on ON DELETE
  CASCADE from data_snapshots down to tenancies/charges/ua_snapshots/flags).
- `load_data.py` — orchestrator. Globs both folders (no hardcoded file list, scales past
  25 files by construction), loads rent rolls first then unit availability (needed for
  the cross-check flag), one commit per file, a bad file gets logged and the run
  continues rather than aborting everything.
- Verified: 15 properties (corrected from an earlier "16" hand-count during investigation,
  see edge cases), 4,106 tenancies, 9,177 charges, 4 flags (matches expected: 134land/183c/
  altapm empty + 153c unit-availability mismatch), idempotent re-run gives identical counts.

## Build plan (decided)
- **DB engine**: SQLite. Single file, zero setup, plenty for this data size (~4-5k rows).
  Gitignored, same as raw Excel data, since it holds resident/financial data.
- **Schema**: normalized tables + SQL views for hot-path aggregates (revenue by category,
  revenue by property, occupancy trend). See Schema section below.
- **Backend**: FastAPI. Endpoints double as tool definitions for the LLM chatbot (function
  calling), so dashboard and chatbot pull from the exact same API, no duplicated logic.
- **Chatbot**: Claude API (Anthropic), tool-calling against the FastAPI endpoints. Not
  raw text-to-SQL — the model calls defined endpoints, never touches SQL directly.
- **Dashboard**: portfolio-aware view, reframed with an investment-fund lens since Aker
  is an investment company with real estate + AI holdings (not just a property manager
  tool) — NOI-style revenue per property/sq ft, portfolio concentration risk (subsidized/
  commercial/market-rate revenue mix), lease rollover risk, underperformer flagging.
- **Data quality as a feature**: known issues (153c's broken Unit Availability snapshot,
  altapm being an empty placeholder property, Riverwalk Place naming split across files)
  get stored as real flagged rows at load time, not just tribal knowledge — this becomes
  a live "anomalies" feature the chatbot can report on, second priority after the
  portfolio-aware chatbot + dashboard.
- **Deployment**: keep it to one deployable service if possible (FastAPI serving API +
  frontend) given the Monday deadline. Render or Railway for hosting.

## Schema (locked, see db/schema.sql for the actual DDL)
- `properties` — one row per real property (15 unique, not 25 files: 14 numbered
  properties + `altapm`). PK is the numeric
  code prefix stripped of its program suffix (e.g. `134`, not `134c`/`134r`/`134land`).
  `altapm` has no numeric prefix at all, kept as literal property_id `altapm` (it's the
  empty placeholder property anyway, see data_quality_flags).
- `property_name_aliases` — handles cases like "55 Riverwalk Place" vs "Fifty-Five
  Riverwalk Place" (same property, code 134, name spelled differently across its own files).
- `data_snapshots` — one row per source file ingested (property_id, program_type,
  source_type, as_of_date, source_filename). Everything else hangs off this, so loading a
  second month later is just more snapshot rows, not a redesign.
- `program_type` (on data_snapshots and units) — residential / affordable / commercial /
  land / unknown, derived from the filename suffix (r/a/c/land). The suffix isn't a
  different property, it's a different revenue program within the same physical property —
  this is what makes "% of this property's revenue that's commercial vs subsidized vs
  market-rate" queryable for the concentration-risk feature.
- `units` — unit_id, property_id, program_type, unit_number, unit_type, sq_ft. Unique on
  (property_id, program_type, unit_number), not just (property_id, unit_number), since unit
  numbering can collide across programs within one property (e.g. a residential unit and a
  commercial suite both numbered "101").
- `tenancies` — one row per unit-resident-period, tied to a snapshot. Has a real `status`
  enum (current / future_applicant / vacant / model / down) instead of burying that in the
  resident name field the way the source Excel does (VACANT/MODEL/DOWN as literal names).
- `charges` — one row per charge line item, tied to a tenancy (charge_code, amount).
- `charge_codes` — lookup table for the 33 known codes, each with a `category` (base_rent /
  ancillary / utility / commercial / subsidy / fee / concession) so revenue grouping never
  needs hardcoded code lists in application code. `concession` covers the 7 CON*-prefixed
  codes (CONRENT, CONPARK, CONGAR, CONPETM, CONSTOR, CONAMEN, CONEMP) — checked actual
  amounts in the source data: 214 of 216 CON* charge lines are negative (credits against the
  category they offset). 2 exceptions are positive (CONRENT +$1,083.84 in `153r`, CONPARK
  +$75 in `143a`), likely a concession reversal or data entry inconsistency in the source
  system, not evidence the category is wrong. Doesn't affect the schema either way —
  `v_effective_revenue_by_property` just SUMs amounts regardless of sign, so it nets in
  correctly no matter which way an individual line points. This view gives gross revenue,
  concessions, and net effective revenue per property (standard real estate "effective rent"
  framing).
- `unit_availability_snapshots` — near-direct mirror of the Unit Availability Excel files
  (avg sq ft, avg rent, occupied/vacant/notice counts, model/down/admin, % occ, % leased,
  % trend), tied to property_id + snapshot_id. This table requires no real transform logic,
  unlike tenancies/charges which need the nested section-splitting logic from the Rent Roll.
- `data_quality_flags` — computed at load time (flag_type, detail, tied to snapshot/property).

## Loader best practices (decided, applies to the ETL script)
- Idempotent: re-running on the same files shouldn't double rows. Check/replace by
  source_filename rather than blind-appending.
- Transactional per source file: one file's insert is all-or-nothing, a mid-file failure
  can't leave partial rows behind.
- Validate known invariants live, don't just trust them: re-check charge-line-sum-vs-Total
  as it loads (already confirmed zero mismatches across all 4,106 records during
  investigation, but the loader should catch it if that ever breaks on new data).
- Data quality flags get written during the load itself, not as a separate later pass —
  altapm/134land/183c being empty, 153c's broken Unit Availability snapshot, etc. all get
  flagged the moment the loader hits them.
- Fail loud on structural surprises (unexpected header layout, unknown charge code) rather
  than silently skipping or guessing.

## Assignment (from Aker)
1. Design a relational database schema to store as much data as possible from the Excel files.
2. Develop a Python script to process all the files and load the data into the database.
3. Build a presentation layer (dashboard, LLM chatbot, or something else) that showcases skills.
Deadline: Monday, August 10.

## Data location
- `Rent_Roll_with_Lease_Charges/` — 25 .xlsx files, one per property
- `Unit_Availability/` — 25 .xlsx files, one per property

## What we already know about the data (confirmed by direct inspection)
### Rent Roll with Lease Charges
- Single sheet ("Report1") per file, identical layout across all 25 files (no header anomalies).
- Header rows 0–5: report title, property name + code, "As Of" date, month/year, column headers.
- Two sections per file, in this order:
  - "Current/Notice/Vacant Residents" — present tenancy
  - "Future Residents/Applicants" — upcoming lease, not yet moved in
  - Some units appear in both sections (current lease ending, new one already signed).
- Within a section: one row per unit (unit #, unit type, sq ft, resident id/name, market rent,
  deposit, other deposit, move-in, lease expiration, move-out, balance), followed by one row per
  charge line item (charge code + amount) with a "Total" row closing out the unit.
- Vacant units show resident name literally as "VACANT".
- Bottom of file: property-level occupancy summary + a "Summary of Charges by Charge Code" table.
  These are aggregates, not new source rows — don't double-count them as unit-level data.
- Confirmed real charge codes across the portfolio (32 total, verified by programmatic scan
  of every charge-line row across all 25 files, not hand-counted): RENT, RENTAFF, RENTHAP,
  RENTRETL, RNTPROF, CONRENT, PARKING, CONPARK, GARAGE, CONGAR, PETFEE, PETFEEM, CONPETM,
  STORAGE, CONSTOR, AMENITY, CONAMEN, TRASH, WATER, UTILCOM, BIKE, W/D, SDFEE, SALESTX,
  RETXEST, CAMEST, CAMINSR, SEC8CRD, SUBSIDY, MTM, HOMEPCKG, CONEMP. (Previously stated as
  "33 total" here, an arithmetic error carried over from the initial investigation, caught
  when building the charge_codes seed data.)
  - Presence of RENTHAP/SEC8CRD/SUBSIDY indicates some affordable/subsidized housing units.
  - Presence of CAMEST/CAMINSR/RENTRETL/RNTPROF indicates some commercial-flavored leases mixed
    into the portfolio — don't assume every property is a standard residential apartment complex.

## Edge cases found (full investigation, all 25+25 files walked programmatically)
- **CON* charge codes are 214/216 negative, not 100%** — worth calling out explicitly since
  it's the kind of thing that could be a deliberate trap in this dataset (assume a clean
  rule holds everywhere, then get burned when it doesn't). The 7 CON*-prefixed codes
  (CONRENT, CONPARK, CONGAR, CONPETM, CONSTOR, CONAMEN, CONEMP) are concessions/credits and
  overwhelmingly stored as negative amounts, confirming that read. But 2 of 216 lines are
  positive: `153r` unit 2-26 (RENT $2,852 + CONRENT **+$1,083.84** = Total $3,935.84,
  concession added to the total instead of subtracted) and `143a` unit 1315 (PARKING $75 +
  CONPARK **+$75**, both positive, same charge type stacked). No clean business explanation
  from the data alone, most likely a concession reversal or a source-system data entry
  inconsistency, not evidence the category itself is wrong. Doesn't require a schema change:
  `v_effective_revenue_by_property` just SUMs amounts regardless of sign, so both outliers
  net in correctly either way. Caught by actually checking min/max across every CON* row
  instead of trusting a 5-row sample, worth remembering that lesson generally: verify
  "always negative"/"always X" claims against the full dataset, not a sample, before they
  get written down as fact.
- 3 rent roll files are structurally empty (no unit rows at all): `134land`, `183c`, `altapm`.
  `altapm` looks like a placeholder/test property, not a real one.
- 7 of 25 rent roll files have no Future Residents/Applicants section — current residents
  only. Legitimate variant, not corruption.
- Missing Move In/Lease Expiration tracks VACANT units almost exactly (one stray case in
  `126r` worth a second look if it ever matters). Missing Move Out is expected for anyone who
  hasn't given notice yet, and near-100% for Future Residents (haven't moved in yet).
- 331 of 4,106 tenancies have a `lease_expiration` date already in the past relative to the
  data's As Of date (some by over a decade, e.g. 2015). Likely month-to-month holdovers —
  original lease term lapsed, resident stayed on, the field never got updated once they went
  month-to-month. Found while building the `/leases/expiring` endpoint: an early version of
  that query only bounded the upper end of the date window, so it silently returned these
  decade-old expired leases as if they were "expiring soon." Fixed by bounding both ends
  (`BETWEEN as_of_date AND as_of_date + N days`). Worth surfacing "expired, never renewed"
  as its own risk signal in the dashboard, separate from "expiring soon" — it's a real
  lease-uncertainty story for an investment-fund audience, not just a data quirk.
- 427 rows have negative balances (down to -$11,141.05, credits/large arrears), 67 rows have
  |balance| > $5,000. Real business data, not errors — balance must stay signed decimal.
  Top positive balances are concentrated in `139c` (The Mill Greenwich, commercial): 3 units
  there carry balances of $35,545.80 / $46,013.91 / $178,806.41, far above the largest
  residential balance ($18,323.53 in `126r`). Worth keeping commercial and residential
  delinquency separate in any dashboard view — a single portfolio-wide "top delinquent
  accounts" list would be dominated by one commercial property and hide residential risk.
- No genuine duplicate residents. "VACANT" (3x in `134c`) and "DOWN" (8x in `184r`) repeat as
  resident codes but they're placeholder statuses, not real people reused across units.
- Charge-line-to-Total math checked across all 4,106 unit records: zero mismatches.
- 25 rent roll files map to only 15 unique properties (a/c/r/land suffixes split one property
  across multiple files; the loader's actual dedup gives 15, correcting an earlier hand-count
  of 16 during initial investigation). "55 Riverwalk Place" (134c, 134land) vs "Fifty-Five
  Riverwalk Place" (134r) is the same property (code 134) with an inconsistent name across its
  own files — match properties by code prefix, never by name string.
- Unit Availability structure is rock solid across all 25 files (7 rows x 18 cols, no
  deviations). Cross-checked its unit counts against independently counting Rent Roll rows:
  matches in 24 of 25. The one break: `153c` (Abbot Mill commercial) Unit Availability is
  all-zeros while its Rent Roll has 7 real unit rows — stale/broken data for that file.
- Model and Down units are NOT Unit-Availability-exclusive — they match `ResidentCode =
  "MODEL"`/`"DOWN"` rows in the Rent Roll exactly, same placeholder-status pattern as VACANT.
  Admin is 0 in every single Unit Availability file portfolio-wide, so it's untested whether
  Rent Roll has an equivalent signal for it.

### Unit Availability
- Single sheet per file, only ~7 rows — a property-level summary snapshot, not per-unit data.
- Fields: property code/name, avg sq ft, avg rent, total units, occupied, vacant rented/unrented,
  notice rented/unrented, available, model, down, admin, % occ, % occ w/ non-rev, % leased, % trend.
- Consistent structure across all 25 files.

## Tooling defaults
- Python + pandas for exploration and any parsing scripts.
- Prefer clarity over cleverness when parsing the nested Excel layout — forward-fill logic and
  section-splitting need to be easy to audit, since correctness here is the whole point of the
  exercise for this interview.
- No Claude Code skills for this project yet. Nothing here repeats often enough to be worth
  packaging while still mid-build. Revisit if "load a new month's data" becomes an actual
  recurring operation once the loader's proven correct — building a skill before the process
  is settled just means rewriting it.

## Working style
- Casual, direct tone. Plain English over jargon.
- No em dashes in written output (comments, docs, chat responses).
- Ask before making a build decision (schema shape, DB engine, framework choice) — flag it and
  wait rather than assuming.
- Never add a "Co-Authored-By" line (or any co-author) to git commits. Author is me only.
