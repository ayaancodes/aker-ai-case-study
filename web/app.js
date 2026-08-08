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
  initExplorer(properties, sortedByRevenue);
  renderRevenueChart(revenue, sortedByRevenue);
  renderDonut(revenue.by_category);
  renderMarquee(sortedByRevenue);
  renderDelinquentList("delinquentList", delinquent);
  renderLeaseList("leaseList", leases.leases);

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

/* ── sign-in modal (cosmetic only, no real auth) -- Enter navigates to the dashboard ── */
(function () {
  const modal = document.getElementById("loginModal");
  const open = () => {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    modal.querySelector(".gate-input")?.focus();
  };
  const close = () => {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  };
  document.querySelectorAll("[data-open-login]").forEach((b) => b.addEventListener("click", open));
  document.getElementById("loginBackdrop").addEventListener("click", close);
  document.getElementById("loginClose").addEventListener("click", close);
  addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  document.getElementById("gateEnter").addEventListener("click", () => {
    window.location.href = "dashboard.html";
  });
})();

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="position:fixed;top:0;left:0;right:0;z-index:999;background:#f87171;color:#1a0000;padding:10px;text-align:center;font-family:monospace;font-size:13px">Failed to load portfolio data: ${err.message}</div>`
  );
});
