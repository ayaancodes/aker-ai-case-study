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
