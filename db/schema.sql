-- Aker AI case study schema
-- SQLite. Normalized tables + views for hot-path aggregates.
-- See CLAUDE.md "Schema (locked)" section for design rationale.

PRAGMA foreign_keys = ON;

-- One row per real property (15 unique, not 25 source files).
-- PK is the numeric code prefix pulled from the filename/in-file code, not the name string,
-- since property names are spelled inconsistently across a property's own files
-- (e.g. "55 Riverwalk Place" vs "Fifty-Five Riverwalk Place", both code 134).
CREATE TABLE properties (
    property_id     TEXT PRIMARY KEY,   -- e.g. '134', '115r' style code stripped to its numeric prefix
    canonical_name   TEXT NOT NULL
);

-- Alternate names seen for a property across its various source files.
CREATE TABLE property_name_aliases (
    alias_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id     TEXT NOT NULL REFERENCES properties(property_id),
    alias_name      TEXT NOT NULL,
    UNIQUE (property_id, alias_name)
);

-- One row per source file ingested. Everything else hangs off a snapshot, so loading
-- a second month later is just more snapshot rows, not a redesign.
-- program_type reflects the source file's revenue program (residential/affordable/
-- commercial/land), derived from the filename suffix (r/a/c/land). 'unknown' covers
-- altapm, which has no numeric property code prefix at all (empty placeholder property,
-- see data_quality_flags).
CREATE TABLE data_snapshots (
    snapshot_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id     TEXT NOT NULL REFERENCES properties(property_id),
    program_type    TEXT NOT NULL CHECK (program_type IN
                        ('residential', 'affordable', 'commercial', 'land', 'unknown')),
    source_type     TEXT NOT NULL CHECK (source_type IN ('rent_roll', 'unit_availability')),
    as_of_date      DATE,
    month_year      TEXT,
    source_filename TEXT NOT NULL,
    loaded_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unique on (property_id, program_type, unit_number), not just (property_id, unit_number),
-- since unit numbering schemes can collide across programs within the same property
-- (e.g. a residential unit and a commercial suite both numbered "101").
CREATE TABLE units (
    unit_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id     TEXT NOT NULL REFERENCES properties(property_id),
    program_type    TEXT NOT NULL CHECK (program_type IN
                        ('residential', 'affordable', 'commercial', 'land', 'unknown')),
    unit_number     TEXT NOT NULL,
    unit_type       TEXT,
    sq_ft           REAL,
    UNIQUE (property_id, program_type, unit_number)
);

-- One row per unit-resident-period, tied to the snapshot it was read from.
-- status replaces the VACANT/MODEL/DOWN-as-literal-resident-name pattern in the source data
-- with an actual queryable field.
CREATE TABLE tenancies (
    tenancy_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id         INTEGER NOT NULL REFERENCES data_snapshots(snapshot_id) ON DELETE CASCADE,
    unit_id             INTEGER NOT NULL REFERENCES units(unit_id),
    section             TEXT NOT NULL CHECK (section IN ('current', 'future_applicant')),
    status              TEXT NOT NULL CHECK (status IN ('occupied', 'vacant', 'model', 'down', 'notice')),
    resident_code       TEXT,
    resident_name       TEXT,
    market_rent         REAL,
    resident_deposit    REAL,
    other_deposit       REAL,
    move_in             DATE,
    lease_expiration    DATE,
    move_out            DATE,
    balance             REAL
);

CREATE TABLE charge_codes (
    code            TEXT PRIMARY KEY,
    description     TEXT,
    category        TEXT NOT NULL CHECK (category IN
                        ('base_rent', 'ancillary', 'utility', 'commercial', 'subsidy', 'fee', 'concession'))
);

-- One row per charge line item under a tenancy.
CREATE TABLE charges (
    charge_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    tenancy_id      INTEGER NOT NULL REFERENCES tenancies(tenancy_id) ON DELETE CASCADE,
    charge_code     TEXT NOT NULL REFERENCES charge_codes(code),
    amount          REAL NOT NULL
);

-- Near-direct mirror of the Unit Availability source files. No transform logic needed here,
-- unlike tenancies/charges which require splitting the nested Rent Roll layout.
CREATE TABLE unit_availability_snapshots (
    ua_snapshot_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id         INTEGER NOT NULL REFERENCES data_snapshots(snapshot_id) ON DELETE CASCADE,
    property_id         TEXT NOT NULL REFERENCES properties(property_id),
    avg_sq_ft            REAL,
    avg_rent             REAL,
    total_units          INTEGER,
    occupied_no_notice   INTEGER,
    vacant_rented        INTEGER,
    vacant_unrented       INTEGER,
    notice_rented         INTEGER,
    notice_unrented        INTEGER,
    available             INTEGER,
    model                  INTEGER,
    down                   INTEGER,
    admin                  INTEGER,
    pct_occ                REAL,
    pct_occ_w_nonrev        REAL,
    pct_leased              REAL,
    pct_trend               REAL
);

-- Data quality issues computed at load time (e.g. 153c's broken Unit Availability snapshot,
-- altapm being an empty placeholder property). Stored as real rows so this becomes a live
-- feature the chatbot can query, not just tribal knowledge.
-- pct_value holds the underlying numeric ratio for flags that are fundamentally a
-- percentage (e.g. missing_charges coverage gap), not just a boolean. Added after an
-- audit found the original >50%-threshold missing_charges check gave zero signal for a
-- property with, say, 35% of charges missing -- always computing and storing the real
-- number means a partial gap is visible in /anomalies even when it doesn't clear the
-- "severe" bar that triggers the flag_type distinction below.
CREATE TABLE data_quality_flags (
    flag_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id     TEXT REFERENCES properties(property_id),
    snapshot_id     INTEGER REFERENCES data_snapshots(snapshot_id) ON DELETE CASCADE,
    flag_type       TEXT NOT NULL,
    detail          TEXT,
    pct_value       REAL,
    flagged_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unexpected errors raised while loading a file (i.e. NOT a recognized parse error like
-- a malformed header or a missing summary marker). These are almost certainly a bug in
-- the loader itself, not a bad source file, and get their own table so they're never
-- silently indistinguishable from a normal "this file's data looks wrong" failure --
-- an audit found the loader previously caught every exception the same way and only
-- printed it to stdout in the final run summary, meaning a real code bug in an
-- unattended run would leave no trace in the database at all.
CREATE TABLE loader_errors (
    error_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    source_filename TEXT NOT NULL,
    error_type      TEXT NOT NULL,
    error_detail    TEXT,
    occurred_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tenancies_snapshot ON tenancies(snapshot_id);
CREATE INDEX idx_tenancies_unit ON tenancies(unit_id);
CREATE INDEX idx_charges_tenancy ON charges(tenancy_id);
CREATE INDEX idx_units_property ON units(property_id);
CREATE INDEX idx_ua_snapshots_property ON unit_availability_snapshots(property_id);

-- ---------------------------------------------------------------------------
-- Views for hot-path aggregates (revenue by category, revenue by property, occupancy)
--
-- All four views below resolve to "latest rent_roll snapshot per property" via the
-- v_latest_rent_roll_snapshot helper view, not "every snapshot ever loaded". With a
-- single month of data this makes no visible difference, but it matters the moment a
-- second month loads: without this, a property with two snapshots would get its
-- revenue/leases/balances summed or listed across both periods instead of showing
-- just the current one. Caught and fixed while sanity-checking the views before
-- building the API on top of them, better to fix once here than debug it later once
-- the dashboard and chatbot both depend on these views.
-- ---------------------------------------------------------------------------

CREATE VIEW v_latest_rent_roll_snapshot AS
SELECT property_id, MAX(as_of_date) AS as_of_date
FROM data_snapshots
WHERE source_type = 'rent_roll'
GROUP BY property_id;

-- Revenue by property and charge category, latest period only.
-- concession-category amounts are stored as negatives in the source data (rent/parking/etc
-- concessions), so they net out naturally when summed alongside the category they offset.
CREATE VIEW v_revenue_by_property_category AS
SELECT
    u.property_id,
    latest.as_of_date,
    cc.category,
    SUM(c.amount) AS total_amount
FROM charges c
JOIN charge_codes cc ON cc.code = c.charge_code
JOIN tenancies t ON t.tenancy_id = c.tenancy_id
JOIN units u ON u.unit_id = t.unit_id
JOIN data_snapshots s ON s.snapshot_id = t.snapshot_id
JOIN v_latest_rent_roll_snapshot latest
    ON latest.property_id = u.property_id AND latest.as_of_date = s.as_of_date
GROUP BY u.property_id, cc.category;

-- Gross revenue vs concessions vs net effective revenue, by property, latest period only.
-- Standard real estate framing: net effective rent = gross revenue - concessions.
CREATE VIEW v_effective_revenue_by_property AS
SELECT
    u.property_id,
    latest.as_of_date,
    SUM(CASE WHEN cc.category != 'concession' THEN c.amount ELSE 0 END) AS gross_revenue,
    SUM(CASE WHEN cc.category = 'concession' THEN c.amount ELSE 0 END) AS concessions,
    SUM(c.amount) AS net_effective_revenue
FROM charges c
JOIN charge_codes cc ON cc.code = c.charge_code
JOIN tenancies t ON t.tenancy_id = c.tenancy_id
JOIN units u ON u.unit_id = t.unit_id
JOIN data_snapshots s ON s.snapshot_id = t.snapshot_id
JOIN v_latest_rent_roll_snapshot latest
    ON latest.property_id = u.property_id AND latest.as_of_date = s.as_of_date
GROUP BY u.property_id;

-- Leases expiring soon (current, occupied tenancies with a lease_expiration date),
-- latest period only. unit_id and canonical_name included so consumers (the chatbot
-- especially) can chain into unit detail and use real property names without a second
-- lookup -- the copilot QA pass caught it inventing a name ("Sutton Hill") for a code
-- when the result carried only property_id.
CREATE VIEW v_lease_expirations AS
SELECT
    t.tenancy_id,
    u.unit_id,
    u.property_id,
    p.canonical_name,
    u.unit_number,
    t.resident_name,
    t.lease_expiration,
    t.market_rent
FROM tenancies t
JOIN units u ON u.unit_id = t.unit_id
JOIN properties p ON p.property_id = u.property_id
JOIN data_snapshots s ON s.snapshot_id = t.snapshot_id
JOIN v_latest_rent_roll_snapshot latest
    ON latest.property_id = u.property_id AND latest.as_of_date = s.as_of_date
WHERE t.section = 'current'
  AND t.status = 'occupied'
  AND t.lease_expiration IS NOT NULL;

-- Delinquent tenancies (positive balance owed), latest period only. Same unit_id /
-- canonical_name reasoning as v_lease_expirations above.
CREATE VIEW v_delinquent_tenancies AS
SELECT
    t.tenancy_id,
    u.unit_id,
    u.property_id,
    p.canonical_name,
    u.unit_number,
    u.program_type,
    t.resident_name,
    t.balance
FROM tenancies t
JOIN units u ON u.unit_id = t.unit_id
JOIN properties p ON p.property_id = u.property_id
JOIN data_snapshots s ON s.snapshot_id = t.snapshot_id
JOIN v_latest_rent_roll_snapshot latest
    ON latest.property_id = u.property_id AND latest.as_of_date = s.as_of_date
WHERE t.balance > 0;
