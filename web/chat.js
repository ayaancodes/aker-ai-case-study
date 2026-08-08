/* AM Copilot page. Streams from POST /chat via hand-rolled SSE parsing (EventSource
   can't send a POST body). Presentation follows the v2 brief: throttled typewriter
   text with click-to-skip, evidence deferred until the prose finishes, one card max
   per response with further datasets collapsed into expandable chips, and Vega
   methodology motion (popin, staggered rows, bar draw-in, pass-pulse, sheen).
   History is session-only, in memory. */

const copilotMessages = document.getElementById("copilotMessages");
const copilotInput = document.getElementById("copilotInput");
const copilotSend = document.getElementById("copilotSend");
const copilotSuggest = document.getElementById("copilotSuggest");
const asOfNote = document.getElementById("asOfNote");

let chatHistory = [];
let sending = false;
let skipActiveReveal = null; // set per turn while the typewriter is running

/* reveal rate for the typewriter -- time-based (not per-frame) so a throttled or
   backgrounded tab catches up in chunks instead of stalling. ~150 chars/sec reads
   calm but not sluggish. Click the message to skip to the end. */
const CHARS_PER_SEC = 150;
const TYPE_TICK_MS = 33;

api("/leases/expiring?days=0").then((d) => {
  asOfNote.textContent = `AS OF ${d.reference_date}`;
}).catch(() => {});

function scrollToBottom() {
  copilotMessages.scrollTop = copilotMessages.scrollHeight;
}

/* escape first, THEN allow only **bold** through -- model text is untrusted input */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function formatAssistantText(s) {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function addMessage(role, text) {
  const row = document.createElement("div");
  row.className = `copilot-msg ${role}`;
  const avatar = role === "assistant" ? `<span class="copilot-avatar">A</span>` : "";
  row.innerHTML = `${avatar}<div class="copilot-bubble-text"></div>`;
  const bubble = row.querySelector(".copilot-bubble-text");
  bubble.textContent = text;
  copilotMessages.appendChild(row);
  scrollToBottom();
  return bubble;
}

function addThinkingRow() {
  const row = document.createElement("div");
  row.className = "copilot-thinking";
  row.innerHTML = `<span class="copilot-avatar">A</span><span class="copilot-thinking-text">Reading the question</span>`;
  copilotMessages.appendChild(row);
  scrollToBottom();
  return row;
}

function addToolChip(label) {
  const chip = document.createElement("div");
  chip.className = "copilot-tool-chip";
  chip.textContent = label;
  copilotMessages.appendChild(chip);
  scrollToBottom();
  return chip;
}

/* ── evidence card builders: HTML straight from the raw tool_result payload, no LLM
   tokens involved. Builders return an HTML string or null for shapes with nothing
   worth carding. Tables mark rows .row-in with a stagger delay; bar fills render at
   data-w so the entrance animation can draw them to width. ── */
function kpiRowHtml(pairs) {
  return `<div class="copilot-kpi-row">` + pairs.map(([label, value]) => `
    <div><div class="copilot-kpi-v mono">${value}</div><div class="copilot-kpi-k">${label}</div></div>
  `).join("") + `</div>`;
}

function barListHtml(items) {
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  return `<div class="copilot-barlist">` + items.map((i) => `
    <div class="copilot-bar-row">
      <div class="copilot-bar-label">${i.label}</div>
      <div class="copilot-bar-track"><div class="copilot-bar-fill" data-w="${Math.max(4, (Math.abs(i.value) / max) * 100)}"></div></div>
      <div class="copilot-bar-val mono">${i.fmtValue}</div>
    </div>
  `).join("") + `</div>`;
}

function tableHtml(columns, rows, cap = 8) {
  const shown = rows.slice(0, cap);
  const more = rows.length - shown.length;
  return `<div class="copilot-table-wrap"><table class="copilot-table">
    <thead><tr>${columns.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>
    <tbody>${shown.map((r, i) => `<tr class="row-in" style="animation-delay:${i * 45}ms">${columns.map((c) => `<td>${c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? "&mdash;")}</td>`).join("")}</tr>`).join("")}</tbody>
  </table>${more > 0 ? `<div class="copilot-table-more">+ ${more} more &mdash; ask a narrower question to see them</div>` : ""}</div>`;
}

function buildCardHtml(name, result) {
  try {
    switch (name) {
      case "portfolio_revenue": {
        const kpi = kpiRowHtml([
          ["Gross", fmtMoney(result.total_gross_revenue)],
          ["Concessions", fmtMoneySigned(result.total_concessions)],
          ["Net effective", fmtMoney(result.total_net_effective_revenue)],
        ]);
        const top = [...result.by_property].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue).slice(0, 8);
        return kpi + barListHtml(top.map((p) => ({ label: p.canonical_name, value: p.net_effective_revenue, fmtValue: fmtMoney(p.net_effective_revenue) })));
      }
      case "property_revenue": {
        const kpi = kpiRowHtml([
          ["Gross", fmtMoney(result.gross_revenue)],
          ["Concessions", fmtMoneySigned(result.concessions)],
          ["Net effective", fmtMoney(result.net_effective_revenue)],
        ]);
        const bars = result.by_category?.length
          ? barListHtml(result.by_category.map((c) => ({ label: c.category.replace("_", " "), value: c.amount, fmtValue: fmtMoneySigned(c.amount) })))
          : "";
        return kpi + bars;
      }
      case "revenue_concentration":
        if (!result.length) return null;
        return barListHtml(result.map((r) => ({ label: r.program_type, value: r.amount, fmtValue: fmtMoney(r.amount) })));
      case "occupancy_portfolio": {
        const kpi = kpiRowHtml([
          ["Units", result.total_units],
          ["Occupied", result.total_occupied],
          ["% Occ", result.pct_occ != null ? result.pct_occ.toFixed(1) + "%" : "&mdash;"],
        ]);
        const top = [...result.by_property].sort((a, b) => (b.pct_occ || 0) - (a.pct_occ || 0)).slice(0, 8);
        return kpi + barListHtml(top.map((p) => ({ label: p.canonical_name, value: p.pct_occ || 0, fmtValue: (p.pct_occ ?? 0).toFixed(1) + "%" })));
      }
      case "occupancy_property":
        return kpiRowHtml([
          ["Units", result.total_units],
          ["Occupied", result.occupied],
          ["Vacant", result.vacant],
          ["Notice", result.on_notice],
          ["% Occ", result.pct_occ != null ? result.pct_occ.toFixed(1) + "%" : "&mdash;"],
        ]);
      case "delinquent_tenancies":
        if (!result.length) return `<div class="copilot-empty">No outstanding balances.</div>`;
        return tableHtml(
          [{ key: "resident_name", label: "Resident" }, { key: "canonical_name", label: "Property" }, { key: "unit_number", label: "Unit" }, { key: "balance", label: "Balance", fmt: fmtMoney }],
          [...result].sort((a, b) => b.balance - a.balance)
        );
      case "leases_expiring":
        if (!result.leases.length) return `<div class="copilot-empty">Nothing expiring in this window.</div>`;
        return tableHtml(
          [{ key: "resident_name", label: "Resident" }, { key: "canonical_name", label: "Property" }, { key: "unit_number", label: "Unit" }, { key: "lease_expiration", label: "Expires" }, { key: "market_rent", label: "Rent", fmt: (v) => v ? fmtMoney(v) : "&mdash;" }],
          result.leases
        );
      case "leases_holdover":
        if (!result.holdovers.length) return `<div class="copilot-empty">No holdover leases.</div>`;
        return kpiRowHtml([["Holdovers", result.holdover_count], ["As of", result.reference_date]]) + tableHtml(
          [{ key: "resident_name", label: "Resident" }, { key: "canonical_name", label: "Property" }, { key: "unit_number", label: "Unit" }, { key: "lease_expiration", label: "Expired" }, { key: "market_rent", label: "Rent", fmt: (v) => v ? fmtMoney(v) : "&mdash;" }],
          result.holdovers
        );
      case "anomalies":
        if (!result.length) return `<div class="copilot-empty">No data quality flags.</div>`;
        return tableHtml(
          [{ key: "property_id", label: "Prop" }, { key: "flag_type", label: "Type" }, { key: "detail", label: "Detail" }],
          result, 6
        );
      case "property_units":
        if (!result.length) return null;
        return tableHtml(
          [{ key: "unit_number", label: "Unit" }, { key: "status", label: "Status" }, { key: "resident_name", label: "Resident", fmt: (v) => v || "&mdash;" }, { key: "market_rent", label: "Rent", fmt: (v) => v ? fmtMoney(v) : "&mdash;" }, { key: "balance", label: "Bal", fmt: (v) => v ? fmtMoney(v) : "&mdash;" }],
          result
        );
      case "unit_lookup":
        if (result.multiple_matches) return null;
        // fall through -- single-match payload is identical to unit_detail
      case "unit_detail": {
        const t = result.tenancy;
        const kpi = kpiRowHtml([
          ["Rent", t?.market_rent ? fmtMoney(t.market_rent) : "&mdash;"],
          ["Balance", t?.balance ? fmtMoney(t.balance) : "$0"],
          ["Total charges", fmtMoney(result.total_charges)],
        ]);
        const charges = result.charges.length
          ? tableHtml([{ key: "charge_code", label: "Code" }, { key: "category", label: "Category" }, { key: "amount", label: "Amount", fmt: fmtMoneySigned }], result.charges)
          : `<div class="copilot-empty">No charge lines recorded for this tenancy.</div>`;
        return kpi + charges;
      }
      case "list_properties":
        return tableHtml([{ key: "property_id", label: "Code" }, { key: "canonical_name", label: "Property" }], result, 20);
      case "portfolio_stats":
        return kpiRowHtml([
          ["Properties", result.properties],
          ["Tenancies", result.tenancies],
          ["Charges", result.charges],
          ["Flags", result.data_quality_flags],
        ]);
      default:
        return null;
    }
  } catch (err) {
    console.error("buildCardHtml failed for", name, err);
    return null;
  }
}

const CHIP_LABELS = {
  portfolio_revenue: "revenue data", property_revenue: "revenue data",
  revenue_concentration: "concentration mix", occupancy_portfolio: "occupancy data",
  occupancy_property: "occupancy data", delinquent_tenancies: "delinquent balances",
  leases_expiring: "expiring leases", leases_holdover: "holdover leases",
  anomalies: "data quality flags", property_units: "unit list",
  unit_detail: "unit detail", unit_lookup: "unit detail",
  list_properties: "property list", portfolio_stats: "portfolio stats",
};

/* card entrance: popin, then bars draw to width, one sheen sweep, and if the
   grounding check passed clean, KPI numbers pulse green once */
function insertAnimatedCard(afterEl, html, groundingClean) {
  const card = document.createElement("div");
  card.className = "copilot-card entering";
  card.innerHTML = html + `<div class="sheen"></div>`;
  afterEl.after(card);
  requestAnimationFrame(() => {
    card.querySelectorAll(".copilot-bar-fill").forEach((f) => { f.style.width = f.dataset.w + "%"; });
    if (groundingClean) card.querySelectorAll(".copilot-kpi-v").forEach((k) => k.classList.add("pass"));
  });
  card.addEventListener("animationend", (e) => { if (e.target === card) card.classList.remove("entering"); }, { once: true });
  scrollToBottom();
  return card;
}

async function sendMessage(forcedText) {
  const text = (forcedText ?? copilotInput.value).trim();
  if (!text || sending) return;

  sending = true;
  copilotSend.disabled = true;
  copilotInput.value = "";
  if (copilotSuggest) copilotSuggest.remove();
  addMessage("user", text);
  chatHistory.push({ role: "user", content: text });

  const thinkingRow = addThinkingRow();
  const thinkingText = thinkingRow.querySelector(".copilot-thinking-text");
  const finishThinking = () => { if (thinkingRow.isConnected) thinkingRow.remove(); };

  /* per-turn state: text reveals through a throttled typewriter; evidence (tool
     results) queues up and renders only after the prose finishes */
  let assistantEl = null;
  let fullText = "";
  let shownChars = 0;
  let streamDone = false;
  let finalized = false;
  let sawAnyOutput = false;
  const pendingEvidence = [];
  let groundingUnverified = null;
  let liveChips = [];

  const renderShown = (withCaret) => {
    assistantEl.innerHTML = formatAssistantText(fullText.slice(0, shownChars)) +
      (withCaret ? `<span class="copilot-caret"></span>` : "");
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    skipActiveReveal = null;
    finishThinking();
    liveChips.forEach((c) => c.classList.add("settled"));

    if (assistantEl) renderShown(false);
    if (fullText) chatHistory.push({ role: "assistant", content: fullText });

    // evidence after prose: first dataset becomes the card, the rest collapse into
    // expandable chips -- one graphic max unless the user asks for more
    const anchor = assistantEl ? assistantEl.closest(".copilot-msg") : copilotMessages.lastElementChild;
    let lastEl = anchor;
    const clean = !groundingUnverified;
    if (pendingEvidence.length) {
      const first = pendingEvidence[0];
      const firstHtml = buildCardHtml(first.tool, first.result);
      if (firstHtml) lastEl = insertAnimatedCard(lastEl, firstHtml, clean);

      const rest = pendingEvidence.slice(1).filter((e) => buildCardHtml(e.tool, e.result));
      if (rest.length) {
        const row = document.createElement("div");
        row.className = "copilot-more-row";
        rest.forEach((e) => {
          const btn = document.createElement("button");
          btn.className = "copilot-more-chip";
          btn.textContent = `+ ${CHIP_LABELS[e.tool] || e.tool.replace(/_/g, " ")}`;
          btn.addEventListener("click", () => {
            btn.disabled = true;
            insertAnimatedCard(row, buildCardHtml(e.tool, e.result), clean);
          }, { once: true });
          row.appendChild(btn);
        });
        lastEl.after(row);
        lastEl = row;
      }
    }

    if (groundingUnverified?.length) {
      const warn = document.createElement("div");
      warn.className = "copilot-grounding-warn";
      warn.textContent = `Could not verify against tool data: ${groundingUnverified.join(", ")}`;
      lastEl.after(warn);
    }

    scrollToBottom();
    sending = false;
    copilotSend.disabled = false;
  };

  /* throttled typewriter -- drains fullText at a steady time-based pace regardless
     of how bursty the SSE deltas arrive. Time-based so a throttled/backgrounded tab
     catches up in chunks on its next tick instead of stalling mid-sentence. Reduced
     motion: no throttle, text lands as it comes. */
  let typeTimer = null;
  let lastTick = 0;
  const typeTick = () => {
    if (!assistantEl) return;
    const now = performance.now();
    if (REDUCED) shownChars = fullText.length;
    else shownChars = Math.min(fullText.length, shownChars + ((now - lastTick) / 1000) * CHARS_PER_SEC);
    lastTick = now;
    const drained = shownChars >= fullText.length;
    renderShown(!(drained && streamDone));
    scrollToBottom();
    if (drained) {
      clearInterval(typeTimer);
      typeTimer = null;
      if (streamDone) finalize();
    }
  };
  const kickType = () => {
    if (typeTimer == null) {
      lastTick = performance.now();
      typeTimer = setInterval(typeTick, TYPE_TICK_MS);
    }
  };
  skipActiveReveal = () => {
    shownChars = fullText.length;
    if (typeTimer != null) { clearInterval(typeTimer); typeTimer = null; }
    if (assistantEl) renderShown(!streamDone);
    if (streamDone) finalize();
  };

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory }),
    });
    if (!res.ok || !res.body) throw new Error(`Chat request failed: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = "message", dataStr = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
        }
        const data = dataStr ? JSON.parse(dataStr) : {};

        if (event === "tool_call") {
          sawAnyOutput = true;
          thinkingText.textContent = data.label;
          liveChips.push(addToolChip(data.label));
          if (fullText && !fullText.endsWith("\n\n")) fullText += "\n\n";
        } else if (event === "tool_result") {
          pendingEvidence.push({ tool: data.tool, result: data.result });
          thinkingText.textContent = "Writing the answer";
        } else if (event === "text_delta") {
          sawAnyOutput = true;
          if (!assistantEl) assistantEl = addMessage("assistant", "");
          fullText += data.text;
          kickType();
        } else if (event === "grounding") {
          groundingUnverified = data.unverified || null;
        } else if (event === "done") {
          streamDone = true;
          if (typeTimer == null && (!assistantEl || shownChars >= fullText.length)) finalize();
        } else if (event === "error") {
          finishThinking();
          addMessage("error", data.message || "Something went wrong.");
          finalized = true;
          sending = false;
          copilotSend.disabled = false;
        }
      }
    }

    if (!sawAnyOutput && !finalized) { finishThinking(); sending = false; copilotSend.disabled = false; }
  } catch (err) {
    finishThinking();
    addMessage("error", `Connection error: ${err.message}`);
    finalized = true;
    sending = false;
    copilotSend.disabled = false;
  }
}

/* click-to-skip: clicking the streaming message reveals the rest instantly --
   nobody should be hostage to the animation on a re-read */
copilotMessages.addEventListener("click", (e) => {
  const bubble = e.target.closest(".copilot-msg .copilot-bubble-text");
  if (bubble && bubble.querySelector(".copilot-caret") && skipActiveReveal) skipActiveReveal();
});

copilotSend.addEventListener("click", () => sendMessage());
copilotInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMessage(); });
copilotSuggest?.querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => sendMessage(b.dataset.q))
);
