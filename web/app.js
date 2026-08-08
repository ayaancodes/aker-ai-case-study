/* ── ambient bar visual, used for the gate's canvas ── */
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

/* ── perspective particle field, adapted from Vega's hero background (2D canvas
   version, permission granted to reuse/adapt) -- purely atmospheric motion, the
   only visual in the hero besides the headline itself. ── */
function particleField(cv) {
  if (REDUCED || !cv) return;
  const ctx = cv.getContext("2d");
  const COLS = 70, ROWS = 26;
  let t = 0, visible = true;
  new IntersectionObserver((e) => (visible = e[0].isIntersecting)).observe(cv);
  function frame() {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    t += 0.014;
    const horizon = H * 0.28, base = H * 1.05;
    for (let z = ROWS - 1; z >= 0; z--) {
      const pz = z / (ROWS - 1);
      const y0 = horizon + (base - horizon) * Math.pow(pz, 1.7);
      const spread = W * (0.5 + 1.0 * pz);
      const size = 0.6 + 2.1 * pz;
      const amp = 4 + 22 * pz;
      for (let x = 0; x < COLS; x++) {
        const px = x / (COLS - 1);
        const wob = Math.sin(x * 0.3 + t) * amp * 0.5 + Math.cos(z * 0.32 + t * 0.8) * amp * 0.5;
        const X = W / 2 + (px - 0.5) * spread;
        const Y = y0 + wob;
        const r = Math.round(111 + (59 - 111) * px);
        const g = Math.round(210 + (91 - 210) * px);
        const b = Math.round(255 + (133 - 255) * px);
        ctx.fillStyle = `rgba(${r},${g},${b},${0.1 + 0.35 * pz})`;
        ctx.beginPath();
        ctx.arc(X, Y, size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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
  const narrow = w < 420;
  const labelW = narrow ? Math.round(w * 0.34) : 190;
  const amtW = narrow ? Math.round(w * 0.22) : 100;
  const maxLabelChars = narrow ? 10 : 22;
  const barMaxW = Math.max(20, w - labelW - amtW - 16);

  ctx.font = `500 ${narrow ? 11 : 12.5}px 'Instrument Sans'`;
  ctx.textBaseline = "middle";

  const rows = data.map((d, i) => {
    const y = i * rowH + rowH / 2 + 5;
    const fullBarW = Math.max(4, (d.net_effective_revenue / max) * barMaxW);
    const barW = fullBarW * progress;

    ctx.fillStyle = "#9aa3b0";
    const label = d.canonical_name.length > maxLabelChars
      ? d.canonical_name.slice(0, maxLabelChars - 1) + "…"
      : d.canonical_name;
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
      ctx.fillText(fmtMoney(d.net_effective_revenue), w, y);
      ctx.textAlign = "left";
      ctx.globalAlpha = 1;
      ctx.font = `500 ${narrow ? 11 : 12.5}px 'Instrument Sans'`;
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

async function init() {
  const [revenue, properties, delinquent, leases] = await Promise.all([
    api("/revenue/portfolio"),
    api("/properties"),
    api("/delinquent"),
    api("/leases/expiring?days=60"),
  ]);

  const sortedByRevenue = [...revenue.by_property].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue);

  renderTicker(sortedByRevenue);
  particleField(document.getElementById("heroField"));
  renderGate(sortedByRevenue, revenue.total_net_effective_revenue);
  initExplorer(properties, sortedByRevenue);
  renderRevenueChart(revenue, sortedByRevenue);
  renderDonut(revenue.by_category);
  renderMarquee(sortedByRevenue);
  renderDelinquent(delinquent);
  renderLeases(leases.leases);

  const first = await api(`/properties/${sortedByRevenue[0].property_id}`);
  const asOfDate = first?.latest_as_of_date?.rent_roll;
  document.getElementById("asOfNote").textContent = `AS OF ${asOfDate || "—"} · 15 PROPERTIES`;

  observeReveals();
  window.addEventListener("resize", () => {
    drawRevenueChart(document.getElementById("revenueChart"), document.getElementById("revenueTip"), sortedByRevenue, 1);
    drawDonut(document.getElementById("donutChart"), revenue.by_category, 1);
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

/* ── property explorer — search, revenue waterfall, portfolio-rank comparison.
   Real API calls (/revenue/{id}), no client-side mock data. ── */
function initExplorer(properties, sortedByRevenue) {
  const search = document.getElementById("explSearch");
  const dropdown = document.getElementById("explDropdown");
  const empty = document.getElementById("explEmpty");
  const body = document.getElementById("explBody");

  function openDropdown(query) {
    const q = query.trim().toLowerCase();
    const matches = q
      ? properties.filter((p) => p.canonical_name.toLowerCase().includes(q))
      : properties;
    if (!matches.length) { dropdown.classList.remove("open"); return; }
    dropdown.innerHTML = matches.slice(0, 8).map((p) =>
      `<div data-id="${p.property_id}">${p.canonical_name}</div>`
    ).join("");
    dropdown.classList.add("open");
  }

  search.addEventListener("input", () => openDropdown(search.value));
  search.addEventListener("focus", () => openDropdown(search.value));
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".explore-search-in")) dropdown.classList.remove("open");
  });
  dropdown.addEventListener("click", (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    const p = properties.find((x) => x.property_id === id);
    search.value = p.canonical_name;
    dropdown.classList.remove("open");
    selectProperty(id, p.canonical_name);
  });

  async function selectProperty(propertyId, name) {
    const rev = await api(`/revenue/${propertyId}`);
    empty.classList.add("hidden");
    body.classList.add("on");
    document.getElementById("explName").textContent = name;
    document.getElementById("explId").textContent = propertyId;

    const gross = rev.gross_revenue, conc = Math.abs(rev.concessions), net = rev.net_effective_revenue;
    const max = Math.max(gross, net) || 1;
    const heights = { gross: (gross / max) * 100, conc: (conc / max) * 100, net: (net / max) * 100 };

    requestAnimationFrame(() => {
      document.getElementById("wfGross").style.height = heights.gross + "%";
      document.getElementById("wfConc").style.height = heights.conc + "%";
      document.getElementById("wfNet").style.height = heights.net + "%";
      ["wfGrossVal", "wfConcVal", "wfNetVal"].forEach((id) => document.getElementById(id).classList.add("shown"));
      document.getElementById("wfGrossVal").textContent = fmtMoney(gross);
      document.getElementById("wfConcVal").textContent = fmtMoneySigned(rev.concessions);
      document.getElementById("wfNetVal").textContent = fmtMoney(net);
    });

    const rankMax = sortedByRevenue[0].net_effective_revenue || 1;
    document.getElementById("explRank").innerHTML = sortedByRevenue.map((p) => `
      <div class="rank-row ${p.property_id === propertyId ? "hl" : ""}">
        <div class="rk-name">${p.canonical_name}</div>
        <div class="rk-track"><div class="rk-fill" style="width:${(p.net_effective_revenue / rankMax) * 100}%"></div></div>
      </div>
    `).join("");
  }

  // pre-select the top property so the panel isn't empty on first paint
  if (sortedByRevenue.length) {
    search.value = sortedByRevenue[0].canonical_name;
    selectProperty(sortedByRevenue[0].property_id, sortedByRevenue[0].canonical_name);
  }
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
