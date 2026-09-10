/* Landing page: a personalized greeting, the live portfolio pulse line, the ticker,
   and the sign-in modal. All analytics live in dashboard.html -- the landing stays
   deliberately small. */

/* ── perspective particle field, 2D canvas -- purely atmospheric motion, the
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
      const size = 0.9 + 2.5 * pz;
      const amp = 4 + 22 * pz;
      for (let x = 0; x < COLS; x++) {
        const px = x / (COLS - 1);
        const wob = Math.sin(x * 0.3 + t) * amp * 0.5 + Math.cos(z * 0.32 + t * 0.8) * amp * 0.5;
        const X = W / 2 + (px - 0.5) * spread;
        const Y = y0 + wob;
        const r = Math.round(127 + (62 - 127) * px);
        const g = Math.round(199 + (107 - 199) * px);
        const b = Math.round(155 + (79 - 155) * px);
        ctx.fillStyle = `rgba(${r},${g},${b},${0.22 + 0.5 * pz})`;
        ctx.beginPath();
        ctx.arc(X, Y, size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  frame();
}

async function init() {
  particleField(document.getElementById("heroField"));

  const [revenue, occupancy] = await Promise.all([
    api("/revenue/portfolio"),
    api("/occupancy/portfolio"),
  ]);

  const sorted = [...revenue.by_property].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue);

  // the live pulse under the greeting, as fact chips -- real numbers, same API the
  // dashboard uses
  document.getElementById("portfolioPulse").innerHTML = [
    `<b>${revenue.by_property.length}</b>&nbsp;PROPERTIES`,
    `<b>${fmtMoney(revenue.total_net_effective_revenue)}</b>&nbsp;NET EFFECTIVE`,
    `<b>${occupancy.pct_occ != null ? occupancy.pct_occ.toFixed(1) + "%" : "—"}</b>&nbsp;OCCUPIED`,
  ].map((t) => `<span class="dash-chip">${t}</span>`).join("");

  renderTicker(sorted);

  const first = await api(`/properties/${sorted[0].property_id}`);
  startLiveClock(document.getElementById("asOfNote"), first?.latest_as_of_date?.rent_roll || "—");
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

/* ── sign-in modal. DEMO AFFORDANCE, not real auth: one fixed credential pair
   checked client-side, no backend, no hashing -- the point is the flow, not
   security. A sessionStorage flag remembers the login for this tab session only,
   so coming back to the landing page never re-prompts until the tab closes. ── */
(function () {
  const DEMO_EMAIL = "demo@example.com";
  const DEMO_PASSWORD = "demo2026";
  const AUTH_KEY = "terminal_authed";

  const modal = document.getElementById("loginModal");
  const errorEl = document.getElementById("gateError");
  const open = () => {
    // already signed in this session: straight to the dashboard, no second prompt
    if (sessionStorage.getItem(AUTH_KEY) === "1") {
      window.location.href = "dashboard.html";
      return;
    }
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    modal.querySelector(".gate-input")?.focus();
  };
  const close = () => {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    errorEl.classList.remove("shown");
  };
  document.querySelectorAll("[data-open-login]").forEach((b) => b.addEventListener("click", open));
  document.getElementById("loginBackdrop").addEventListener("click", close);
  document.getElementById("loginClose").addEventListener("click", close);
  addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  const tryLogin = () => {
    const email = document.getElementById("gateEmail").value.trim().toLowerCase();
    const password = document.getElementById("gatePassword").value;
    if (email === DEMO_EMAIL && password === DEMO_PASSWORD) {
      sessionStorage.setItem(AUTH_KEY, "1");
      window.location.href = "dashboard.html";
    } else {
      errorEl.classList.add("shown");
    }
  };
  document.getElementById("gateEnter").addEventListener("click", tryLogin);
  [document.getElementById("gateEmail"), document.getElementById("gatePassword")].forEach((el) => {
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") tryLogin(); });
    el.addEventListener("input", () => errorEl.classList.remove("shown"));
  });
})();

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="position:fixed;top:0;left:0;right:0;z-index:999;background:#f87171;color:#1a0000;padding:10px;text-align:center;font-family:monospace;font-size:13px">Failed to load portfolio data: ${err.message}</div>`
  );
});
