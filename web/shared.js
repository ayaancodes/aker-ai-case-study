const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmtMoney = (n) => "$" + Math.round(n).toLocaleString("en-US");
const fmtMoneySigned = (n) => (n < 0 ? "-" : "") + fmtMoney(Math.abs(n));

/* ── cursor-follow spotlight ── */
(function () {
  if (REDUCED || matchMedia("(hover:none)").matches) return;
  const glow = document.getElementById("cursorGlow");
  if (!glow) return;
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
(function () {
  const nav = document.getElementById("nav");
  if (!nav) return;
  addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 30), { passive: true });
})();

/* ── side rail scrollspy (only present on pages that have .rail) ── */
(function () {
  const rail = document.getElementById("rail");
  if (!rail) return;
  const links = [...rail.querySelectorAll("a")];
  const ids = links.map((a) => a.dataset.rail);
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const id = e.target.id || "top";
      links.forEach((a) => a.classList.toggle("on", a.dataset.rail === id));
    });
  }, { rootMargin: "-40% 0px -55% 0px" });
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) io.observe(el);
  });
})();

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

/* runs `draw(progress)` eased from 0 to 1 once `cv` scrolls into view, so charts/terminal
   draw in instead of just appearing already-rendered. Fires once per element. */
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

/* ── API fetch helper ── */
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/* ── horizontal bar chart w/ hover tooltip, draws in on scroll-into-view. Used for
   both revenue ($) and occupancy (%) -- `fmt` controls the value formatter and the
   getter functions pull the right fields off each row. ── */
function drawBarChart(cv, tipEl, data, opts) {
  const { getValue, getLabel, fmt, tooltipLabel, progress = 1 } = opts;
  const rowH = 30;
  cv.style.height = data.length * rowH + 10 + "px";
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...data.map(getValue)) || 1;
  const narrow = w < 420;
  const labelW = narrow ? Math.round(w * 0.34) : 190;
  const amtW = narrow ? Math.round(w * 0.22) : 100;
  const maxLabelChars = narrow ? 10 : 22;
  const barMaxW = Math.max(20, w - labelW - amtW - 16);

  ctx.font = `500 ${narrow ? 11 : 12.5}px 'Instrument Sans'`;
  ctx.textBaseline = "middle";

  const rows = data.map((d, i) => {
    const y = i * rowH + rowH / 2 + 5;
    const value = getValue(d);
    const fullBarW = Math.max(4, (value / max) * barMaxW);
    const barW = fullBarW * progress;

    ctx.fillStyle = "#9aa3b0";
    const rawLabel = getLabel(d);
    const label = rawLabel.length > maxLabelChars ? rawLabel.slice(0, maxLabelChars - 1) + "…" : rawLabel;
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
      ctx.font = `600 ${narrow ? 10.5 : 12}px 'JetBrains Mono'`;
      ctx.globalAlpha = Math.min(1, (progress - 0.6) / 0.4);
      ctx.textAlign = "right";
      ctx.fillText(fmt(value), w, y);
      ctx.textAlign = "left";
      ctx.globalAlpha = 1;
      ctx.font = `500 ${narrow ? 11 : 12.5}px 'Instrument Sans'`;
    }

    return { y, top: i * rowH, bottom: (i + 1) * rowH, d, value };
  });

  cv.onmousemove = (e) => {
    const rect = cv.getBoundingClientRect();
    const my = e.clientY - rect.top;
    const row = rows.find((r) => my >= r.top && my < r.bottom);
    if (!row) { tipEl.classList.remove("on"); return; }
    tipEl.classList.add("on");
    tipEl.style.left = e.clientX - rect.left + "px";
    tipEl.style.top = row.y + "px";
    tipEl.innerHTML = `<b>${getLabel(row.d)}</b><br>${fmt(row.value)} ${tooltipLabel || ""}`;
  };
  cv.onmouseleave = () => tipEl.classList.remove("on");
}

function drawRevenueChart(cv, tipEl, data, progress = 1) {
  drawBarChart(cv, tipEl, data, {
    getValue: (d) => d.net_effective_revenue,
    getLabel: (d) => d.canonical_name,
    fmt: fmtMoney,
    tooltipLabel: "net effective",
    progress,
  });
}

function drawOccupancyChart(cv, tipEl, data, progress = 1) {
  drawBarChart(cv, tipEl, data, {
    getValue: (d) => d.pct_occ || 0,
    getLabel: (d) => d.canonical_name,
    fmt: (v) => v.toFixed(1) + "%",
    tooltipLabel: "occupied",
    progress,
  });
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
  residential: "#6fd2ff",
  affordable: "#a78bfa",
  land: "#5e6673",
};
function drawDonut(cv, byCategory, progress = 1, key = "category") {
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
    ctx.fillStyle = CATEGORY_COLORS[c[key]] || "#6fd2ff";
    ctx.fill();
    angle += slice;
  });
}
function renderDonutLegend(legendEl, byCategory, key = "category") {
  legendEl.innerHTML = [...byCategory].sort((a, b) => b.amount - a.amount).map((c) => `
    <div class="dl-row">
      <span class="dl-sw" style="background:${CATEGORY_COLORS[c[key]] || "#6fd2ff"}"></span>
      <span class="dl-name">${c[key].replace("_", " ")}</span>
      <span class="dl-amt mono">${fmtMoneySigned(c.amount)}</span>
    </div>
  `).join("");
}

/* ── risk lists (delinquent balances / lease rollover), reused on both the product
   page (portfolio-wide) and the dashboard (portfolio-wide or property-scoped). ── */
function renderDelinquentList(elId, rows) {
  const el = document.getElementById(elId);
  if (!el) return;
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
function renderLeaseList(elId, rows) {
  const el = document.getElementById(elId);
  if (!el) return;
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
