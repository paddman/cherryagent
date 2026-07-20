const backendUrl = "http://127.0.0.1:8787";
const sessionId = crypto.randomUUID();

const backendStatus = document.getElementById("backendStatus");
const bridgeStatus = document.getElementById("bridgeStatus");
const approvalCount = document.getElementById("approvalCount");
const configPath = document.getElementById("configPath");
const approvalsEl = document.getElementById("approvals");
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const authTokenKey = "cherry-auth-token";
let authRedirected = false;

function addMessage(role, text, meta = "") {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  article.appendChild(bubble);
  if (meta) {
    const small = document.createElement("small");
    small.textContent = meta;
    article.appendChild(small);
  }
  messagesEl.appendChild(article);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function fetchJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("content-type", "application/json");
  const token = sessionStorage.getItem(authTokenKey);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && !authRedirected) {
    authRedirected = true;
    sessionStorage.removeItem(authTokenKey);
    window.location.href = "./index.html";
  }
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body;
}

async function loadRuntimeInfo() {
  try {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) throw new Error("Tauri API unavailable");
    const info = await invoke("get_desktop_runtime_info");
    configPath.textContent = info.configFile;
    configPath.title = info.configFile;
  } catch (error) {
    configPath.textContent = "Unavailable";
    configPath.title = String(error);
  }
}

async function refreshStatus() {
  try {
    const health = await fetchJson(`${backendUrl}/health`);
    backendStatus.textContent = `Online · ${health.tools} tools`;
    backendStatus.className = "ok";
  } catch (error) {
    backendStatus.textContent = "Offline";
    backendStatus.className = "bad";
  }

  try {
    const result = await sendChat("ใช้ desktop_get_status ตรวจสถานะ local desktop bridge เท่านั้น ตอบสั้นมาก", false);
    bridgeStatus.textContent = result.ok ? "Online" : "Needs attention";
    bridgeStatus.className = result.ok ? "ok" : "bad";
  } catch {
    bridgeStatus.textContent = "Offline / waiting for backend";
    bridgeStatus.className = "bad";
  }
}

async function sendChat(message, showMessages = true) {
  if (showMessages) addMessage("user", message);
  const result = await fetchJson(`${backendUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, sessionId }),
  });
  if (showMessages) {
    const meta = result.correctness
      ? `${result.correctness.status} · confidence ${result.correctness.confidence}% · ${result.steps} steps`
      : `${result.steps || 0} steps`;
    addMessage("assistant", result.answer || "Done.", meta);
  }
  await refreshApprovals();
  return result;
}

async function refreshApprovals() {
  try {
    const body = await fetchJson(`${backendUrl}/approvals`);
    const approvals = body.approvals || [];
    approvalCount.textContent = String(approvals.length);
    approvalsEl.innerHTML = "";
    if (approvals.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "ไม่มี action ที่รออนุมัติ";
      approvalsEl.appendChild(empty);
      return;
    }

    for (const item of approvals) {
      const card = document.createElement("article");
      card.className = "approval-card";
      const title = document.createElement("strong");
      title.textContent = item.tool;
      const risk = document.createElement("span");
      risk.className = `risk risk-${item.risk}`;
      risk.textContent = item.risk;
      const args = document.createElement("pre");
      args.textContent = JSON.stringify(item.args, null, 2);
      const actions = document.createElement("div");
      actions.className = "approval-actions";

      const approve = document.createElement("button");
      approve.textContent = "อนุมัติและรัน";
      approve.addEventListener("click", () => resolveApproval(item.id, "approve"));
      const deny = document.createElement("button");
      deny.className = "ghost danger";
      deny.textContent = "ปฏิเสธ";
      deny.addEventListener("click", () => resolveApproval(item.id, "deny"));
      actions.append(approve, deny);
      card.append(title, risk, args, actions);
      approvalsEl.appendChild(card);
    }
  } catch {
    approvalCount.textContent = "?";
  }
}

async function resolveApproval(id, action) {
  try {
    const result = await fetchJson(`${backendUrl}/approvals/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    addMessage("assistant", action === "approve"
      ? `รัน action ที่อนุมัติแล้ว: ${result.result?.tool || result.approval?.tool || id}`
      : `ปฏิเสธ action แล้ว: ${result.approval?.tool || id}`);
  } catch (error) {
    addMessage("assistant", `Approval action failed: ${error.message}`);
  }
  await refreshApprovals();
}

document.getElementById("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = inputEl.value.trim();
  if (!message) return;
  inputEl.value = "";
  sendBtn.disabled = true;
  sendBtn.textContent = "กำลังทำงาน...";
  try {
    await sendChat(message);
  } catch (error) {
    addMessage("assistant", `เกิดข้อผิดพลาด: ${error.message}`);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "ส่งงาน";
  }
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", async () => {
    inputEl.value = button.dataset.prompt || "";
    inputEl.focus();
  });
});

document.getElementById("refreshApprovals").addEventListener("click", refreshApprovals);

document.getElementById("quitBtn").addEventListener("click", async () => {
  try {
    await window.__TAURI__?.core?.invoke("quit_app");
  } catch {
    window.close();
  }
});

loadRuntimeInfo();
refreshStatus();
refreshApprovals();
setInterval(refreshApprovals, 5000);
setInterval(refreshStatus, 15000);
