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
  row.querySelector(".copilot-bubble-text").textContent = text;
  copilotMessages.appendChild(row);
  scrollToBottom();
  return row.querySelector(".copilot-bubble-text");
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
        } else if (event === "text_delta") {
          sawAnyOutput = true;
          if (!assistantEl) {
            finishThinking();
            assistantEl = addMessage("assistant", "");
          }
          assistantText += data.text;
          assistantEl.textContent = assistantText;
          scrollToBottom();
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
