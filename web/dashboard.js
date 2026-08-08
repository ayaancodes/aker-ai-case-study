let ALL_PROPERTIES = [];
let PORTFOLIO_REVENUE = null;
let CURRENT_PROPERTY_ID = null; // null = portfolio view

async function init() {
  const [revenue, properties, occupancy, concentration, delinquent, leases] = await Promise.all([
    api("/revenue/portfolio"),
    api("/properties"),
    api("/occupancy/portfolio"),
    api("/revenue/concentration"),
    api("/delinquent"),
    api("/leases/expiring?days=60"),
  ]);

  ALL_PROPERTIES = properties;
  PORTFOLIO_REVENUE = revenue;
  const sortedByRevenue = [...revenue.by_property].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue);

  renderSidebar(sortedByRevenue);
  renderPortfolioKpis(revenue, occupancy, delinquent, leases.leases);
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

function showPortfolioView() {
  CURRENT_PROPERTY_ID = null;
  document.getElementById("dashPortfolioView").style.display = "";
  document.getElementById("dashPropertyView").style.display = "none";
  const sorted = [...PORTFOLIO_REVENUE.by_property].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue);
  renderSidebar(sorted, document.getElementById("dashSearch").value);
  api("/occupancy/portfolio").then((occ) => api("/delinquent").then((d) => api("/leases/expiring?days=60").then((l) =>
    renderPortfolioKpis(PORTFOLIO_REVENUE, occ, d, l.leases)
  )));
}

async function showPropertyView(propertyId) {
  CURRENT_PROPERTY_ID = propertyId;
  document.getElementById("dashPortfolioView").style.display = "none";
  document.getElementById("dashPropertyView").style.display = "";

  const sorted = [...PORTFOLIO_REVENUE.by_property].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue);
  renderSidebar(sorted, document.getElementById("dashSearch").value);

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

function kpiTile(value, label) {
  return `<div class="kpi-tile"><div class="kv">${value}</div><div class="kk">${label}</div></div>`;
}

function renderPortfolioKpis(revenue, occupancy, delinquent, leases) {
  const totalDelinquent = delinquent.reduce((s, r) => s + r.balance, 0);
  document.getElementById("dashKpiStrip").innerHTML =
    kpiTile(fmtMoney(revenue.total_net_effective_revenue), "Net effective revenue") +
    kpiTile(fmtMoney(revenue.total_gross_revenue), "Gross revenue") +
    kpiTile(occupancy.pct_occ != null ? occupancy.pct_occ.toFixed(1) + "%" : "—", "Occupancy") +
    kpiTile(fmtMoney(totalDelinquent), "Total delinquent") +
    kpiTile(leases.length, "Leases rolling over (60d)");
}

function renderPropertyKpis(rev, occ, delinquent, leases) {
  const totalDelinquent = delinquent.reduce((s, r) => s + r.balance, 0);
  document.getElementById("dashKpiStrip").innerHTML =
    kpiTile(fmtMoney(rev.net_effective_revenue), "Net effective revenue") +
    kpiTile(occ.pct_occ != null ? occ.pct_occ.toFixed(1) + "%" : "—", "Occupancy") +
    kpiTile(occ.total_units, "Units") +
    kpiTile(fmtMoney(totalDelinquent), "Delinquent") +
    kpiTile(leases.length, "Rolling over (60d)");
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

const UNIT_STATUS_LABELS = { occupied: "occupied", notice: "notice", vacant: "vacant", model: "model", down: "down" };

function renderUnitsTable(units) {
  document.getElementById("unitsCount").textContent = `${units.length} units`;
  document.getElementById("unitsBody").innerHTML = units.map((u) => {
    const status = u.status || "vacant";
    return `<tr>
      <td class="strong">${u.unit_number}</td>
      <td>${u.unit_type || "—"}</td>
      <td class="mono">${u.sq_ft ? Math.round(u.sq_ft) : "—"}</td>
      <td><span class="units-status ${status}">${UNIT_STATUS_LABELS[status] || status}</span></td>
      <td>${u.resident_name || "—"}</td>
      <td class="mono">${u.market_rent ? fmtMoney(u.market_rent) : "—"}</td>
      <td class="mono">${u.balance ? fmtMoney(u.balance) : "—"}</td>
      <td class="mono">${u.lease_expiration || "—"}</td>
    </tr>`;
  }).join("");
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="position:fixed;top:0;left:0;right:0;z-index:999;background:#f87171;color:#1a0000;padding:10px;text-align:center;font-family:monospace;font-size:13px">Failed to load dashboard: ${err.message}</div>`
  );
});
