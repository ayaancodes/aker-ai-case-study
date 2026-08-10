let CURRENT_PROPERTY_ID = null; // null = portfolio view
let STATUS_FILTER = null; // null | "healthy" | "watch" -- set by the header chips
let SIDEBAR_BROWSING = false; // true while the user re-opens the full list from a drill-down
// Portfolio-wide data fetched once at load and reused when returning from a property
// view -- it's a single-snapshot database, nothing changes between clicks, so
// re-fetching three endpoints on every back-click was pure waste.
let PORTFOLIO = null;

async function init() {
  const [revenue, properties, occupancy, concentration, delinquent, leases, stats, anomalies] = await Promise.all([
    api("/revenue/portfolio"),
    api("/properties"),
    api("/occupancy/portfolio"),
    api("/revenue/concentration"),
    api("/delinquent"),
    api("/leases/expiring?days=60"),
    api("/stats"),
    api("/anomalies"),
  ]);

  const delinquentRows = delinquent.rows;
  PORTFOLIO = { revenue, properties, occupancy, delinquent: delinquentRows,
    delinquentTotal: delinquent.total_balance, leases: leases.leases,
    leaseRef: leases.reference_date, stats, anomalies };
  const sortedByRevenue = [...revenue.by_property].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue);

  renderSidebar(sortedByRevenue);
  renderHeader(properties, stats, anomalies, leases.reference_date);
  renderSignals(stats, anomalies);
  renderPortfolioKpis(revenue, occupancy, delinquentRows, leases.leases, leases.reference_date);
  renderRevenueChart(sortedByRevenue);
  renderOccupancyChart(occupancy.by_property, sortedByRevenue);
  renderDonut(revenue.by_category);
  renderConcentration(concentration);
  renderDelinquentList("delinquentList", delinquentRows);
  renderLeaseList("leaseList", leases.leases);

  startLiveClock(document.getElementById("asOfNote"), leases.reference_date || "—");

  document.getElementById("dashSearch").addEventListener("input", (e) => {
    renderSidebar(sortedByRevenue, e.target.value);
  });
  document.getElementById("dashBack").addEventListener("click", () => showPortfolioView());

  // tab chips switch the portfolio panes; data is already rendered, pure show/hide
  document.getElementById("dashTabs").addEventListener("click", (e) => {
    const tab = e.target.closest("#dashTabs .dash-tab");
    if (!tab) return;
    document.querySelectorAll("#dashTabs .dash-tab").forEach((t) => t.classList.toggle("on", t === tab));
    document.querySelectorAll(".dash-tab-pane").forEach((p) => {
      p.style.display = p.dataset.pane === tab.dataset.tab ? "" : "none";
    });
  });

  // revenue bridge waterfall, Financial tab
  const bridge = await api("/metrics/revenue-bridge");
  const bridgeCv = document.getElementById("bridgeChart");
  animateOnceVisible(bridgeCv, (progress) => drawBridge(bridgeCv, bridge, progress));

  // commercial vs residential split on the Risk tab -- one commercial unit carries
  // a $178K balance that would otherwise swamp all residential risk in one list
  renderDelinquentSplit("");
  document.getElementById("programTabs").addEventListener("click", (e) => {
    const tab = e.target.closest("#programTabs .dash-tab");
    if (!tab) return;
    document.querySelectorAll("#programTabs .dash-tab").forEach((t) => t.classList.toggle("on", t === tab));
    renderDelinquentSplit(tab.dataset.program);
  });

  // data is rendered: swap the loading state for the real content
  document.getElementById("dashLoading").remove();
  document.getElementById("dashContent").hidden = false;
  countUpKpis();

  observeReveals();
}

/* ── KPI count-up. Tile values are already formatted strings ("$1,636,736",
   "91.5%", "326"), so instead of rewiring every call site this parses the rendered
   text back into a number plus its prefix, suffix and decimal precision, then rolls
   it up. Values with no number in them (an em dash placeholder) are left alone.
   Hidden tabs get the final value immediately, since rAF does not run there and a
   stalled animation would leave a zero on screen. ── */
function countUpKpis(root = document) {
  root.querySelectorAll(".kpi-tile .kv").forEach((el) => {
    const m = el.textContent.match(/^([^\d-]*)(-?[\d,]+(?:\.\d+)?)(.*)$/);
    if (!m) return;
    const [, prefix, numStr, suffix] = m;
    const target = parseFloat(numStr.replace(/,/g, ""));
    if (!isFinite(target)) return;
    const decimals = (numStr.split(".")[1] || "").length;
    const fmt = (v) => prefix + v.toLocaleString(undefined, {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    }) + suffix;

    if (REDUCED || document.hidden) { el.textContent = fmt(target); return; }
    const start = performance.now(), dur = 900;
    const frame = (t) => {
      const p = Math.min(1, (t - start) / dur);
      el.textContent = fmt(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(frame);
      else el.textContent = fmt(target); // land exactly on the real value
    };
    requestAnimationFrame(frame);
  });
}

/* ── 3. view transition: portfolio and property views fade/slide in rather than
   hard-swapping. The class is stripped on animationend so no transform lingers to
   become a containing block for fixed-position children. ── */
function playViewIn(el) {
  if (REDUCED || !el) return;
  el.classList.remove("view-in");
  void el.offsetWidth; // restart the animation on re-entry
  el.classList.add("view-in");
  el.addEventListener("animationend", () => el.classList.remove("view-in"), { once: true });
}

function renderDelinquentSplit(program) {
  const rows = program
    ? PORTFOLIO.delinquent.filter((r) => r.program_type === program)
    : PORTFOLIO.delinquent;
  renderDelinquentList("delinquentList", rows);
  const total = rows.reduce((s, r) => s + r.balance, 0);
  document.getElementById("delinquentSub").textContent =
    `${rows.length} tenancies · ${fmtMoney(total)} owed`;
}

/* CFO-style waterfall: gross potential rent down to net effective revenue. Floating
   bars on a running total; the missing-charge gap is drawn amber because it is the
   data quality finding expressed as a financial line item. */
function drawBridge(cv, b, progress = 1) {
  const steps = [
    { label: "GROSS POTENTIAL", value: b.gross_potential_rent, type: "total" },
    { label: "VACANCY", value: -b.vacancy_loss, type: "loss" },
    { label: "MISSING CHARGES", value: -b.missing_charge_gap, type: "gap" },
    { label: "OTHER INCOME", value: b.other_income_and_variance, type: "gain" },
    { label: "CONCESSIONS", value: b.concessions, type: "loss" },
    { label: "NET EFFECTIVE", value: b.net_effective_revenue, type: "total" },
  ];
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const padTop = 34, padBottom = 34;
  const plotH = h - padTop - padBottom;
  const max = b.gross_potential_rent || 1;
  const slot = w / steps.length;
  const barW = Math.min(84, slot * 0.55);
  const y = (v) => padTop + plotH - (v / max) * plotH * progress;

  const colors = {
    total: ["#7FC79B", "#3E6B4F"],
    loss: ["#E2836F", "#a85843"],
    gap: ["#C9A96A", "#8a6f3e"],
    gain: ["#D8EFDF", "#7FC79B"],
  };

  let running = 0;
  let prevRightY = null;
  steps.forEach((s, i) => {
    const x = i * slot + (slot - barW) / 2;
    let top, bottom;
    if (s.type === "total") {
      top = y(s.value); bottom = y(0);
      running = s.value;
    } else {
      const from = running;
      running += s.value;
      top = y(Math.max(from, running));
      bottom = y(Math.min(from, running));
      if (bottom - top < 2) bottom = top + 2;
    }
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    const [c1, c2] = colors[s.type];
    grad.addColorStop(0, c1); grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, top, barW, Math.max(bottom - top, 2), 4);
    ctx.fill();

    // connector from the previous bar's landing level
    if (prevRightY != null) {
      ctx.strokeStyle = "rgba(154,164,157,.35)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x - (slot - barW) + barW / 8, prevRightY);
      ctx.lineTo(x, prevRightY);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    prevRightY = y(running);

    if (progress > 0.65) {
      ctx.globalAlpha = Math.min(1, (progress - 0.65) / 0.35);
      ctx.fillStyle = "#EDEBE4";
      ctx.font = "600 11px 'JetBrains Mono'";
      ctx.textAlign = "center";
      const valText = (s.value < 0 ? "-" : "") + "$" + Math.round(Math.abs(s.value) / 1000).toLocaleString() + "K";
      ctx.fillText(s.type === "total" ? "$" + (s.value / 1e6).toFixed(2) + "M" : valText, x + barW / 2, top - 8);
      ctx.fillStyle = "#5E675F";
      ctx.font = "500 8.5px 'JetBrains Mono'";
      ctx.fillText(s.label, x + barW / 2, h - 12);
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
    }
  });
}

/* fact chips + Healthy/Watch status, all real: watch = properties carrying at least
   one data quality flag, healthy = the rest. Same source as /anomalies. */
function renderHeader(properties, stats, anomalies, asOf) {
  const flagged = new Set(anomalies.map((a) => a.property_id));
  const healthy = properties.filter((p) => !flagged.has(p.property_id)).length;

  document.getElementById("dashFactChips").innerHTML = [
    `${stats.properties} properties`,
    `${stats.tenancies.toLocaleString()} tenancies`,
    `as of ${asOf}`,
  ].map((t) => `<span class="dash-chip">${t}</span>`).join("");

  document.getElementById("dashStatusChips").innerHTML =
    `<button class="status-chip healthy" data-status="healthy"><span class="sdot"></span>${healthy} Healthy</button>` +
    `<button class="status-chip watch" data-status="watch"><span class="sdot"></span>${flagged.size} Watch</button>`;

  // the chips are filters, not decoration: click Watch -> sidebar shows only the
  // flagged properties and the Watchpoints strip scrolls into view; click again
  // (or All properties) to clear
  document.getElementById("dashStatusChips").addEventListener("click", (e) => {
    const chip = e.target.closest(".status-chip");
    if (!chip) return;
    STATUS_FILTER = STATUS_FILTER === chip.dataset.status ? null : chip.dataset.status;
    document.querySelectorAll(".status-chip").forEach((c) =>
      c.classList.toggle("on", c.dataset.status === STATUS_FILTER));
    renderSidebar(sortedPortfolio(), document.getElementById("dashSearch").value);
    if (STATUS_FILTER === "watch") {
      document.getElementById("signalsBody")?.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "center" });
    }
  });
}

/* Copilot signals card: short findings assembled from the real flag rows and /stats,
   each one traceable to an endpoint. No invented narrative. */
function renderSignals(stats, anomalies) {
  const missing = anomalies.filter((a) => a.flag_type === "missing_charges");
  const partial = anomalies.filter((a) => a.flag_type === "missing_charges_partial");
  const dates = anomalies.filter((a) => a.flag_type === "implausible_dates");

  const signals = [];
  if (missing.length) {
    const props = [...new Set(missing.map((a) => a.property_id))];
    signals.push({
      text: `${props.length} properties have most occupied tenancies with zero recorded charge lines. Their revenue is understated in this snapshot.`,
      tags: ["missing charges", ...(partial.length ? [`+${partial.length} partial`] : [])],
    });
  }
  if (stats.holdover_leases) {
    signals.push({
      text: `${stats.holdover_leases} tenancies stayed on past their lease expiration and were never renewed.`,
      tags: ["lease rollover", "holdovers"],
    });
  }
  if (dates.length) {
    signals.push({
      text: `${dates.length} tenancies carry impossible dates in the source files, including a lease "expiring" in 2626.`,
      tags: ["implausible dates"],
    });
  }

  // each watchpoint leads somewhere concrete: the worst missing-charges property,
  // the copilot pre-asked about holdovers, the anomalies feed for the date errors.
  // Destinations are hardcoded to this dataset's known findings, per sign-off.
  const actions = [
    { hint: "See Kinwood (175) &rarr;", go: () => showPropertyView("175") },
    { hint: "Ask the copilot &rarr;", go: () => { window.location.href = "copilot.html?q=" + encodeURIComponent("Which leases already expired and were never renewed?"); } },
    { hint: "View the flags &rarr;", go: () => { window.location.href = "how-it-works.html#anomalies"; } },
  ];
  document.getElementById("signalsBody").innerHTML = signals.map((s, i) => `
    <div class="signal clickable" data-signal="${i}" role="button" tabindex="0">
      <div class="signal-text">${s.text}</div>
      <div class="signal-tags">${s.tags.map((t) => `<span class="signal-tag"><span class="sdot"></span>${t}</span>`).join("")}</div>
      <div class="signal-go mono">${actions[i]?.hint ?? ""}</div>
    </div>
  `).join("");
  document.querySelectorAll(".signal.clickable").forEach((el) => {
    const act = actions[+el.dataset.signal];
    if (!act) return;
    el.addEventListener("click", act.go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") act.go(); });
  });
}

function renderSidebar(sorted, query = "") {
  const list = document.getElementById("dashPropertyList");
  const q = query.trim().toLowerCase();
  let matches = q ? sorted.filter((p) => p.canonical_name.toLowerCase().includes(q)) : sorted;
  if (STATUS_FILTER && PORTFOLIO) {
    const flagged = new Set(PORTFOLIO.anomalies.map((a) => a.property_id));
    matches = matches.filter((p) =>
      STATUS_FILTER === "watch" ? flagged.has(p.property_id) : !flagged.has(p.property_id));
  }

  const allItem = `<div class="dash-pitem all ${CURRENT_PROPERTY_ID === null ? "on" : ""}" data-id="">
    <span>All properties</span>
  </div>`;

  // drilled into a property (and not searching or explicitly browsing): the list
  // collapses to just the current property -- the sidebar acknowledges the
  // navigation instead of repainting an identical 15-row list with one highlight
  const collapsed = CURRENT_PROPERTY_ID && !SIDEBAR_BROWSING && !q;
  if (collapsed) {
    const p = sorted.find((x) => x.property_id === CURRENT_PROPERTY_ID);
    list.innerHTML = allItem + `
      <div class="dash-side-viewing">VIEWING</div>
      <div class="dash-pitem on" data-id="${p?.property_id ?? ""}">
        <span>${p?.canonical_name ?? CURRENT_PROPERTY_ID}</span>
        <span class="pi-amt mono">${p ? fmtMoney(p.net_effective_revenue) : ""}</span>
      </div>
      <button class="dash-change-prop" id="dashChangeProp">Change property &rarr;</button>`;
    document.getElementById("dashChangeProp").addEventListener("click", () => {
      SIDEBAR_BROWSING = true;
      renderSidebar(sorted, "");
    });
  } else {
    const items = matches.map((p) => `
      <div class="dash-pitem ${CURRENT_PROPERTY_ID === p.property_id ? "on" : ""}" data-id="${p.property_id}">
        <span>${p.canonical_name}</span>
        <span class="pi-amt mono">${fmtMoney(p.net_effective_revenue)}</span>
      </div>
    `).join("");
    list.innerHTML = allItem + items +
      (matches.length ? "" : `<div class="dash-side-empty">No property matches that search.</div>`);
  }

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
  SIDEBAR_BROWSING = false;
  STATUS_FILTER = null;
  document.querySelectorAll(".status-chip").forEach((c) => c.classList.remove("on"));
  document.getElementById("dashPortfolioView").style.display = "";
  document.getElementById("dashPropertyView").style.display = "none";
  document.getElementById("dashPropBar").style.display = "none";
  renderSidebar(sortedPortfolio(), document.getElementById("dashSearch").value);
  renderPortfolioKpis(PORTFOLIO.revenue, PORTFOLIO.occupancy, PORTFOLIO.delinquent, PORTFOLIO.leases, PORTFOLIO.leaseRef);
  countUpKpis();
  playViewIn(document.getElementById("dashPortfolioView"));
}

async function showPropertyView(propertyId) {
  CURRENT_PROPERTY_ID = propertyId;
  SIDEBAR_BROWSING = false;
  document.getElementById("dashPortfolioView").style.display = "none";
  document.getElementById("dashPropertyView").style.display = "";
  document.getElementById("dashPropBar").style.display = "";

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

  renderPropertyKpis(rev, occ, delinquent.rows, leases.leases);
  renderUnitsTable(units.units);
  renderUnitGrid(units.units);
  PROPERTY_OCC = occ; // property averages feed the unit modal's comparison stats
  countUpKpis();
  playViewIn(document.getElementById("dashPropBar"));
  playViewIn(document.getElementById("dashPropertyView"));

  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── KPI tiles: icon chip, number, label, and a small real-data visual. No trend
   lines on purpose -- one snapshot loaded, so every mini-viz shows composition or
   distribution across properties, never time. pop (optional) is extra detail HTML
   shown in a hover popover. ── */
const KPI_ICONS = {
  money: `<svg viewBox="0 0 24 24"><path d="M12 2v20M17 6H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>`,
  grid: `<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/><path d="M4 9h16M9 4v16"/></svg>`,
  pct: `<svg viewBox="0 0 24 24"><path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.6"/><circle cx="17" cy="17" r="2.6"/></svg>`,
  alert: `<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18.2v.1"/></svg>`,
  cal: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
};

function kpiTile(value, label, vizId, legend, pop, icon) {
  const ic = icon ? `<div class="ki">${KPI_ICONS[icon]}</div>` : "";
  const viz = vizId ? `<canvas id="${vizId}"></canvas>` : "";
  const leg = legend ? `<div class="kpi-legend">${legend}</div>` : "";
  const popEl = pop ? `<div class="kpi-pop">${pop}</div>` : "";
  return `<div class="kpi-tile ${pop ? "has-pop" : ""}">${ic}<div class="kv">${value}</div><div class="kk">${label}</div>${viz}${leg}${popEl}</div>`;
}

/* mini vertical-bar distribution: one bar per value, sorted. Bars read as a
   distribution across properties; the earlier area/line version read as a declining
   time series, which is exactly the false impression a one-snapshot dataset must
   never give. No MoM/delta anywhere, still. */
function drawKpiBars(id, values) {
  const cv = document.getElementById(id);
  if (!cv || !values.length) return;
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...values, 1);
  const gap = 3;
  const barW = Math.max(3, (w - gap * (values.length - 1)) / values.length);
  values.forEach((v, i) => {
    const bh = Math.max(2, (Math.max(v, 0) / max) * (h - 4));
    const x = i * (barW + gap);
    ctx.fillStyle = i === 0 ? "#7FC79B" : "rgba(127,199,155,.38)";
    ctx.beginPath();
    ctx.roundRect(x, h - bh, barW, bh, 2);
    ctx.fill();
  });
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
      "kpiNetViz", "BY PROPERTY · SORTED", netPop, "money") +
    kpiTile(fmtMoney(revenue.total_gross_revenue), "Gross revenue",
      "kpiGrossViz", "GROSS VS CONCESSIONS", grossPop, "money") +
    kpiTile(occupancy.pct_occ != null ? occupancy.pct_occ.toFixed(1) + "%" : "—", "Occupancy",
      "kpiOccViz", `${occupancy.total_occupied} OF ${occupancy.total_units} UNITS`, null, "pct") +
    kpiTile(fmtMoney(totalDelinquent), "Total delinquent",
      "kpiDelViz", "BALANCES · LARGEST FIRST", delinquentPop, "alert") +
    kpiTile(leases.length, "Leases rolling over (60d)",
      "kpiRollViz", `${within30} WITHIN 30D · ${leases.length - within30} IN 31-60D`, rolloverPop, "cal");

  drawKpiBars("kpiNetViz", [...revenue.by_property].map((p) => p.net_effective_revenue).sort((a, b) => b - a));
  drawKpiSegments("kpiGrossViz", [
    { value: revenue.total_gross_revenue, color: "#7FC79B" },
    { value: Math.abs(revenue.total_concessions), color: "#E2836F" },
  ]);
  if (occupancy.pct_occ != null) drawKpiProgress("kpiOccViz", occupancy.pct_occ);
  drawKpiBars("kpiDelViz", delinquent.map((r) => r.balance).sort((a, b) => b - a).slice(0, 24));
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
      "kpiPNetViz", "NET VS CONCESSIONS · HOVER FOR BREAKDOWN", revenuePop, "money") +
    kpiTile(occ.pct_occ != null ? occ.pct_occ.toFixed(1) + "%" : "—", "Occupancy",
      "kpiPOccViz", `${occ.occupied} OF ${occ.total_units} UNITS`, occPop, "pct") +
    kpiTile(occ.total_units, "Units",
      "kpiPUnitsViz", `${occ.occupied} OCC · ${occ.on_notice} NOTICE · ${occ.vacant} VACANT`, occPop, "grid") +
    kpiTile(fmtMoney(totalDelinquent), "Delinquent",
      "kpiPDelViz", "TOP 5 BALANCES + REST · HOVER FOR NAMES", delinquentPop, "alert") +
    kpiTile(leases.length, "Rolling over (60d)", null, "HOVER FOR NEXT EXPIRATIONS", rolloverPop, "cal");

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
let PROPERTY_OCC = null;

function renderUnitsTable(units) {
  PROPERTY_UNITS = units;

  const statuses = [...new Set(units.map((u) => u.status || "vacant"))].sort();
  document.getElementById("unitStatusFilter").innerHTML =
    `<option value="">All statuses</option>` + statuses.map((s) => `<option value="${s}">${s}</option>`).join("");
  document.getElementById("unitSearch").value = "";
  document.getElementById("unitSort").value = "";
  document.getElementById("unitBalanceOnly").checked = false;

  applyUnitFilters();
}

function applyUnitFilters() {
  const q = document.getElementById("unitSearch").value.trim().toLowerCase();
  const status = document.getElementById("unitStatusFilter").value;
  const sort = document.getElementById("unitSort").value;
  const balanceOnly = document.getElementById("unitBalanceOnly").checked;

  let filtered = PROPERTY_UNITS.filter((u) => {
    if (status && (u.status || "vacant") !== status) return false;
    if (balanceOnly && !(u.balance && u.balance > 0)) return false;
    if (q && !(
      u.unit_number.toLowerCase().includes(q) ||
      (u.resident_name || "").toLowerCase().includes(q)
    )) return false;
    return true;
  });

  if (sort === "rent-asc") filtered = [...filtered].sort((a, b) => (a.market_rent || 0) - (b.market_rent || 0));
  else if (sort === "rent-desc") filtered = [...filtered].sort((a, b) => (b.market_rent || 0) - (a.market_rent || 0));
  else if (sort === "balance-desc") filtered = [...filtered].sort((a, b) => (b.balance || 0) - (a.balance || 0));

  document.getElementById("unitsCount").textContent =
    filtered.length === PROPERTY_UNITS.length
      ? `${PROPERTY_UNITS.length} units`
      : `${filtered.length} of ${PROPERTY_UNITS.length} units`;

  // an empty result must say why, not leave a blank panel. A property with no units
  // at all is a real data quality finding (3 source files are structurally empty),
  // so name it rather than showing nothing.
  const tbody = document.getElementById("unitsBody");
  if (!filtered.length) {
    const reason = !PROPERTY_UNITS.length
      ? `No units in this property's rent roll. Its source file is one of the three that came through structurally empty, which is flagged on the <a href="how-it-works.html#anomalies">anomalies feed</a>.`
      : `No units match these filters. <button class="units-clear" id="unitsClear">Clear filters</button>`;
    tbody.innerHTML = `<tr><td colspan="8"><div class="units-empty">${reason}</div></td></tr>`;
    document.getElementById("unitsClear")?.addEventListener("click", () => {
      document.getElementById("unitSearch").value = "";
      document.getElementById("unitStatusFilter").value = "";
      document.getElementById("unitSort").value = "";
      document.getElementById("unitBalanceOnly").checked = false;
      applyUnitFilters();
    });
    return;
  }

  tbody.innerHTML = filtered.map((u) => {
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
document.getElementById("unitSort").addEventListener("change", applyUnitFilters);
document.getElementById("unitBalanceOnly").addEventListener("change", applyUnitFilters);

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

/* footprint graphic: this unit's floor area drawn to scale inside the property's
   average unit (dashed outline). Sides scale by sqrt(area) so AREA is what's
   proportional -- a 2x sq ft unit looks 2x the area, not 4x. */
function unitSizeVizHtml(sqFt, avgSqFt) {
  if (!sqFt) return "";
  const OUTER = 128;
  const ratio = avgSqFt ? Math.sqrt(sqFt / avgSqFt) : 1;
  const inner = Math.max(34, Math.min(OUTER * ratio, 176));
  const box = Math.max(OUTER, inner) + 14;
  const avgLabel = avgSqFt
    ? `<div class="usv-caption">AVG UNIT HERE &middot; ${Math.round(avgSqFt)} SQ FT</div>`
    : "";
  return `
    <div class="unit-size-viz" style="width:${box}px;height:${box}px">
      ${avgSqFt ? `<div class="usv-avg" style="width:${OUTER}px;height:${OUTER}px"></div>` : ""}
      <div class="usv-unit" style="width:${inner}px;height:${inner}px">
        <span class="mono">${Math.round(sqFt)}</span><small>SQ FT</small>
      </div>
    </div>${avgLabel}`;
}

/* lease timeline: move-in to expiration with a marker at the data's as-of date --
   an expired-but-occupied lease (holdover) shows exactly as what it is */
function leaseTimelineHtml(t, asOf) {
  if (!t?.move_in || !t?.lease_expiration || !asOf) return "";
  const start = new Date(t.move_in), end = new Date(t.lease_expiration), now = new Date(asOf);
  const span = end - start;
  if (span <= 0) return `<div class="unit-gap-note">Impossible dates in the source file: move-in ${t.move_in} is after expiration ${t.lease_expiration}.</div>`;
  const pct = Math.max(0, Math.min(100, ((now - start) / span) * 100));
  const daysLeft = Math.round((end - now) / 86400000);
  const state = daysLeft < 0
    ? `<span class="lt-state warn">EXPIRED ${Math.abs(daysLeft)}D AGO &middot; HOLDOVER</span>`
    : `<span class="lt-state">${daysLeft} DAYS LEFT</span>`;
  return `
    <div class="lease-timeline">
      <div class="lt-head"><span>LEASE TERM</span>${state}</div>
      <div class="lt-track"><div class="lt-fill${daysLeft < 0 ? " over" : ""}" style="width:${pct}%"></div></div>
      <div class="lt-dates mono"><span>${t.move_in}</span><span>${t.lease_expiration}</span></div>
    </div>`;
}

document.getElementById("unitsBody").addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-unit-id]");
  if (row) openUnitDetail(row.dataset.unitId);
});

async function openUnitDetail(unitId) {
  const detail = await api(`/units/${unitId}`);
  const t = detail.tenancy;
  const avgRent = PROPERTY_OCC?.avg_rent;
  const avgSqFt = PROPERTY_OCC?.avg_sq_ft;

  // comparison stats around the footprint graphic, all computed from fields on
  // screen: rent vs the property average, and rent per square foot
  const stats = [];
  if (t?.market_rent) {
    stats.push(["Market rent", fmtMoney(t.market_rent)]);
    if (avgRent) {
      const diff = Math.round(100 * (t.market_rent - avgRent) / avgRent);
      stats.push(["vs property avg", `${diff >= 0 ? "+" : ""}${diff}%`, diff >= 0 ? "up" : "down"]);
    }
    if (detail.sq_ft) stats.push(["Rent / sq ft", "$" + (t.market_rent / detail.sq_ft).toFixed(2)]);
  }
  stats.push(["Status", t ? t.status : "no current tenancy"]);
  if (t?.resident_name) stats.push(["Resident", t.resident_name]);
  if (t?.resident_deposit) stats.push(["Deposit", fmtMoney(t.resident_deposit)]);
  if (t?.balance) stats.push(["Balance", fmtMoney(t.balance), t.balance > 0 ? "down" : ""]);

  let chargesHtml;
  if (detail.charges.length) {
    chargesHtml = popRows(detail.charges.map((c) =>
      [`${c.charge_code} · ${c.category.replace("_", " ")}`, fmtMoneySigned(c.amount), c.amount < 0 ? "down" : ""]
    )) + popRows([["Total", fmtMoney(detail.total_charges), "up"]]);
  } else if (t && (t.status === "occupied" || t.status === "notice")) {
    chargesHtml = `<div class="unit-gap-note">No charge lines recorded for this tenancy in the
      source file despite an active resident -- this is the missing_charges data quality gap
      (see Anomalies on the How it's built page). Revenue for this unit is understated.</div>`;
  } else {
    chargesHtml = `<div class="pop-empty">No charges -- unit has no billable tenancy.</div>`;
  }

  document.getElementById("unitModalBody").innerHTML = `
    <div class="gate-eyebrow">${detail.canonical_name} &middot; ${detail.property_id}</div>
    <h2>Unit ${detail.unit_number}</h2>
    <p class="mono" style="font-size:11px">${detail.unit_type || ""} &middot; ${detail.program_type}</p>
    <div class="unit-modal-top">
      <div class="unit-modal-viz">${unitSizeVizHtml(detail.sq_ft, avgSqFt)}</div>
      <div class="unit-modal-stats">${popRows(stats)}${leaseTimelineHtml(t, PORTFOLIO?.leaseRef)}</div>
    </div>
    <div class="unit-modal-charges">
      <div class="unit-modal-heading">CHARGE LINES · THIS PERIOD</div>${chargesHtml}
    </div>`;
  unitModal.classList.add("open");
  unitModal.setAttribute("aria-hidden", "false");
}

init().catch((err) => {
  console.error(err);
  document.getElementById("dashLoading")?.remove();
  const content = document.getElementById("dashContent");
  if (content) content.hidden = false;
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="position:fixed;top:0;left:0;right:0;z-index:999;background:#f87171;color:#1a0000;padding:10px;text-align:center;font-family:monospace;font-size:13px">Failed to load dashboard: ${err.message}</div>`
  );
});

/* ── unit grid: one cell per real unit, colored by real status, pannable and
   zoomable like a seating chart. Rows/columns are ordered by unit number, NOT a
   floor plan -- that geometry doesn't exist in the data and won't be faked. Cells
   open the same unit detail modal as the table rows. ── */
const GRID = { x: 0, y: 0, z: 1, w: 0, h: 0, dragging: false, moved: 0, px: 0, py: 0 };
const GRID_CELL = 58, GRID_GAP = 6;

function gridApply() {
  const inner = document.getElementById("gridInner");
  inner.style.transform = `translate(${GRID.x}px, ${GRID.y}px) scale(${GRID.z})`;
  gridMinimapSync();
}

function gridMinimapSync() {
  const vp = document.getElementById("gridViewport");
  const mm = document.getElementById("gridMinimap");
  const view = document.getElementById("mmView");
  if (!vp || !mm || !GRID.w) return;
  const mmW = mm.clientWidth, mmH = mm.clientHeight;
  const sx = mmW / GRID.w, sy = mmH / GRID.h;
  const vw = Math.min(1, vp.clientWidth / (GRID.w * GRID.z)) * mmW;
  const vh = Math.min(1, vp.clientHeight / (GRID.h * GRID.z)) * mmH;
  view.style.width = vw + "px";
  view.style.height = vh + "px";
  view.style.left = Math.max(0, Math.min(mmW - vw, (-GRID.x / GRID.z) * sx)) + "px";
  view.style.top = Math.max(0, Math.min(mmH - vh, (-GRID.y / GRID.z) * sy)) + "px";
}

function gridFit() {
  const vp = document.getElementById("gridViewport");
  if (!vp.clientWidth || !GRID.w) return; // hidden pane: refit happens on tab switch
  GRID.z = Math.min(1, (vp.clientWidth - 24) / GRID.w);
  GRID.x = Math.max(12, (vp.clientWidth - GRID.w * GRID.z) / 2);
  GRID.y = 12;
  gridApply();
}

function renderUnitGrid(units) {
  const inner = document.getElementById("gridInner");
  const vp = document.getElementById("gridViewport");

  // a new property always opens on the grid tab -- without this, the tab state
  // leaks across properties and gridFit can run against a hidden zero-width pane
  document.querySelectorAll("#propTabs .dash-tab").forEach((t) =>
    t.classList.toggle("on", t.dataset.ptab === "grid"));
  document.querySelectorAll(".prop-pane").forEach((p) => {
    p.style.display = p.dataset.ppane === "grid" ? "" : "none";
  });
  document.getElementById("gridCount").textContent = `${units.length} units · ordered by unit number`;

  const cols = Math.max(4, Math.ceil(Math.sqrt(units.length * 1.9)));
  const rows = Math.ceil(units.length / cols);
  GRID.w = cols * (GRID_CELL + GRID_GAP) + GRID_GAP;
  GRID.h = rows * (GRID_CELL + GRID_GAP) + GRID_GAP;
  inner.style.width = GRID.w + "px";
  inner.style.height = GRID.h + "px";

  const statusClass = (s) => {
    if (s === "occupied") return "occupied";
    if (s === "notice") return "notice";
    if (s === "vacant" || !s) return "vacant";
    return "other"; // model / down
  };
  if (!units.length) {
    inner.innerHTML = "";
    inner.style.width = inner.style.height = "";
    document.getElementById("gridEmpty").hidden = false;
    return;
  }
  document.getElementById("gridEmpty").hidden = true;

  inner.innerHTML = units.map((u, i) => {
    const cx = (i % cols) * (GRID_CELL + GRID_GAP) + GRID_GAP;
    const cy = Math.floor(i / cols) * (GRID_CELL + GRID_GAP) + GRID_GAP;
    // ripple in from the top-left: delay by grid distance (row + column), capped so
    // even a 775-unit property finishes inside a second
    const delay = Math.min(((i % cols) + Math.floor(i / cols)) * 9, 720);
    const cls = REDUCED ? "" : " ug-in";
    const style = `left:${cx}px;top:${cy}px` + (REDUCED ? "" : `;animation-delay:${delay}ms`);
    return `<div class="ug-cell ${statusClass(u.status)}${cls}" style="${style}"
      data-unit-id="${u.unit_id}" title="${u.unit_number} · ${u.status || "vacant"}">
      <span>${u.unit_number}</span></div>`;
  }).join("");

  // minimap proportions follow the grid's aspect ratio
  const mm = document.getElementById("gridMinimap");
  mm.style.height = Math.max(50, Math.min(110, 140 * (GRID.h / GRID.w))) + "px";

  gridFit();

  if (!vp.dataset.wired) {
    vp.dataset.wired = "1";

    vp.addEventListener("pointerdown", (e) => {
      // presses that start on the zoom controls or minimap are button presses, not
      // pans. Without this the viewport captures the pointer, which retargets the
      // pointerup and stops `click` from ever firing on the button -- the reset
      // control looked dead for exactly this reason.
      if (e.target.closest(".grid-zoom, .grid-minimap")) return;
      GRID.dragging = true; GRID.moved = 0; GRID.px = e.clientX; GRID.py = e.clientY;
      // record the cell NOW: setPointerCapture retargets every later pointer event
      // (including pointerup) to the viewport, so e.target is useless by then
      GRID.downCell = e.target.closest(".ug-cell");
      vp.classList.add("grabbing");
      // capture keeps the drag alive when the pointer leaves the viewport; it can
      // throw for already-released pointers, and losing capture is not worth a crash
      try { vp.setPointerCapture(e.pointerId); } catch {}
    });
    vp.addEventListener("pointermove", (e) => {
      if (!GRID.dragging) return;
      const dx = e.clientX - GRID.px, dy = e.clientY - GRID.py;
      GRID.moved += Math.abs(dx) + Math.abs(dy);
      GRID.x += dx; GRID.y += dy;
      GRID.px = e.clientX; GRID.py = e.clientY;
      gridApply();
    });
    vp.addEventListener("pointerup", () => {
      GRID.dragging = false;
      vp.classList.remove("grabbing");
      // a click, not a drag: open the unit recorded at pointerdown
      if (GRID.moved < 6 && GRID.downCell) {
        openUnitDetail(GRID.downCell.dataset.unitId);
      }
      GRID.downCell = null;
    });

    vp.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const nz = Math.max(0.25, Math.min(2.5, GRID.z * (e.deltaY < 0 ? 1.12 : 0.9)));
      // zoom toward the cursor: keep the grid point under it stationary
      GRID.x = mx - ((mx - GRID.x) / GRID.z) * nz;
      GRID.y = my - ((my - GRID.y) / GRID.z) * nz;
      GRID.z = nz;
      gridApply();
    }, { passive: false });

    const zoomBy = (f) => {
      const vpr = vp.getBoundingClientRect();
      const mx = vpr.width / 2, my = vpr.height / 2;
      const nz = Math.max(0.25, Math.min(2.5, GRID.z * f));
      GRID.x = mx - ((mx - GRID.x) / GRID.z) * nz;
      GRID.y = my - ((my - GRID.y) / GRID.z) * nz;
      GRID.z = nz;
      gridApply();
    };
    document.getElementById("gridZoomIn").addEventListener("click", () => zoomBy(1.25));
    document.getElementById("gridZoomOut").addEventListener("click", () => zoomBy(0.8));
    document.getElementById("gridZoomReset").addEventListener("click", gridFit);

    // click the minimap to jump the viewport there
    document.getElementById("gridMinimap").addEventListener("click", (e) => {
      const mm = document.getElementById("gridMinimap");
      const r = mm.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      GRID.x = -(fx * GRID.w * GRID.z) + vp.clientWidth / 2;
      GRID.y = -(fy * GRID.h * GRID.z) + vp.clientHeight / 2;
      gridApply();
    });
  }
}

/* grid/table tab switch inside the property view */
document.getElementById("propTabs").addEventListener("click", (e) => {
  const tab = e.target.closest("#propTabs .dash-tab");
  if (!tab) return;
  document.querySelectorAll("#propTabs .dash-tab").forEach((t) => t.classList.toggle("on", t === tab));
  document.querySelectorAll(".prop-pane").forEach((p) => {
    p.style.display = p.dataset.ppane === tab.dataset.ptab ? "" : "none";
  });
  // the pane was display:none while hidden, so any fit computed then used a
  // zero-width viewport -- refit now that it's visible
  if (tab.dataset.ptab === "grid") gridFit();
});
