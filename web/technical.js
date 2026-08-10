/* ── test suite terminal — real output from `pytest tests/ -v`, a curated subset.
   The pass count below is manually maintained (no cheap live source for it): re-run
   `pytest tests/ -q` and update this line whenever tests are added, same discipline
   as the counts in CLAUDE.md prose. Reveal is per-line on its own timer, NOT the
   shared chart easing -- this should read like a terminal running, not a chart
   drawing in. ── */
const TEST_LINES = [
  { cmd: true, text: "$ pytest tests/ -v" },
  { text: "test_zero_charge_total_mismatches ................ " },
  { text: "test_missing_charges_check_covers_notice_status .. " },
  { text: "test_rename_replaces_old_snapshot_not_orphans_it . " },
  { text: "test_leases_expiring_window_bounded_on_both_ends . " },
  { text: "test_no_orphaned_rows_or_fk_violations ............ " },
  { text: "test_known_missing_charges_properties_flagged_severe " },
  { text: "test_revenue_bridge_ties_out ..................... " },
  { text: "test_query_endpoint_guardrails ................... " },
  { summary: true, text: "──────── 54 passed in 1.47s ────────" },
];
const LINE_MS = 400;          // per test line
const SUMMARY_PAUSE_MS = 900; // extra beat before the pass-count rule lands

function renderTermLines(body, shown) {
  body.innerHTML = TEST_LINES.map((l, i) => {
    if (i >= shown) return "";
    if (l.cmd) return `<div class="term-line shown term-cmd">${l.text}</div>`;
    if (l.summary) return `<div class="term-line shown term-summary">${l.text}</div>`;
    return `<div class="term-line shown">${l.text}<span class="term-pass">PASSED</span></div>`;
  }).join("") + (shown < TEST_LINES.length ? `<span class="term-caret"></span>` : "");
}

function renderTerminal() {
  const body = document.getElementById("termBody");
  if (!body) return;
  if (REDUCED) { renderTermLines(body, TEST_LINES.length); return; }
  let started = false;
  const io = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting || started) return;
    started = true;
    io.disconnect();
    let shown = 1;
    renderTermLines(body, shown);
    const tick = () => {
      shown += 1;
      renderTermLines(body, shown);
      if (shown >= TEST_LINES.length) return;
      const nextIsSummary = TEST_LINES[shown].summary;
      setTimeout(tick, nextIsSummary ? SUMMARY_PAUSE_MS : LINE_MS);
    };
    setTimeout(tick, LINE_MS);
  }, { threshold: 0.3 });
  io.observe(body);
}

function renderStats(stats) {
  const tiles = [stats.charge_total_mismatches, stats.properties, stats.tenancies, stats.data_quality_flags];
  document.querySelectorAll(".stats .v").forEach((el, i) => {
    el.dataset.count = tiles[i];
    countObserver.observe(el);
  });
}

const FLAG_LABELS = {
  empty_rent_roll: "Empty rent roll",
  unit_availability_mismatch: "Unit availability mismatch",
  charge_total_mismatch: "Charge total mismatch",
  missing_charges: "Missing charges",
  missing_charges_partial: "Missing charges (partial)",
  unit_dimension_changed: "Unit dimension changed",
};

function renderAnomalies(anomalies) {
  const list = document.getElementById("anomalyList");
  if (!anomalies.length) {
    list.innerHTML = `<div class="anomaly-item">No anomalies flagged.</div>`;
    return;
  }
  list.innerHTML = anomalies.map((a) => `
    <div class="anomaly-item">
      <span class="anomaly-ic"><svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg></span>
      <div class="anomaly-body">
        <div class="type">${FLAG_LABELS[a.flag_type] || a.flag_type} &middot; ${a.property_id}</div>
        <div class="detail">${a.detail}</div>
      </div>
    </div>
  `).join("");
}

/* ── pipeline deep dives. Every string below is real and was verified against the
   file it names: the 176r row is row 7 of that exact workbook, the regexes are
   copied from scripts/etl/filenames.py, the flag text is the actual detail stored
   in data_quality_flags, the schema snippet is db/schema.sql's tenancies table,
   and the JSON is the live /revenue/portfolio response. Do not "improve" these
   numbers without re-checking the source. ── */
const STAGE_CONTENT = {
  ingest: `
    <div class="ld-grid">
      <div>
        <div class="ld-h">FILENAME &rarr; IDENTITY &middot; scripts/etl/filenames.py</div>
        <div class="ld-code">ResAnalytics_Rent_Roll_with_Lease_Charges_<b>176r</b>.xlsx

_CODE_RE  = r"_([A-Za-z0-9]+)\\.xlsx$"   &rarr; "<b>176r</b>"
_SPLIT_RE = r"^(\\d+)([A-Za-z]*)$"        &rarr; "<b>176</b>" + "<b>r</b>"

PROGRAM_SUFFIX_MAP = { r: residential, a: affordable,
                       c: commercial, land: land }</div>
        <div class="ld-note">No hardcoded property list anywhere. Identity comes from the filename pattern, so 25 files or 1,000 files load the same way.</div>
      </div>
      <div>
        <div class="ld-h">A REAL ROW &middot; 176r, row 7</div>
        <div class="ld-row"><span>Unit</span><span class="mono">1101 &middot; 176mxA01 &middot; 635 sq ft</span></div>
        <div class="ld-row"><span>Resident</span><span class="mono">t176r001 &middot; Resident 1</span></div>
        <div class="ld-row"><span>Market rent</span><span class="mono">$1,711</span></div>
        <div class="ld-row"><span>Lease</span><span class="mono">2025-05-23 &rarr; 2026-05-22</span></div>
        <div class="ld-row"><span>Charge lines</span><span class="mono">none &middot; Total 0</span></div>
        <div class="ld-note">A real resident with real rent and <b>zero recorded charges</b>. This exact pattern, found at load time, becomes the missing_charges flag in the next stage.</div>
      </div>
    </div>`,
  validate: `
    <div class="ld-h">CHECKS THAT RUN DURING THE LOAD &middot; scripts/load_data.py &middot; real catches shown</div>
    <div class="ld-flag"><span class="mono">charge_total_reconciliation</span><br>
      Every unit's charge lines are re-summed against the file's own stated Total, live. 4,106 tenancies, 9,177 charge lines, <b>zero mismatches</b>.</div>
    <div class="ld-flag"><span class="mono">missing_charges &middot; property 175</span><br>
      373 of 375 occupied/notice tenancies (99.5%) have zero recorded charge lines. Revenue for this property is understated in the source file itself; the file's own footer says lease_charges = 0.00.</div>
    <div class="ld-flag"><span class="mono">implausible_dates &middot; property 143</span><br>
      Unit 1-114 carries a lease expiring <b>2626-06-30</b>, six hundred years out. An obvious typo for 2026, caught because it is more than 30 years past the as-of date.</div>
    <div class="ld-flag"><span class="mono">unit_availability_mismatch &middot; property 153</span><br>
      The unit availability file states total_units = 0 while the matching rent roll has 7 real unit rows. Stale export, flagged automatically.</div>
    <div class="ld-note">Every catch becomes a queryable row in <b>data_quality_flags</b>, not a note in a doc. The dashboard's Watchpoints and the copilot's answers read from the same table.</div>`,
  structure: `
    <div class="ld-grid">
      <div>
        <div class="ld-h">THE TABLE IT BECOMES &middot; db/schema.sql</div>
        <div class="ld-code">CREATE TABLE <b>tenancies</b> (
  tenancy_id   INTEGER PRIMARY KEY,
  snapshot_id  &rarr; data_snapshots,
  unit_id      &rarr; units,
  section      CHECK (current | future_applicant),
  <b>status</b>       CHECK (occupied | vacant |
                      model | down | notice),
  market_rent, resident_deposit,
  move_in, lease_expiration, move_out,
  balance
);</div>
      </div>
      <div>
        <div class="ld-h">WHAT GOT NORMALIZED ON THE WAY IN</div>
        <div class="ld-row"><span>"VACANT" typed in the resident field</span><span class="mono">&rarr; status enum</span></div>
        <div class="ld-row"><span>MM/DD/YYYY header dates</span><span class="mono">&rarr; ISO dates</span></div>
        <div class="ld-row"><span>Nested unit + charge rows</span><span class="mono">&rarr; tenancies + charges</span></div>
        <div class="ld-row"><span>25 files, name spellings vary</span><span class="mono">&rarr; 15 properties by code</span></div>
        <div class="ld-note">Snapshot-based on purpose: loading next month's files is just more <b>data_snapshots</b> rows, not a redesign. Charges stay line-item level so revenue can be recategorized without reloading.</div>
      </div>
    </div>`,
  understand: `
    <div class="ld-grid">
      <div>
        <div class="ld-h">THE ENDPOINT &middot; GET /revenue/portfolio</div>
        <div class="ld-code">{
  "total_gross_revenue":  <b>7703949.39</b>,
  "total_concessions":    <b>-144087.14</b>,
  "total_net_effective_revenue": <b>7559862.25</b>,
  "by_property": [
    { "property_id": "144",
      "canonical_name": "Winners Circle",
      "net_effective_revenue": 1636735.63 },
    ...14 more
  ]
}</div>
      </div>
      <div>
        <div class="ld-h">THE SAME DATA, EVERY SURFACE</div>
        <div class="ld-row"><span>Dashboard KPI card</span><span class="mono">$7,559,862</span></div>
        <div class="ld-arrow">same function, one hop down</div>
        <div class="ld-row"><span>Copilot tool <span class="mono">portfolio_revenue</span></span><span class="mono">"$7.56M"</span></div>
        <div class="ld-note">The copilot's tools are direct calls into the same handler functions the dashboard fetches. No second data path, no model-side math: if the number is wrong on one surface it is wrong on both, and the tests catch it once.</div>
      </div>
    </div>`,
};

/* pulse rides the track to the clicked node, then that stage's panel opens */
function initPipelineDive() {
  const track = document.getElementById("loopTrack");
  const pulse = document.getElementById("loopPulse");
  const detail = document.getElementById("loopDetail");
  if (!track) return;
  const nodes = [...track.querySelectorAll(".loop-node")];
  let current = null;

  nodes.forEach((node) => {
    node.addEventListener("click", () => {
      const stage = node.dataset.stage;
      if (current === stage) {
        detail.classList.remove("open");
        node.classList.remove("active");
        pulse.classList.remove("riding");
        current = null;
        return;
      }
      nodes.forEach((n) => n.classList.toggle("active", n === node));
      current = stage;

      // ride the pulse along the track to this node's center, then open
      const trackRect = track.getBoundingClientRect();
      const dotRect = node.querySelector(".loop-dot").getBoundingClientRect();
      const targetPct = ((dotRect.left + dotRect.width / 2 - trackRect.left) / trackRect.width) * 100;
      pulse.classList.add("riding");
      pulse.style.left = targetPct + "%";

      const open = () => {
        detail.innerHTML = `<div class="ld-card">${STAGE_CONTENT[stage]}</div>`;
        detail.classList.add("open");
      };
      if (REDUCED) open();
      else setTimeout(open, 480);
    });
  });
}

/* ── layer deep dives: what I did / what I found, per architecture layer. All
   real catches from this build -- sources: CLAUDE.md sections 1/6/7 and the live
   investigations run during this session. Matter-of-fact on purpose. ── */
const LAYER_DIVES = {
  source: { tag: "SOURCE DATA", title: "50 Excel files, taken as they came", did: [
      "Walked all 50 files <b>programmatically</b>, not spot-checked: layout verified against every file before a single schema decision.",
      "Cross-referenced Unit Availability against independently counted Rent Roll rows, file by file.",
      "Found all <b>32 real charge codes</b> by scanning every charge line in every file, not by trusting a sample.",
    ], found: [
      "<b>3 structurally empty rent rolls</b> (134land, 183c, altapm): headers, zero unit rows, footers of straight zeros.",
      "VACANT / MODEL / DOWN hiding in the <b>resident code field</b>, not a status column.",
      "Commercial leases at The Ellsworth (143c) where market_rent is literally 0 in the file and the real rent lives in RENTRETL + CAMEST charge lines instead. Looked like a scraping bug; it is how the source prices retail.",
    ] },
  etl: { tag: "ETL / LOADER", title: "Parse, validate inline, write, repeat safely", did: [
      "Identity from the <b>filename pattern</b> (176r &rarr; property 176, residential): no hardcoded property list anywhere.",
      "Charge lines re-summed against each unit's own stated Total, live, during the load.",
      "Idempotent re-runs: renamed or removed source files reconcile instead of orphaning snapshots.",
    ], found: [
      "The missing_charges check had <b>blind spots of its own</b>: first 'notice' tenants (33 more affected), then commercial units with market_rent 0, which were hiding the portfolio's single largest delinquency: <b>$178,806.41</b>.",
      "as_of_date stored as MM/DD/YYYY silently broke every SQL date comparison; fixed at the parser, not patched in queries.",
      "A renamed source file left an orphan snapshot that <b>double-counted revenue</b> until identity-based matching replaced filename matching.",
    ] },
  db: { tag: "DATABASE", title: "Normalized, snapshot-based, honest", did: [
      "One table per real-world thing: properties &rarr; units &rarr; tenancies &rarr; charges, plus lookup and flag tables.",
      "Snapshot design: a second month of data is <b>purely additive</b>, no redesign.",
      "Data quality findings stored as queryable rows, not tribal knowledge.",
    ], found: [
      "The hand-count said 16 properties; the loader's dedup said <b>15</b>. The dedup was right.",
      "The Halden has residential + affordable snapshots, and the first revenue views grouped by snapshot_id, <b>splitting one property's revenue across two rows</b>. Caught by sanity-checking views against real data before building on them.",
    ] },
  api: { tag: "API LAYER", title: "Narrow endpoints that double as AI tools", did: [
      "Every endpoint deliberately small and single-purpose, so each one doubles as a <b>tool definition</b> for the copilot.",
      "One read-only SQLite connection per request; the same db file the loader writes.",
    ], found: [
      "<b>Route order bug</b>: /revenue/{property_id} declared before /revenue/concentration swallowed the literal path as a property code.",
      "Inner joins made zero-charge properties <b>vanish</b> from /revenue/portfolio instead of showing an honest $0. LEFT JOIN + COALESCE fixed the lie.",
    ] },
  ai: { tag: "AI LAYER", title: "A thin, checkable slice on top", did: [
      "An agent loop over <b>16 tools</b>, each one a wrapper around a real endpoint. The model never touches SQL or files directly.",
      "A grounding check compares every $ and % the model states against the tool data it was actually given.",
      "Verify receipts: every answer lists the exact calls made, arguments included.",
    ], found: [
      "One QA pass caught <b>four real hallucinations</b>: 'no leases have expired' (331 had), guessed unit IDs, an invented property name ('Sutton Hill'), and a market region the data has no field for.",
      "The grounding check's own percent-matching was unsound at first: it accepted a fabricated 88.4% because <b>some pair of numbers coincidentally divided to it</b>. Tightened before shipping.",
    ] },
  surfaces: { tag: "SURFACES", title: "Two fronts, one truth", did: [
      "Dashboard and copilot both read the same API. If a number is wrong on one, it is wrong on both, and one test catches it.",
      "Every chat evidence card renders from the raw tool payload, costing zero model tokens.",
    ], found: [
      "Chat cards silently <b>collapsed to 30px strips</b> past one screenful: column-flexbox children shrink by default, and overflow:hidden removed the min-height that was saving the text bubbles.",
      "A sorted-distribution area chart read as a <b>declining trend line</b>, a false story for a one-snapshot dataset. Replaced with distribution bars.",
    ] },
};

function initLayerDives() {
  const modal = document.getElementById("layerModal");
  if (!modal) return;
  const close = () => { modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); };
  document.getElementById("layerBackdrop").addEventListener("click", close);
  document.getElementById("layerClose").addEventListener("click", close);
  addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  document.querySelectorAll(".arch-explore").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = LAYER_DIVES[btn.dataset.layer];
      if (!d) return;
      document.getElementById("layerModalBody").innerHTML = `
        <div class="gate-eyebrow">${d.tag}</div>
        <h2>${d.title}</h2>
        <div class="layer-dive-grid">
          <div><div class="layer-dive-h">WHAT I DID</div>
            ${d.did.map((t) => `<div class="dive-item">${t}</div>`).join("")}</div>
          <div><div class="layer-dive-h found">WHAT I FOUND</div>
            ${d.found.map((t) => `<div class="dive-item found">${t}</div>`).join("")}</div>
        </div>`;
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
    });
  });
}

async function init() {
  const [stats, anomalies] = await Promise.all([api("/stats"), api("/anomalies")]);
  renderStats(stats);
  renderTerminal();
  renderAnomalies(anomalies);
  initPipelineDive();
  initLayerDives();
  observeReveals();
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="position:fixed;top:0;left:0;right:0;z-index:999;background:#f87171;color:#1a0000;padding:10px;text-align:center;font-family:monospace;font-size:13px">Failed to load: ${err.message}</div>`
  );
});
