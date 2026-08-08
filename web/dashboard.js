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

  const gross = rev.gross_revenue, net = rev.net_effective_revenue;
  const max = Math.max(gross, net) || 1;
  requestAnimationFrame(() => {
    document.getElementById("wfGross").style.height = (gross / max) * 100 + "%";
    document.getElementById("wfConc").style.height = (Math.abs(rev.concessions) / max) * 100 + "%";
    document.getElementById("wfNet").style.height = (net / max) * 100 + "%";
    ["wfGrossVal", "wfConcVal", "wfNetVal"].forEach((id) => document.getElementById(id).classList.add("shown"));
    document.getElementById("wfGrossVal").textContent = fmtMoney(gross);
    document.getElementById("wfConcVal").textContent = fmtMoneySigned(rev.concessions);
    document.getElementById("wfNetVal").textContent = fmtMoney(net);
  });

  renderDelinquentList("pDelinquentList", delinquent);
  renderLeaseList("pLeaseList", leases.leases);
  renderUnitsTable(units);

  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── KPI tiles with a small real-data visual under each number. No trend lines on
   purpose -- one snapshot loaded, so every mini-viz shows composition, not time. ── */
function kpiTile(value, label, vizId, legend) {
  const viz = vizId ? `<canvas id="${vizId}"></canvas>` : "";
  const leg = legend ? `<div class="kpi-legend">${legend}</div>` : "";
  return `<div class="kpi-tile"><div class="kv">${value}</div><div class="kk">${label}</div>${viz}${leg}</div>`;
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
  grad.addColorStop(0, "#6fd2ff"); grad.addColorStop(1, "#3fa9e8");
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.roundRect(0, barY, Math.max(w * pct / 100, 4), barH, 99); ctx.fill();
}

const SEG_PALETTE = ["#6fd2ff", "#3fa9e8", "#94a3b8", "#a78bfa", "#f0b429", "#5e6673"];

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

  document.getElementById("dashKpiStrip").innerHTML =
    kpiTile(fmtMoney(revenue.total_net_effective_revenue), "Net effective revenue",
      "kpiNetViz", "TOP 5 PROPERTIES + REST") +
    kpiTile(fmtMoney(revenue.total_gross_revenue), "Gross revenue",
      "kpiGrossViz", "GROSS VS CONCESSIONS") +
    kpiTile(occupancy.pct_occ != null ? occupancy.pct_occ.toFixed(1) + "%" : "—", "Occupancy",
      "kpiOccViz", `${occupancy.total_occupied} OF ${occupancy.total_units} UNITS`) +
    kpiTile(fmtMoney(totalDelinquent), "Total delinquent",
      "kpiDelViz", "TOP 5 BALANCES + REST") +
    kpiTile(leases.length, "Leases rolling over (60d)",
      "kpiRollViz", `${within30} WITHIN 30D · ${leases.length - within30} IN 31-60D`);

  drawKpiSegments("kpiNetViz", topSegments(revenue.by_property, (p) => p.net_effective_revenue));
  drawKpiSegments("kpiGrossViz", [
    { value: revenue.total_gross_revenue, color: "#6fd2ff" },
    { value: Math.abs(revenue.total_concessions), color: "#f87171" },
  ]);
  if (occupancy.pct_occ != null) drawKpiProgress("kpiOccViz", occupancy.pct_occ);
  drawKpiSegments("kpiDelViz", topSegments(delinquent, (r) => r.balance).map((s) => ({ ...s, color: s.color === "rgba(148,163,184,.25)" ? s.color : "#f87171" })));
  drawKpiSegments("kpiRollViz", [
    { value: within30 || 0.0001, color: "#f0b429" },
    { value: (leases.length - within30) || 0.0001, color: "rgba(240,180,41,.3)" },
  ]);
}

function renderPropertyKpis(rev, occ, delinquent, leases) {
  const totalDelinquent = delinquent.reduce((s, r) => s + r.balance, 0);
  document.getElementById("dashKpiStrip").innerHTML =
    kpiTile(fmtMoney(rev.net_effective_revenue), "Net effective revenue",
      "kpiPNetViz", "NET VS CONCESSIONS") +
    kpiTile(occ.pct_occ != null ? occ.pct_occ.toFixed(1) + "%" : "—", "Occupancy",
      "kpiPOccViz", `${occ.occupied} OF ${occ.total_units} UNITS`) +
    kpiTile(occ.total_units, "Units",
      "kpiPUnitsViz", `${occ.occupied} OCC · ${occ.on_notice} NOTICE · ${occ.vacant} VACANT`) +
    kpiTile(fmtMoney(totalDelinquent), "Delinquent",
      "kpiPDelViz", "TOP 5 BALANCES + REST") +
    kpiTile(leases.length, "Rolling over (60d)");

  drawKpiSegments("kpiPNetViz", [
    { value: rev.net_effective_revenue || 0.0001, color: "#34d399" },
    { value: Math.abs(rev.concessions), color: "#f87171" },
  ]);
  if (occ.pct_occ != null) drawKpiProgress("kpiPOccViz", occ.pct_occ);
  drawKpiSegments("kpiPUnitsViz", [
    { value: occ.occupied || 0.0001, color: "#34d399" },
    { value: occ.on_notice, color: "#f0b429" },
    { value: occ.vacant, color: "#f87171" },
  ].filter((s) => s.value > 0));
  drawKpiSegments("kpiPDelViz", topSegments(delinquent, (r) => r.balance).map((s) => ({ ...s, color: s.color === "rgba(148,163,184,.25)" ? s.color : "#f87171" })));
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
    return `<tr>
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

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="position:fixed;top:0;left:0;right:0;z-index:999;background:#f87171;color:#1a0000;padding:10px;text-align:center;font-family:monospace;font-size:13px">Failed to load dashboard: ${err.message}</div>`
  );
});
