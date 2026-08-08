const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmtMoney = (n) => "$" + Math.round(n).toLocaleString("en-US");
const fmtMoneySigned = (n) => (n < 0 ? "-" : "") + fmtMoney(Math.abs(n));

/* ── cursor-follow spotlight ── */
(function () {
  if (REDUCED || matchMedia("(hover:none)").matches) return;
  const glow = document.getElementById("cursorGlow");
  addEventListener("mousemove", (e) => {
    glow.classList.add("on");
    glow.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%,-50%)`;
  });
  addEventListener("mouseleave", () => glow.classList.remove("on"));
})();

/* ── magnetic buttons ── */
function applyMagnetic(el) {
  if (REDUCED || matchMedia("(hover:none)").matches) return;
  el.addEventListener("mousemove", (e) => {
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - r.left - r.width / 2) / r.width;
    const dy = (e.clientY - r.top - r.height / 2) / r.height;
    el.style.transform = `translate(${dx * 7}px,${dy * 5}px)`;
  });
  el.addEventListener("mouseleave", () => { el.style.transform = ""; });
}
document.querySelectorAll(".btn-grad").forEach(applyMagnetic);

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

/* ── canvas helpers ── */
function fitCanvas(cv) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/* runs `draw(progress)` eased from 0 to 1 once `cv` scrolls into view, so charts draw
   in instead of just appearing already-rendered. Fires once per element. */
function animateOnceVisible(cv, draw) {
  if (REDUCED) { draw(1); return; }
  let done = false;
  const io = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting || done) return;
    done = true;
    io.disconnect();
    const start = performance.now();
    const dur = 700;
    function frame(t) {
      const p = Math.min(1, (t - start) / dur);
      draw(1 - Math.pow(1 - p, 3));
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }, { threshold: 0.2 });
  io.observe(cv);
}

/* ── ambient bar visual, used for both the hero and the gate canvas ── */
function ambientBars(cv, values, opts = {}) {
  const color = opts.color || "111,210,255";
  let t = 0, visible = true;
  new IntersectionObserver((e) => (visible = e[0].isIntersecting)).observe(cv);
  function frame() {
    requestAnimationFrame(frame);
    if (!visible) return;
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (!values.length) return;
    t += REDUCED ? 0 : 0.012;
    const max = Math.max(...values);
    const n = values.length;
    const gap = w / n;
    const barW = gap * 0.52;
    values.forEach((v, i) => {
      const bob = REDUCED ? 0 : Math.sin(t + i * 0.5) * 5;
      const bh = Math.max(6, (v / max) * (h * 0.72)) + bob;
      const x = i * gap + (gap - barW) / 2;
      const y = h - bh;
      const grad = ctx.createLinearGradient(0, y, 0, h);
      grad.addColorStop(0, `rgba(${color},.85)`);
      grad.addColorStop(1, `rgba(${color},.08)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, bh, [4, 4, 0, 0]);
      ctx.fill();
    });
  }
  frame();
}

/* ── horizontal revenue bar chart with hover tooltip, draws in on scroll-into-view ── */
function drawRevenueChart(cv, tipEl, data, progress = 1) {
  const rowH = 30;
  cv.style.height = data.length * rowH + 10 + "px";
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...data.map((d) => d.net_effective_revenue));
  const labelW = 190;
  const amtW = 100;
  const barMaxW = w - labelW - amtW - 16;

  ctx.font = "500 12.5px 'Instrument Sans'";
  ctx.textBaseline = "middle";

  const rows = data.map((d, i) => {
    const y = i * rowH + rowH / 2 + 5;
    const fullBarW = Math.max(4, (d.net_effective_revenue / max) * barMaxW);
    const barW = fullBarW * progress;

    ctx.fillStyle = "#9aa3b0";
    const label = d.canonical_name.length > 22 ? d.canonical_name.slice(0, 21) + "…" : d.canonical_name;
    ctx.fillText(label, 0, y);

    const trackX = labelW;
    ctx.fillStyle = "rgba(148,163,184,.12)";
    ctx.beginPath();
    ctx.roundRect(trackX, y - 4.5, barMaxW, 9, 99);
    ctx.fill();

    const grad = ctx.createLinearGradient(trackX, 0, trackX + Math.max(barW, 1), 0);
    grad.addColorStop(0, "#6fd2ff");
    grad.addColorStop(1, "#3fa9e8");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(trackX, y - 4.5, barW, 9, 99);
    ctx.fill();

    if (progress > 0.6) {
      ctx.fillStyle = "#f4f6f9";
      ctx.font = "600 12px 'JetBrains Mono'";
      ctx.globalAlpha = Math.min(1, (progress - 0.6) / 0.4);
      ctx.textAlign = "right";
      ctx.fillText(fmtMoney(d.net_effective_revenue), w, y);
      ctx.textAlign = "left";
      ctx.globalAlpha = 1;
      ctx.font = "500 12.5px 'Instrument Sans'";
    }

    return { y, top: i * rowH, bottom: (i + 1) * rowH, d };
  });

  cv.onmousemove = (e) => {
    const rect = cv.getBoundingClientRect();
    const my = e.clientY - rect.top;
    const row = rows.find((r) => my >= r.top && my < r.bottom);
    if (!row) { tipEl.classList.remove("on"); return; }
    tipEl.classList.add("on");
    tipEl.style.left = e.clientX - rect.left + "px";
    tipEl.style.top = row.y + "px";
    tipEl.innerHTML = `<b>${row.d.canonical_name}</b><br>${fmtMoney(row.d.net_effective_revenue)} net effective`;
  };
  cv.onmouseleave = () => tipEl.classList.remove("on");
}

/* ── donut chart, sweeps in on scroll-into-view ── */
const CATEGORY_COLORS = {
  base_rent: "#6fd2ff",
  ancillary: "#94a3b8",
  utility: "#34d399",
  commercial: "#f0b429",
  subsidy: "#a78bfa",
  fee: "#f87171",
  concession: "#5e6673",
};
function drawDonut(cv, byCategory, progress = 1) {
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 8, inner = r * 0.62;
  const positive = byCategory.filter((c) => c.amount > 0);
  const total = positive.reduce((s, c) => s + c.amount, 0);
  let angle = -Math.PI / 2;
  positive.forEach((c) => {
    const slice = (c.amount / total) * Math.PI * 2 * progress;
    ctx.beginPath();
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.arc(cx, cy, inner, angle + slice, angle, true);
    ctx.closePath();
    ctx.fillStyle = CATEGORY_COLORS[c.category] || "#6fd2ff";
    ctx.fill();
    angle += slice;
  });
}
function renderDonutLegend(legendEl, byCategory) {
  legendEl.innerHTML = [...byCategory].sort((a, b) => b.amount - a.amount).map((c) => `
    <div class="dl-row">
      <span class="dl-sw" style="background:${CATEGORY_COLORS[c.category] || "#6fd2ff"}"></span>
      <span class="dl-name">${c.category.replace("_", " ")}</span>
      <span class="dl-amt mono">${fmtMoneySigned(c.amount)}</span>
    </div>
  `).join("");
}

/* ── API fetch helpers ── */
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function init() {
  const [stats, revenue, properties, anomalies, delinquent, leases] = await Promise.all([
    api("/stats"),
    api("/revenue/portfolio"),
    api("/properties"),
    api("/anomalies"),
    api("/delinquent"),
    api("/leases/expiring?days=60"),
  ]);

  const sortedByRevenue = [...revenue.by_property].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue);

  renderStats(stats);
  renderTicker(sortedByRevenue);
  renderHeroChart(sortedByRevenue);
  renderGate(sortedByRevenue, revenue.total_net_effective_revenue);
  renderRevenueChart(revenue, sortedByRevenue);
  renderDonut(revenue.by_category);
  renderMarquee(sortedByRevenue);
  renderAnomalies(anomalies);
  renderDelinquent(delinquent);
  renderLeases(leases.leases);

  const first = await api(`/properties/${sortedByRevenue[0].property_id}`);
  const asOfDate = first?.latest_as_of_date?.rent_roll;
  document.getElementById("asOfNote").textContent = `AS OF ${asOfDate || "—"} · 15 PROPERTIES`;

  observeReveals();
  window.addEventListener("resize", () => {
    renderHeroChart(sortedByRevenue);
    drawRevenueChart(document.getElementById("revenueChart"), document.getElementById("revenueTip"), sortedByRevenue, 1);
    drawDonut(document.getElementById("donutChart"), revenue.by_category, 1);
  });
}

function renderStats(stats) {
  const tiles = [stats.charge_total_mismatches, stats.properties, stats.tenancies, stats.data_quality_flags];
  document.querySelectorAll(".stats .v").forEach((el, i) => {
    el.dataset.count = tiles[i];
    countObserver.observe(el);
  });
}

function renderTicker(sorted) {
  const track = document.getElementById("tape");
  const entries = sorted.concat(sorted);
  track.innerHTML = entries.map((p, i) => {
    const initial = p.canonical_name.trim()[0].toUpperCase();
    return `<span class="tk" style="--i:${i % sorted.length}">
      <span class="chip">${initial}</span>
      <span class="sym">${p.canonical_name}</span>
      <span class="px mono">${fmtMoney(p.net_effective_revenue)}</span>
    </span>`;
  }).join("");
}

function renderHeroChart(sorted) {
  const cv = document.getElementById("heroChart");
  ambientBars(cv, sorted.map((p) => p.net_effective_revenue), { color: "111,210,255" });
}

function renderGate(sorted, totalRevenue) {
  const cv = document.getElementById("gateChart");
  ambientBars(cv, sorted.map((p) => p.net_effective_revenue), { color: "111,210,255" });
  document.getElementById("gateRevenue").textContent = fmtMoney(totalRevenue);
}

function renderRevenueChart(revenue, sorted) {
  const cv = document.getElementById("revenueChart");
  const tip = document.getElementById("revenueTip");
  animateOnceVisible(cv, (progress) => drawRevenueChart(cv, tip, sorted, progress));
  document.getElementById("revenueFoot").innerHTML = `
    <span>gross <b>${fmtMoney(revenue.total_gross_revenue)}</b></span>
    <span>concessions <b>${fmtMoneySigned(revenue.total_concessions)}</b></span>
    <span>net effective <b>${fmtMoney(revenue.total_net_effective_revenue)}</b></span>
  `;
}

function renderDonut(byCategory) {
  const cv = document.getElementById("donutChart");
  animateOnceVisible(cv, (progress) => drawDonut(cv, byCategory, progress));
  renderDonutLegend(document.getElementById("donutLegend"), byCategory);
}

function renderMarquee(sorted) {
  const cardHtml = (p) => `
    <div class="prop-card">
      <div class="n">${p.canonical_name}</div>
      <div class="d">${p.property_id}</div>
      <div class="r"><span>Net effective</span><span class="rev mono">${fmtMoney(p.net_effective_revenue)}</span></div>
    </div>`;
  const half = Math.ceil(sorted.length / 2);
  document.getElementById("mq1").innerHTML = sorted.slice(0, half).concat(sorted.slice(0, half)).map(cardHtml).join("");
  document.getElementById("mq2").innerHTML = sorted.slice(half).concat(sorted.slice(half)).map(cardHtml).join("");
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

function renderDelinquent(rows) {
  const el = document.getElementById("delinquentList");
  if (!rows.length) {
    el.innerHTML = `<div class="risk-empty">No outstanding balances.</div>`;
    return;
  }
  el.innerHTML = rows.slice(0, 8).map((r) => `
    <div class="risk-row">
      <div class="rr-name">
        <div class="rr-prop">${r.resident_name || "—"} &middot; ${r.property_id}/${r.unit_number}</div>
        <div class="rr-sub">unit ${r.unit_number}</div>
      </div>
      <div class="rr-amt">${fmtMoney(r.balance)}</div>
    </div>
  `).join("");
}

function renderLeases(rows) {
  const el = document.getElementById("leaseList");
  if (!rows.length) {
    el.innerHTML = `<div class="risk-empty">No leases expiring in this window.</div>`;
    return;
  }
  el.innerHTML = rows.slice(0, 8).map((r) => `
    <div class="risk-row">
      <div class="rr-name">
        <div class="rr-prop">${r.resident_name || "—"} &middot; ${r.property_id}/${r.unit_number}</div>
        <div class="rr-sub">expires ${r.lease_expiration}</div>
      </div>
      <div class="rr-amt warn">${r.market_rent ? fmtMoney(r.market_rent) : "—"}</div>
    </div>
  `).join("");
}

/* ── entry gate dismiss (cosmetic only, no real auth) ── */
document.getElementById("gateEnter").addEventListener("click", () => {
  document.getElementById("gate").classList.add("hidden");
});

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="position:fixed;top:0;left:0;right:0;z-index:999;background:#f87171;color:#1a0000;padding:10px;text-align:center;font-family:monospace;font-size:13px">Failed to load portfolio data: ${err.message}</div>`
  );
});
