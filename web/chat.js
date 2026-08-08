/* Portfolio copilot: docked chat panel, streams from POST /chat via hand-rolled SSE
   parsing (EventSource can't send a POST body, so this reads the fetch stream and
   splits on SSE's blank-line event boundaries itself). History is kept in memory for
   the session only -- no persistence, no local storage. */

const copilotBubble = document.getElementById("copilotBubble");
const copilotPanel = document.getElementById("copilotPanel");
const copilotClose = document.getElementById("copilotClose");
const copilotMessages = document.getElementById("copilotMessages");
const copilotInput = document.getElementById("copilotInput");
const copilotSend = document.getElementById("copilotSend");

let chatHistory = [];
let sending = false;

function openCopilot() {
  copilotPanel.classList.add("open");
  copilotPanel.setAttribute("aria-hidden", "false");
  copilotInput.focus();
}
function closeCopilot() {
  copilotPanel.classList.remove("open");
  copilotPanel.setAttribute("aria-hidden", "true");
}
copilotBubble.addEventListener("click", openCopilot);
copilotClose.addEventListener("click", closeCopilot);

function scrollToBottom() {
  copilotMessages.scrollTop = copilotMessages.scrollHeight;
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

/* escape first, THEN allow only **bold** through -- the model's own text is untrusted
   input, this never opens up arbitrary HTML injection */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function formatAssistantText(s) {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/* ── data cards: built straight from the raw tool_result payload (real API JSON,
   never seen by the model at this fidelity) -- tables and bar charts, not the model
   re-typing numbers into prose. Every renderer is defensive: a shape it doesn't
   recognize just skips the card rather than throwing. ── */
function makeCard(innerHtml) {
  const card = document.createElement("div");
  card.className = "copilot-card";
  card.innerHTML = innerHtml;
  copilotMessages.appendChild(card);
  scrollToBottom();
}

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
      <div class="copilot-bar-track"><div class="copilot-bar-fill" style="width:${Math.max(4, (Math.abs(i.value) / max) * 100)}%"></div></div>
      <div class="copilot-bar-val mono">${i.fmtValue}</div>
    </div>
  `).join("") + `</div>`;
}

function tableHtml(columns, rows, cap = 8) {
  const shown = rows.slice(0, cap);
  const more = rows.length - shown.length;
  return `<div class="copilot-table-wrap"><table class="copilot-table">
    <thead><tr>${columns.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>
    <tbody>${shown.map((r) => `<tr>${columns.map((c) => `<td>${c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? "&mdash;")}</td>`).join("")}</tr>`).join("")}</tbody>
  </table>${more > 0 ? `<div class="copilot-table-more">+ ${more} more &mdash; ask a narrower question to see them</div>` : ""}</div>`;
}

function renderToolResult(name, result) {
  try {
    switch (name) {
      case "portfolio_revenue": {
        const kpi = kpiRowHtml([
          ["Gross", fmtMoney(result.total_gross_revenue)],
          ["Concessions", fmtMoneySigned(result.total_concessions)],
          ["Net effective", fmtMoney(result.total_net_effective_revenue)],
        ]);
        const top = [...result.by_property].sort((a, b) => b.net_effective_revenue - a.net_effective_revenue).slice(0, 8);
        const bars = barListHtml(top.map((p) => ({ label: p.canonical_name, value: p.net_effective_revenue, fmtValue: fmtMoney(p.net_effective_revenue) })));
        makeCard(kpi + bars);
        return;
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
        makeCard(kpi + bars);
        return;
      }
      case "revenue_concentration": {
        if (!result.length) return;
        makeCard(barListHtml(result.map((r) => ({ label: r.program_type, value: r.amount, fmtValue: fmtMoney(r.amount) }))));
        return;
      }
      case "occupancy_portfolio": {
        const kpi = kpiRowHtml([
          ["Units", result.total_units],
          ["Occupied", result.total_occupied],
          ["% Occ", result.pct_occ != null ? result.pct_occ.toFixed(1) + "%" : "&mdash;"],
        ]);
        const top = [...result.by_property].sort((a, b) => (b.pct_occ || 0) - (a.pct_occ || 0)).slice(0, 8);
        const bars = barListHtml(top.map((p) => ({ label: p.canonical_name, value: p.pct_occ || 0, fmtValue: (p.pct_occ ?? 0).toFixed(1) + "%" })));
        makeCard(kpi + bars);
        return;
      }
      case "occupancy_property": {
        makeCard(kpiRowHtml([
          ["Units", result.total_units],
          ["Occupied", result.occupied],
          ["Vacant", result.vacant],
          ["Notice", result.on_notice],
          ["% Occ", result.pct_occ != null ? result.pct_occ.toFixed(1) + "%" : "&mdash;"],
        ]));
        return;
      }
      case "delinquent_tenancies": {
        if (!result.length) { makeCard(`<div class="copilot-empty">No outstanding balances.</div>`); return; }
        makeCard(tableHtml(
          [{ key: "resident_name", label: "Resident" }, { key: "canonical_name", label: "Property" }, { key: "unit_number", label: "Unit" }, { key: "balance", label: "Balance", fmt: fmtMoney }],
          [...result].sort((a, b) => b.balance - a.balance)
        ));
        return;
      }
      case "leases_expiring": {
        if (!result.leases.length) { makeCard(`<div class="copilot-empty">Nothing expiring in this window.</div>`); return; }
        makeCard(tableHtml(
          [{ key: "resident_name", label: "Resident" }, { key: "canonical_name", label: "Property" }, { key: "unit_number", label: "Unit" }, { key: "lease_expiration", label: "Expires" }, { key: "market_rent", label: "Rent", fmt: (v) => v ? fmtMoney(v) : "&mdash;" }],
          result.leases
        ));
        return;
      }
      case "leases_holdover": {
        if (!result.holdovers.length) { makeCard(`<div class="copilot-empty">No holdover leases.</div>`); return; }
        makeCard(kpiRowHtml([["Holdovers", result.holdover_count], ["As of", result.reference_date]]) + tableHtml(
          [{ key: "resident_name", label: "Resident" }, { key: "canonical_name", label: "Property" }, { key: "unit_number", label: "Unit" }, { key: "lease_expiration", label: "Expired" }, { key: "market_rent", label: "Rent", fmt: (v) => v ? fmtMoney(v) : "&mdash;" }],
          result.holdovers
        ));
        return;
      }
      case "anomalies": {
        if (!result.length) { makeCard(`<div class="copilot-empty">No data quality flags.</div>`); return; }
        makeCard(tableHtml(
          [{ key: "property_id", label: "Prop" }, { key: "flag_type", label: "Type" }, { key: "detail", label: "Detail" }],
          result, 6
        ));
        return;
      }
      case "property_units": {
        if (!result.length) return;
        makeCard(tableHtml(
          [{ key: "unit_number", label: "Unit" }, { key: "status", label: "Status" }, { key: "resident_name", label: "Resident", fmt: (v) => v || "&mdash;" }, { key: "market_rent", label: "Rent", fmt: (v) => v ? fmtMoney(v) : "&mdash;" }, { key: "balance", label: "Bal", fmt: (v) => v ? fmtMoney(v) : "&mdash;" }],
          result
        ));
        return;
      }
      case "unit_lookup":
        // same payload shape as unit_detail when exactly one unit matched; the rare
        // multiple-match shape has no single tenancy to card, so skip the card and let
        // the model's text explain the choices
        if (result.multiple_matches) return;
        // fall through
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
        makeCard(kpi + charges);
        return;
      }
      case "list_properties": {
        makeCard(tableHtml([{ key: "property_id", label: "Code" }, { key: "canonical_name", label: "Property" }], result, 20));
        return;
      }
      case "portfolio_stats": {
        makeCard(kpiRowHtml([
          ["Properties", result.properties],
          ["Tenancies", result.tenancies],
          ["Charges", result.charges],
          ["Flags", result.data_quality_flags],
        ]));
        return;
      }
      default:
        return;
    }
  } catch (err) {
    console.error("renderToolResult failed for", name, err);
  }
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
}

async function sendMessage() {
  const text = copilotInput.value.trim();
  if (!text || sending) return;

  sending = true;
  copilotSend.disabled = true;
  copilotInput.value = "";
  addMessage("user", text);
  chatHistory.push({ role: "user", content: text });

  const thinkingRow = addThinkingRow();
  const thinkingText = thinkingRow.querySelector(".copilot-thinking-text");

  let assistantEl = null;
  let assistantText = "";
  let sawAnyOutput = false;

  const finishThinking = () => {
    if (thinkingRow.isConnected) thinkingRow.remove();
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
          addToolChip(data.label);
          // if the model narrated before this tool call despite the prompt telling it
          // not to, make sure the post-tool text starts a fresh paragraph instead of
          // gluing onto the preamble mid-sentence
          if (assistantText && !assistantText.endsWith("\n\n")) {
            assistantText += "\n\n";
          }
        } else if (event === "tool_result") {
          renderToolResult(data.tool, data.result);
          thinkingText.textContent = "Writing the answer";
        } else if (event === "text_delta") {
          sawAnyOutput = true;
          if (!assistantEl) {
            finishThinking();
            assistantEl = addMessage("assistant", "");
          }
          assistantText += data.text;
          assistantEl.innerHTML = formatAssistantText(assistantText);
          scrollToBottom();
        } else if (event === "grounding") {
          // server checked every $/% figure the model just stated against the real
          // tool data it was given this turn -- anything that didn't trace back shows
          // up here. Not blocking, not hidden either: flagged, same as a data quality
          // issue in the dashboard itself.
          if (data.unverified?.length && assistantEl) {
            const warn = document.createElement("div");
            warn.className = "copilot-grounding-warn";
            warn.textContent = `Could not verify against tool data: ${data.unverified.join(", ")}`;
            assistantEl.closest(".copilot-msg").after(warn);
            scrollToBottom();
          }
        } else if (event === "done") {
          if (assistantText) chatHistory.push({ role: "assistant", content: assistantText });
        } else if (event === "error") {
          finishThinking();
          addMessage("error", data.message || "Something went wrong.");
        }
      }
    }

    if (!sawAnyOutput) finishThinking();
  } catch (err) {
    finishThinking();
    addMessage("error", `Connection error: ${err.message}`);
  } finally {
    sending = false;
    copilotSend.disabled = false;
  }
}

copilotSend.addEventListener("click", sendMessage);
copilotInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});
