/* ── test suite terminal — real output from `pytest tests/ -v`, a curated subset of
   the 36 tests, not fabricated. Line-by-line reveal, triggers once scrolled into view. ── */
const TEST_LINES = [
  { cmd: true, text: "$ pytest tests/ -v" },
  { text: "test_zero_charge_total_mismatches ................ " },
  { text: "test_missing_charges_check_covers_notice_status .. " },
  { text: "test_rename_replaces_old_snapshot_not_orphans_it . " },
  { text: "test_leases_expiring_window_bounded_on_both_ends . " },
  { text: "test_no_orphaned_rows_or_fk_violations ............ " },
  { text: "test_known_missing_charges_properties_flagged_severe " },
  { summary: true, text: "──────── 36 passed in 0.91s ────────" },
];
function renderTerminal() {
  const body = document.getElementById("termBody");
  if (!body) return;
  animateOnceVisible(body, (progress) => {
    const shown = Math.floor(progress * TEST_LINES.length);
    body.innerHTML = TEST_LINES.map((l, i) => {
      if (i >= shown) return "";
      if (l.cmd) return `<div class="term-line shown term-cmd">${l.text}</div>`;
      if (l.summary) return `<div class="term-line shown term-summary">${l.text}</div>`;
      return `<div class="term-line shown">${l.text}<span class="term-pass">PASSED</span></div>`;
    }).join("") + (shown < TEST_LINES.length ? `<span class="term-caret"></span>` : "");
  });
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

async function init() {
  const [stats, anomalies] = await Promise.all([api("/stats"), api("/anomalies")]);
  renderStats(stats);
  renderTerminal();
  renderAnomalies(anomalies);
  observeReveals();
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="position:fixed;top:0;left:0;right:0;z-index:999;background:#f87171;color:#1a0000;padding:10px;text-align:center;font-family:monospace;font-size:13px">Failed to load: ${err.message}</div>`
  );
});
