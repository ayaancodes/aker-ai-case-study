const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmtMoney = (n) => "$" + Math.round(n).toLocaleString("en-US");
const fmtMoneySigned = (n) => (n < 0 ? "-" : "") + fmtMoney(Math.abs(n));

/* ── theme toggle (system-matched + manual override) ── */
(function () {
  const mq = matchMedia("(prefers-color-scheme: light)");
  let manual = null;
  function apply() {
    const light = manual === null ? mq.matches : manual === "light";
    document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
  }
  mq.addEventListener?.("change", () => { if (manual === null) apply(); });
  document.getElementById("themeBtn")?.addEventListener("click", () => {
    manual = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    apply();
  });
  apply();
})();

/* ── nav scroll shadow ── */
const nav = document.getElementById("nav");
addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 30), { passive: true });

/* ── reveal-on-scroll ── */
const revealObserver = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add("in")),
  { threshold: 0.15 }
);
function observeReveals() {
  document.querySelectorAll(".reveal:not(.in)").forEach((el) => revealObserver.observe(el));
}

/* ── count-up numbers ── */
function countUp(el, target, suffix = "") {
  // requestAnimationFrame is paused for hidden/background tabs by design, which would
  // otherwise leave a tile stuck at 0 forever if the page loads without focus.
  if (REDUCED || document.hidden) { el.textContent = target.toLocaleString() + suffix; return; }
  const start = performance.now();
  const dur = 900;
  function frame(t) {
    const p = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(target * eased).toLocaleString() + suffix;
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
const countObserver = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (e.isIntersecting && !e.target.dataset.done) {
      e.target.dataset.done = "1";
      countUp(e.target, +e.target.dataset.count, e.target.dataset.suffix || "");
    }
  });
}, { threshold: 0.4 });

/* ── API fetch helpers ── */
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function init() {
  const [stats, revenue, properties, anomalies] = await Promise.all([
    api("/stats"),
    api("/revenue/portfolio"),
    api("/properties"),
    api("/anomalies"),
  ]);

  renderStats(stats);
  renderTicker(revenue.by_property);
  renderRevenue(revenue);
  renderMarquee(revenue.by_property);
  renderAnomalies(anomalies);

  const asOf = revenue.by_property[0] ? await api(`/properties/${revenue.by_property[0].property_id}`) : null;
  const asOfDate = asOf?.latest_as_of_date?.rent_roll;
  document.getElementById("asOfNote").textContent =
    `AS OF ${asOfDate || "—"} · ${stats.properties} PROPERTIES · SQLITE + FASTAPI, ONE DEPLOYABLE SERVICE`;

  observeReveals();
}

function renderStats(stats) {
  const grid = document.getElementById("statsGrid");
  const tiles = [
    { v: stats.charge_total_mismatches, k: "Charge-total mismatches", u: "across every charge line loaded" },
    { v: stats.properties, k: "Properties in the portfolio", u: "deduped from 25 source files" },
    { v: stats.tenancies, k: "Tenancy records loaded", u: "unit-resident-periods, this snapshot" },
    { v: stats.data_quality_flags, k: "Data quality flags caught", u: "written automatically at load time" },
  ];
  grid.innerHTML = tiles.map(
    (t) => `<div class="stat"><div class="v mono" data-count="${t.v}">0</div><div class="k">${t.k}</div><div class="u">${t.u}</div></div>`
  ).join("");
  grid.querySelectorAll(".v").forEach((el) => countObserver.observe(el));
}

function renderTicker(byProperty) {
  const track = document.getElementById("tape");
  const sorted = [...byProperty].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue);
  const entries = sorted.concat(sorted);
  track.innerHTML = entries.map((p) => {
    const initial = p.canonical_name.trim()[0].toUpperCase();
    return `<span class="tk">
      <span class="chip">${initial}</span>
      <span class="sym">${p.canonical_name}</span>
      <span class="px mono">${fmtMoney(p.net_effective_revenue)}</span>
    </span>`;
  }).join("");
}

function renderRevenue(revenue) {
  const body = document.getElementById("revenueBars");
  const sorted = [...revenue.by_property].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue);
  const max = sorted[0]?.net_effective_revenue || 1;
  body.innerHTML = sorted.map((p) => `
    <div class="bar-row">
      <div class="name">${p.canonical_name}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(p.net_effective_revenue / max * 100).toFixed(1)}%"></div></div>
      <div class="amt mono">${fmtMoney(p.net_effective_revenue)}</div>
    </div>
  `).join("");

  document.getElementById("revenueFoot").innerHTML = `
    <span>gross <b>${fmtMoney(revenue.total_gross_revenue)}</b></span>
    <span>concessions <b>${fmtMoneySigned(revenue.total_concessions)}</b></span>
    <span>net effective <b>${fmtMoney(revenue.total_net_effective_revenue)}</b></span>
  `;
}

function renderMarquee(byProperty) {
  const cardHtml = (p) => `
    <div class="prop-card">
      <div class="n">${p.canonical_name}</div>
      <div class="d">${p.property_id}</div>
      <div class="r"><span>Net effective</span><span class="rev mono">${fmtMoney(p.net_effective_revenue)}</span></div>
    </div>`;
  const half = Math.ceil(byProperty.length / 2);
  const row1 = byProperty.slice(0, half);
  const row2 = byProperty.slice(half);
  document.getElementById("mq1").innerHTML = row1.concat(row1).map(cardHtml).join("");
  document.getElementById("mq2").innerHTML = row2.concat(row2).map(cardHtml).join("");
}

const FLAG_LABELS = {
  empty_rent_roll: "Empty rent roll",
  unit_availability_mismatch: "Unit availability mismatch",
  charge_total_mismatch: "Charge total mismatch",
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

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="position:fixed;top:0;left:0;right:0;z-index:999;background:#f87171;color:#1a0000;padding:10px;text-align:center;font-family:monospace;font-size:13px">Failed to load portfolio data: ${err.message}</div>`
  );
});
