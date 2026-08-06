# Aker AI — Round 2 Case Study

## Status
Investigation phase only. No build decisions have been made yet — schema, backend,
dashboard, and chatbot are all still open. Do not scaffold a database, API, dashboard,
or chatbot unless explicitly asked to. Right now the job is understanding the data.

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
- Confirmed real charge codes across the portfolio (32 total): RENT, RENTAFF, RENTHAP, RENTRETL,
  CONRENT, PARKING, CONPARK, GARAGE, CONGAR, PETFEE, PETFEEM, CONPETM, STORAGE, CONSTOR, AMENITY,
  CONAMEN, TRASH, WATER, UTILCOM, BIKE, W/D, SDFEE, SALESTX, RETXEST, CAMEST, CAMINSR, SEC8CRD,
  SUBSIDY, MTM, HOMEPCKG, CONEMP.
  - Presence of RENTHAP/SEC8CRD/SUBSIDY indicates some affordable/subsidized housing units.
  - Presence of CAMEST/CAMINSR/RENTRETL indicates some commercial-flavored leases mixed into
    the portfolio — don't assume every property is a standard residential apartment complex.

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

## Working style
- Casual, direct tone. Plain English over jargon.
- No em dashes in written output (comments, docs, chat responses).
- Ask before making a build decision (schema shape, DB engine, framework choice) — flag it and
  wait rather than assuming.
- Never add a "Co-Authored-By" line (or any co-author) to git commits. Author is me only.
