let CURRENT_PROPERTY_ID = null; // null = portfolio view
// Portfolio-wide data fetched once at load and reused when returning from a property
// view -- it's a single-snapshot database, nothing changes between clicks, so
// re-fetching three endpoints on every back-click was pure waste.
let PORTFOLIO = null;

async function init() {
  const [revenue, properties, occupancy, concentration, delinquent, leases] = await Promise.all([
    api("/revenue/portfolio"),
    api("/properties"),
    api("/occupancy/portfolio"),
    api("/revenue/concentration"),
    api("/delinquent"),
    api("/leases/expiring?days=60"),
  ]);

  PORTFOLIO = { revenue, properties, occupancy, delinquent, leases: leases.leases, leaseRef: leases.reference_date };
  const sortedByRevenue = [...revenue.by_property].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue);

  renderSidebar(sortedByRevenue);
  renderPortfolioKpis(revenue, occupancy, delinquent, leases.leases, leases.reference_date);
  renderRevenueChart(sortedByRevenue);
  renderOccupancyChart(occupancy.by_property, sortedByRevenue);
  renderDonut(revenue.by_category);
  renderConcentration(concentration);
  renderDelinquentList("delinquentList", delinquent);
  renderLeaseList("leaseList", leases.leases);

  const first = await api(`/properties/${sortedByRevenue[0].property_id}`);
  document.getElementById("asOfNote").textContent = `AS OF ${first?.latest_as_of_date?.rent_roll || "—"}`;

  document.getElementById("dashSearch").addEventListener("input", (e) => {
    renderSidebar(sortedByRevenue, e.target.value);
  });
  document.getElementById("dashBack").addEventListener("click", () => showPortfolioView());

  observeReveals();
}

function renderSidebar(sorted, query = "") {
  const list = document.getElementById("dashPropertyList");
  const q = query.trim().toLowerCase();
  const matches = q ? sorted.filter((p) => p.canonical_name.toLowerCase().includes(q)) : sorted;

  const allItem = `<div class="dash-pitem all ${CURRENT_PROPERTY_ID === null ? "on" : ""}" data-id="">
    <span>All properties</span>
  </div>`;

  const items = matches.map((p) => `
    <div class="dash-pitem ${CURRENT_PROPERTY_ID === p.property_id ? "on" : ""}" data-id="${p.property_id}">
      <span>${p.canonical_name}</span>
      <span class="pi-amt mono">${fmtMoney(p.net_effective_revenue)}</span>
    </div>
  `).join("");

  list.innerHTML = allItem + items;
  list.querySelectorAll(".dash-pitem").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      if (!id) showPortfolioView();
      else showPropertyView(id);
    });
  });
}

function sortedPortfolio() {
  return [...PORTFOLIO.revenue.by_property].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue);
}

function showPortfolioView() {
  CURRENT_PROPERTY_ID = null;
  document.getElementById("dashPortfolioView").style.display = "";
  document.getElementById("dashPropertyView").style.display = "none";
  renderSidebar(sortedPortfolio(), document.getElementById("dashSearch").value);
  renderPortfolioKpis(PORTFOLIO.revenue, PORTFOLIO.occupancy, PORTFOLIO.delinquent, PORTFOLIO.leases, PORTFOLIO.leaseRef);
}

async function showPropertyView(propertyId) {
  CURRENT_PROPERTY_ID = propertyId;
  document.getElementById("dashPortfolioView").style.display = "none";
  document.getElementById("dashPropertyView").style.display = "";

  renderSidebar(sortedPortfolio(), document.getElementById("dashSearch").value);

  const [rev, occ, delinquent, leases, units] = await Promise.all([
    api(`/revenue/${propertyId}`),
    api(`/occupancy/${propertyId}`),
    api(`/delinquent?property_id=${propertyId}`),
    api(`/leases/expiring?days=60&property_id=${propertyId}`),
    api(`/properties/${propertyId}/units`),
  ]);

  document.getElementById("pName").textContent = rev.canonical_name;
  document.getElementById("pId").textContent = propertyId;

  renderPropertyKpis(rev, occ, delinquent, leases.leases);
  renderUnitsTable(units);

  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── KPI tiles with a small real-data visual under each number. No trend lines on
   purpose -- one snapshot loaded, so every mini-viz shows composition, not time.
   pop (optional) is extra detail HTML shown in a hover popover -- this replaced the
   property view's separate revenue/delinquent/rollover panels. ── */
function kpiTile(value, label, vizId, legend, pop) {
  const viz = vizId ? `<canvas id="${vizId}"></canvas>` : "";
  const leg = legend ? `<div class="kpi-legend">${legend}</div>` : "";
  const popEl = pop ? `<div class="kpi-pop">${pop}</div>` : "";
  return `<div class="kpi-tile ${pop ? "has-pop" : ""}"><div class="kv">${value}</div><div class="kk">${label}</div>${viz}${leg}${popEl}</div>`;
}

function popRows(pairs) {
  return pairs.map(([k, v, cls]) =>
    `<div class="pop-row"><span>${k}</span><span class="mono ${cls || ""}">${v}</span></div>`
  ).join("");
}

/* segmented horizontal bar: segments = [{value, color}] */
function drawKpiSegments(id, segments) {
  const cv = document.getElementById(id);
  if (!cv) return;
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const barY = h / 2 - 4, barH = 8;
  let x = 0;
  segments.forEach((seg, i) => {
    const segW = (seg.value / total) * w;
    ctx.fillStyle = seg.color;
    ctx.beginPath();
    ctx.roundRect(x, barY, Math.max(segW - (i < segments.length - 1 ? 2 : 0), 0), barH, 3);
    ctx.fill();
    x += segW;
  });
}

/* progress track for a single percentage */
function drawKpiProgress(id, pct) {
  const cv = document.getElementById(id);
  if (!cv) return;
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const barY = h / 2 - 4, barH = 8;
  ctx.fillStyle = "rgba(148,163,184,.14)";
  ctx.beginPath(); ctx.roundRect(0, barY, w, barH, 99); ctx.fill();
  const grad = ctx.createLinearGradient(0, 0, w * pct / 100, 0);
  grad.addColorStop(0, "#7FC79B"); grad.addColorStop(1, "#3E6B4F");
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.roundRect(0, barY, Math.max(w * pct / 100, 4), barH, 99); ctx.fill();
}

const SEG_PALETTE = ["#7FC79B", "#3E6B4F", "#9AA49D", "#a78bfa", "#C9A96A", "#5E675F"];

function topSegments(rows, getValue, topN = 5) {
  const sorted = [...rows].sort((a, b) => getValue(b) - getValue(a));
  const top = sorted.slice(0, topN).filter((r) => getValue(r) > 0);
  const rest = sorted.slice(topN).reduce((s, r) => s + Math.max(getValue(r), 0), 0);
  const segs = top.map((r, i) => ({ value: getValue(r), color: SEG_PALETTE[i % SEG_PALETTE.length] }));
  if (rest > 0) segs.push({ value: rest, color: "rgba(148,163,184,.25)" });
  return segs;
}

function renderPortfolioKpis(revenue, occupancy, delinquent, leases, leaseRefDate) {
  const totalDelinquent = delinquent.reduce((s, r) => s + r.balance, 0);
  // split the 60-day rollover window at ref+30d, computed from the API's own
  // reference_date rather than hardcoded
  const d = new Date(leaseRefDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 30);
  const cutoff30 = d.toISOString().slice(0, 10);
  const within30 = leases.filter((l) => l.lease_expiration <= cutoff30).length;

  const topProps = [...revenue.by_property]
    .sort((a, b) => b.net_effective_revenue - a.net_effective_revenue).slice(0, 5);
  const netPop = popRows(topProps.map((p) => [p.canonical_name, fmtMoney(p.net_effective_revenue)]));
  const grossPop = popRows([
    ["Gross", fmtMoney(revenue.total_gross_revenue)],
    ["Concessions", fmtMoneySigned(revenue.total_concessions), "down"],
    ["Net effective", fmtMoney(revenue.total_net_effective_revenue), "up"],
  ]);
  const delinquentPop = popRows(
    delinquent.slice(0, 6).map((r) => [`${r.resident_name} · ${r.property_id}/${r.unit_number}`, fmtMoney(r.balance), "down"])
  );
  const rolloverPop = popRows(
    leases.slice(0, 6).map((l) => [`${l.property_id}/${l.unit_number} · exp ${l.lease_expiration}`, l.market_rent ? fmtMoney(l.market_rent) : "—"])
  );

  document.getElementById("dashKpiStrip").innerHTML =
    kpiTile(fmtMoney(revenue.total_net_effective_revenue), "Net effective revenue",
      "kpiNetViz", "TOP 5 PROPERTIES + REST", netPop) +
    kpiTile(fmtMoney(revenue.total_gross_revenue), "Gross revenue",
      "kpiGrossViz", "GROSS VS CONCESSIONS", grossPop) +
    kpiTile(occupancy.pct_occ != null ? occupancy.pct_occ.toFixed(1) + "%" : "—", "Occupancy",
      "kpiOccViz", `${occupancy.total_occupied} OF ${occupancy.total_units} UNITS`) +
    kpiTile(fmtMoney(totalDelinquent), "Total delinquent",
      "kpiDelViz", "TOP 5 BALANCES + REST", delinquentPop) +
    kpiTile(leases.length, "Leases rolling over (60d)",
      "kpiRollViz", `${within30} WITHIN 30D · ${leases.length - within30} IN 31-60D`, rolloverPop);

  drawKpiSegments("kpiNetViz", topSegments(revenue.by_property, (p) => p.net_effective_revenue));
  drawKpiSegments("kpiGrossViz", [
    { value: revenue.total_gross_revenue, color: "#7FC79B" },
    { value: Math.abs(revenue.total_concessions), color: "#E2836F" },
  ]);
  if (occupancy.pct_occ != null) drawKpiProgress("kpiOccViz", occupancy.pct_occ);
  drawKpiSegments("kpiDelViz", topSegments(delinquent, (r) => r.balance).map((s) => ({ ...s, color: s.color === "rgba(148,163,184,.25)" ? s.color : "#E2836F" })));
  drawKpiSegments("kpiRollViz", [
    { value: within30 || 0.0001, color: "#C9A96A" },
    { value: (leases.length - within30) || 0.0001, color: "rgba(201,169,106,.35)" },
  ]);
}

function renderPropertyKpis(rev, occ, delinquent, leases) {
  const totalDelinquent = delinquent.reduce((s, r) => s + r.balance, 0);

  // hover popovers carry what used to be the separate revenue/delinquent/rollover
  // panels: full breakdown on the revenue tile, top balances on the delinquent tile,
  // next expirations on the rollover tile
  const revenuePop = popRows([
    ["Gross", fmtMoney(rev.gross_revenue)],
    ["Concessions", fmtMoneySigned(rev.concessions), "down"],
    ["Net effective", fmtMoney(rev.net_effective_revenue), "up"],
    ...rev.by_category.map((c) => ["&nbsp;&nbsp;" + c.category.replace("_", " "), fmtMoneySigned(c.amount)]),
  ]);
  const occPop = popRows([
    ["Occupied", occ.occupied],
    ["On notice", occ.on_notice],
    ["Vacant", occ.vacant],
    ["Avg rent", occ.avg_rent ? fmtMoney(occ.avg_rent) : "—"],
    ["Avg sq ft", occ.avg_sq_ft ? Math.round(occ.avg_sq_ft) : "—"],
  ]);
  const delinquentPop = delinquent.length
    ? popRows(delinquent.slice(0, 6).map((r) => [`${r.resident_name} · ${r.unit_number}`, fmtMoney(r.balance), "down"]))
    : `<div class="pop-empty">No outstanding balances.</div>`;
  const rolloverPop = leases.length
    ? popRows(leases.slice(0, 6).map((l) => [`${l.unit_number} · exp ${l.lease_expiration}`, l.market_rent ? fmtMoney(l.market_rent) : "—"]))
    : `<div class="pop-empty">Nothing expiring in this window.</div>`;

  document.getElementById("dashKpiStrip").innerHTML =
    kpiTile(fmtMoney(rev.net_effective_revenue), "Net effective revenue",
      "kpiPNetViz", "NET VS CONCESSIONS · HOVER FOR BREAKDOWN", revenuePop) +
    kpiTile(occ.pct_occ != null ? occ.pct_occ.toFixed(1) + "%" : "—", "Occupancy",
      "kpiPOccViz", `${occ.occupied} OF ${occ.total_units} UNITS`, occPop) +
    kpiTile(occ.total_units, "Units",
      "kpiPUnitsViz", `${occ.occupied} OCC · ${occ.on_notice} NOTICE · ${occ.vacant} VACANT`, occPop) +
    kpiTile(fmtMoney(totalDelinquent), "Delinquent",
      "kpiPDelViz", "TOP 5 BALANCES + REST · HOVER FOR NAMES", delinquentPop) +
    kpiTile(leases.length, "Rolling over (60d)", null, "HOVER FOR NEXT EXPIRATIONS", rolloverPop);

  drawKpiSegments("kpiPNetViz", [
    { value: rev.net_effective_revenue || 0.0001, color: "#4CAF82" },
    { value: Math.abs(rev.concessions), color: "#E2836F" },
  ]);
  if (occ.pct_occ != null) drawKpiProgress("kpiPOccViz", occ.pct_occ);
  drawKpiSegments("kpiPUnitsViz", [
    { value: occ.occupied || 0.0001, color: "#4CAF82" },
    { value: occ.on_notice, color: "#C9A96A" },
    { value: occ.vacant, color: "#E2836F" },
  ].filter((s) => s.value > 0));
  drawKpiSegments("kpiPDelViz", topSegments(delinquent, (r) => r.balance).map((s) => ({ ...s, color: s.color === "rgba(148,163,184,.25)" ? s.color : "#E2836F" })));
}

function renderRevenueChart(sorted) {
  const cv = document.getElementById("revenueChart");
  const tip = document.getElementById("revenueTip");
  animateOnceVisible(cv, (progress) => drawRevenueChart(cv, tip, sorted, progress));
}

function renderOccupancyChart(byProperty, sortedByRevenue) {
  const cv = document.getElementById("occupancyChart");
  const tip = document.getElementById("occupancyTip");
  // order to match the revenue chart so the two panels are easy to cross-reference
  const order = sortedByRevenue.map((p) => p.property_id);
  const sorted = [...byProperty].sort((a, b) => order.indexOf(a.property_id) - order.indexOf(b.property_id));
  animateOnceVisible(cv, (progress) => drawOccupancyChart(cv, tip, sorted, progress));
}

function renderDonut(byCategory) {
  const cv = document.getElementById("donutChart");
  animateOnceVisible(cv, (progress) => drawDonut(cv, byCategory, progress));
  renderDonutLegend(document.getElementById("donutLegend"), byCategory);
}

function renderConcentration(rows) {
  const cv = document.getElementById("concChart");
  animateOnceVisible(cv, (progress) => drawDonut(cv, rows, progress, "program_type"));
  renderDonutLegend(document.getElementById("concLegend"), rows, "program_type");
}

/* ── units table with lookup + filters. All filtering is client-side over the units
   already fetched for the selected property -- no refetch per keystroke. ── */
let PROPERTY_UNITS = [];

function renderUnitsTable(units) {
  PROPERTY_UNITS = units;

  const statuses = [...new Set(units.map((u) => u.status || "vacant"))].sort();
  const types = [...new Set(units.map((u) => u.unit_type).filter(Boolean))].sort();
  document.getElementById("unitStatusFilter").innerHTML =
    `<option value="">All statuses</option>` + statuses.map((s) => `<option value="${s}">${s}</option>`).join("");
  document.getElementById("unitTypeFilter").innerHTML =
    `<option value="">All types</option>` + types.map((t) => `<option value="${t}">${t}</option>`).join("");
  document.getElementById("unitSearch").value = "";

  applyUnitFilters();
}

function applyUnitFilters() {
  const q = document.getElementById("unitSearch").value.trim().toLowerCase();
  const status = document.getElementById("unitStatusFilter").value;
  const type = document.getElementById("unitTypeFilter").value;

  const filtered = PROPERTY_UNITS.filter((u) => {
    if (status && (u.status || "vacant") !== status) return false;
    if (type && u.unit_type !== type) return false;
    if (q && !(
      u.unit_number.toLowerCase().includes(q) ||
      (u.resident_name || "").toLowerCase().includes(q)
    )) return false;
    return true;
  });

  document.getElementById("unitsCount").textContent =
    filtered.length === PROPERTY_UNITS.length
      ? `${PROPERTY_UNITS.length} units`
      : `${filtered.length} of ${PROPERTY_UNITS.length} units`;

  document.getElementById("unitsBody").innerHTML = filtered.map((u) => {
    const status = u.status || "vacant";
    return `<tr data-unit-id="${u.unit_id}">
      <td class="strong">${u.unit_number}</td>
      <td>${u.unit_type || "—"}</td>
      <td class="mono">${u.sq_ft ? Math.round(u.sq_ft) : "—"}</td>
      <td><span class="units-status ${status}">${status}</span></td>
      <td>${u.resident_name || "—"}</td>
      <td class="mono">${u.market_rent ? fmtMoney(u.market_rent) : "—"}</td>
      <td class="mono">${u.balance ? fmtMoney(u.balance) : "—"}</td>
      <td class="mono">${u.lease_expiration || "—"}</td>
    </tr>`;
  }).join("");
}

document.getElementById("unitSearch").addEventListener("input", applyUnitFilters);
document.getElementById("unitStatusFilter").addEventListener("change", applyUnitFilters);
document.getElementById("unitTypeFilter").addEventListener("change", applyUnitFilters);

/* ── unit detail modal: click a row -> /units/{id} -> tenancy facts + real charge
   lines. No history section on purpose (one snapshot loaded); if a billable unit has
   zero charge lines, the modal says so explicitly instead of showing a blank. ── */
const unitModal = document.getElementById("unitModal");

function closeUnitModal() {
  unitModal.classList.remove("open");
  unitModal.setAttribute("aria-hidden", "true");
}
document.getElementById("unitModalBackdrop").addEventListener("click", closeUnitModal);
document.getElementById("unitModalClose").addEventListener("click", closeUnitModal);
addEventListener("keydown", (e) => { if (e.key === "Escape") closeUnitModal(); });

document.getElementById("unitsBody").addEventListener("click", async (e) => {
  const row = e.target.closest("tr[data-unit-id]");
  if (!row) return;
  const detail = await api(`/units/${row.dataset.unitId}`);
  const t = detail.tenancy;

  const facts = popRows([
    ["Status", t ? t.status : "no current tenancy"],
    ["Resident", t?.resident_name || "—"],
    ["Program", detail.program_type],
    ["Sq ft", detail.sq_ft ? Math.round(detail.sq_ft) : "—"],
    ["Market rent", t?.market_rent ? fmtMoney(t.market_rent) : "—"],
    ["Deposit", t?.resident_deposit ? fmtMoney(t.resident_deposit) : "—"],
    ["Move in", t?.move_in || "—"],
    ["Lease expires", t?.lease_expiration || "—"],
    ["Move out", t?.move_out || "—"],
    ["Balance", t?.balance ? fmtMoney(t.balance) : "$0", t?.balance > 0 ? "down" : ""],
  ]);

  let chargesHtml;
  if (detail.charges.length) {
    chargesHtml = popRows(detail.charges.map((c) =>
      [`${c.charge_code} · ${c.category.replace("_", " ")}`, fmtMoneySigned(c.amount), c.amount < 0 ? "down" : ""]
    )) + popRows([["Total", fmtMoney(detail.total_charges), "up"]]);
  } else if (t && (t.status === "occupied" || t.status === "notice") ) {
    chargesHtml = `<div class="unit-gap-note">No charge lines recorded for this tenancy in the
      source file despite an active resident -- this is the missing_charges data quality gap
      (see Anomalies on the How it's built page). Revenue for this unit is understated.</div>`;
  } else {
    chargesHtml = `<div class="pop-empty">No charges -- unit has no billable tenancy.</div>`;
  }

  document.getElementById("unitModalBody").innerHTML = `
    <div class="gate-eyebrow">${detail.canonical_name} &middot; ${detail.property_id}</div>
    <h2>Unit ${detail.unit_number}</h2>
    <p class="mono" style="font-size:11px">${detail.unit_type || ""}</p>
    <div class="unit-modal-grid">
      <div><div class="unit-modal-heading">TENANCY</div>${facts}</div>
      <div><div class="unit-modal-heading">CHARGE LINES · THIS PERIOD</div>${chargesHtml}</div>
    </div>`;
  unitModal.classList.add("open");
  unitModal.setAttribute("aria-hidden", "false");
});

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="position:fixed;top:0;left:0;right:0;z-index:999;background:#f87171;color:#1a0000;padding:10px;text-align:center;font-family:monospace;font-size:13px">Failed to load dashboard: ${err.message}</div>`
  );
});
