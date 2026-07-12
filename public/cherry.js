const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const userId = localStorage.getItem('cherry-user-id') || 'pwa-user';
localStorage.setItem('cherry-user-id', userId);

const state = {
  conversations: [],
  currentConversationId: localStorage.getItem('cherry-conversation-id') || null,
  currentRunId: null,
  running: false,
  terminalEventSeen: false,
};

function toast(message, duration = 3600) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  $('#toastStack').append(node);
  setTimeout(() => node.remove(), duration);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function setRunning(running) {
  state.running = running;
  $('#sendButton').disabled = running;
  $('#messageInput').disabled = running;
  $('#runStrip').hidden = !running;
  $('#conversationMeta').textContent = running ? 'Cherry is working with tools...' : 'Ready';
}

function hideEmptyState() {
  $('#emptyState')?.remove();
}

function ensureEmptyState() {
  if ($('#emptyState')) return;
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.id = 'emptyState';
  empty.innerHTML = `
    <div class="cherry-orb">C</div>
    <h1>มีอะไรให้ Cherry จัดการวันนี้?</h1>
    <p>คุย วางแผน แก้ incident ตรวจ infra อ่านงาน หรือสั่งให้ Agent ลงมือทำพร้อมหลักฐานได้เลย</p>
    <div class="quick-prompts">
      <button data-prompt="เช็กงานที่ค้างและจัดลำดับสิ่งที่ควรทำวันนี้">จัดลำดับงานวันนี้</button>
      <button data-prompt="ดู Engineer Loop ที่กำลังทำงานหรือถูก block แล้วสรุปให้หน่อย">ดูงาน Agent ที่กำลังรัน</button>
      <button data-prompt="ตรวจระบบที่เชื่อมต่ออยู่ตอนนี้ แล้วบอกว่ามีอะไรผิดปกติหรือควรเฝ้าระวัง">ตรวจระบบที่เชื่อมต่อ</button>
    </div>`;
  $('#messages').append(empty);
  bindQuickPrompts();
}

function addMessage(content, role, meta = '') {
  hideEmptyState();
  const row = document.createElement('article');
  row.className = `message-row ${role}`;
  const card = document.createElement('div');
  card.className = 'message-card';
  card.textContent = content;
  if (meta) {
    const metaNode = document.createElement('div');
    metaNode.className = 'message-meta';
    metaNode.textContent = meta;
    card.append(metaNode);
  }
  row.append(card);
  $('#messages').append(row);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return row;
}

function createProgressCard() {
  hideEmptyState();
  const row = document.createElement('article');
  row.className = 'message-row assistant';
  const card = document.createElement('div');
  card.className = 'progress-card';
  const head = document.createElement('div');
  head.className = 'progress-head';
  head.innerHTML = '<span class="pulse"></span><span>Cherry is planning and working with tools</span>';
  const list = document.createElement('div');
  list.className = 'progress-list';
  card.append(head, list);
  row.append(card);
  $('#messages').append(row);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return { row, list, head };
}

function appendProgress(progress, payload) {
  const item = document.createElement('div');
  item.className = `progress-item ${payload.type || ''}`;
  const icon = document.createElement('span');
  icon.className = 'progress-icon';
  icon.textContent = payload.type === 'tool' ? '✓' : payload.type === 'error' ? '!' : payload.type === 'correctness' ? '◇' : '●';
  const copy = document.createElement('div');
  copy.className = 'progress-copy';
  const title = document.createElement('strong');
  title.textContent = payload.label || payload.name || 'Cherry is working';
  const sub = document.createElement('span');
  sub.textContent = payload.name ? `${payload.type} · ${payload.name}` : payload.type || 'agent';
  copy.append(title, sub);
  const step = document.createElement('span');
  step.className = 'progress-step';
  step.textContent = payload.step ? `step ${payload.step}` : '';
  item.append(icon, copy, step);
  progress.list.append(item);
  progress.list.scrollTop = progress.list.scrollHeight;
  $('#runStripText').textContent = payload.label || 'Cherry is working...';
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function replaceProgressWithMessage(progress, content, meta, isError = false) {
  const card = document.createElement('div');
  card.className = 'message-card';
  card.textContent = content;
  if (isError) card.style.borderColor = '#7f1d1d';
  if (meta) {
    const metaNode = document.createElement('div');
    metaNode.className = 'message-meta';
    metaNode.textContent = meta;
    card.append(metaNode);
  }
  progress.row.replaceChildren(card);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function renderConversations() {
  const container = $('#conversationList');
  container.replaceChildren();
  const query = $('#conversationSearch').value.trim().toLowerCase();
  const filtered = state.conversations.filter((item) => !query || item.title.toLowerCase().includes(query) || (item.lastMessage || '').toLowerCase().includes(query));
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'conversation-empty';
    empty.textContent = query ? 'No matching conversations' : 'No conversations yet';
    container.append(empty);
    return;
  }

  for (const conversation of filtered) {
    const button = document.createElement('button');
    button.className = `conversation-item${conversation.id === state.currentConversationId ? ' active' : ''}`;
    const title = document.createElement('strong');
    title.textContent = conversation.title;
    const meta = document.createElement('span');
    meta.textContent = `${conversation.messageCount} messages · ${formatDate(conversation.updatedAt)}`;
    button.append(title, meta);
    button.addEventListener('click', () => selectConversation(conversation.id));
    container.append(button);
  }
}

async function loadConversations() {
  const data = await api(`/conversations?userId=${encodeURIComponent(userId)}&limit=100`);
  state.conversations = data.conversations || [];
  renderConversations();
}

async function selectConversation(id) {
  if (state.running) {
    toast('Stop the current run before switching conversations.');
    return;
  }
  try {
    const data = await api(`/conversations/${encodeURIComponent(id)}`);
    state.currentConversationId = id;
    localStorage.setItem('cherry-conversation-id', id);
    $('#conversationTitle').textContent = data.conversation.title;
    $('#conversationMeta').textContent = `${data.conversation.messages.length} messages`;
    $('#messages').replaceChildren();
    for (const message of data.conversation.messages) {
      addMessage(message.content, message.role, message.steps ? `${message.steps} agent steps · ${formatDate(message.createdAt)}` : formatDate(message.createdAt));
    }
    if (!data.conversation.messages.length) ensureEmptyState();
    renderConversations();
    closeMobilePanels();
    $('#messageInput').focus();
  } catch (error) {
    state.currentConversationId = null;
    localStorage.removeItem('cherry-conversation-id');
    toast(error instanceof Error ? error.message : String(error));
  }
}

function newConversation() {
  if (state.running) {
    toast('Stop the current run before starting a new conversation.');
    return;
  }
  state.currentConversationId = null;
  localStorage.removeItem('cherry-conversation-id');
  $('#conversationTitle').textContent = 'New conversation';
  $('#conversationMeta').textContent = 'Ready';
  $('#messages').replaceChildren();
  ensureEmptyState();
  renderConversations();
  closeMobilePanels();
  $('#messageInput').focus();
}

async function consumeSse(response, onEvent) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  if (!response.body) throw new Error('Streaming response body is unavailable');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processBlock = (rawBlock) => {
    const block = rawBlock.replace(/\r/g, '');
    if (!block.trim()) return;
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const rawData = dataLines.join('\n');
    let payload;
    try { payload = JSON.parse(rawData); } catch { payload = { value: rawData }; }
    onEvent(event, payload);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      processBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) processBlock(buffer);
}

async function sendMessage(textOverride) {
  const input = $('#messageInput');
  const message = (textOverride ?? input.value).trim();
  if (!message || state.running) return;

  addMessage(message, 'user', 'now');
  input.value = '';
  resizeComposer();
  const progress = createProgressCard();
  setRunning(true);
  state.terminalEventSeen = false;

  try {
    const response = await fetch('/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        userId,
        ...(state.currentConversationId ? { conversationId: state.currentConversationId } : {}),
      }),
    });

    await consumeSse(response, (event, payload) => {
      if (event === 'started') {
        state.currentRunId = payload.runId;
        state.currentConversationId = payload.conversationId;
        localStorage.setItem('cherry-conversation-id', payload.conversationId);
        $('#conversationMeta').textContent = 'Running';
        $('#runStripText').textContent = 'Cherry started the agent run...';
      } else if (event === 'trace') {
        appendProgress(progress, payload);
      } else if (event === 'completed') {
        state.terminalEventSeen = true;
        const correctness = payload.correctness?.status ? ` · ${payload.correctness.status}` : '';
        replaceProgressWithMessage(progress, payload.answer, `${payload.steps} agent steps${correctness}`);
        $('#conversationMeta').textContent = 'Completed';
      } else if (event === 'cancelled') {
        state.terminalEventSeen = true;
        replaceProgressWithMessage(progress, 'Run cancelled.', 'Cancelled', true);
        $('#conversationMeta').textContent = 'Cancelled';
      } else if (event === 'error') {
        state.terminalEventSeen = true;
        replaceProgressWithMessage(progress, `Error: ${payload.error || 'Unknown error'}`, 'Failed', true);
        $('#conversationMeta').textContent = 'Failed';
      }
    });

    if (!state.terminalEventSeen) {
      replaceProgressWithMessage(progress, 'The stream ended before Cherry returned a completion event.', 'Incomplete', true);
    }
  } catch (error) {
    replaceProgressWithMessage(progress, `Error: ${error instanceof Error ? error.message : String(error)}`, 'Failed', true);
    toast('Cherry run failed.');
  } finally {
    state.currentRunId = null;
    setRunning(false);
    await Promise.allSettled([loadConversations(), loadAgentInbox()]);
    if (state.currentConversationId) {
      const current = state.conversations.find((item) => item.id === state.currentConversationId);
      if (current) $('#conversationTitle').textContent = current.title;
    }
    input.focus();
  }
}

async function stopRun() {
  if (!state.currentRunId) return;
  try {
    $('#runStripText').textContent = 'Cancelling run...';
    await api(`/runs/${encodeURIComponent(state.currentRunId)}/cancel`, { method: 'POST', body: '{}' });
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }
}

function inboxCard(title, detail, className = '') {
  const card = document.createElement('div');
  card.className = `inbox-card ${className}`.trim();
  const strong = document.createElement('strong');
  strong.textContent = title;
  const paragraph = document.createElement('p');
  paragraph.textContent = detail;
  card.append(strong, paragraph);
  return card;
}

function renderInboxSection(container, title, items, renderItem) {
  if (!items.length) return;
  const section = document.createElement('section');
  section.className = 'inbox-section';
  const heading = document.createElement('h3');
  heading.textContent = `${title} · ${items.length}`;
  section.append(heading);
  for (const item of items) section.append(renderItem(item));
  container.append(section);
}

async function runApproval(id, action) {
  try {
    await api(`/approvals/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
    toast(action === 'approve' ? 'Approved and executed.' : 'Denied.');
    await loadAgentInbox();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }
}

function renderAgentInbox(data) {
  const stats = data.stats || {};
  const statContainer = $('#inboxStats');
  statContainer.replaceChildren();
  for (const [label, value] of [['Live', stats.activeRuns || 0], ['Agent', (stats.runningEngineer || 0) + (stats.blockedEngineer || 0)], ['Approve', stats.approvals || 0]]) {
    const card = document.createElement('div');
    card.className = 'inbox-stat';
    const span = document.createElement('span');
    span.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    card.append(span, strong);
    statContainer.append(card);
  }

  const total = (stats.activeRuns || 0) + (stats.runningEngineer || 0) + (stats.blockedEngineer || 0) + (stats.approvals || 0);
  $('#inboxBadge').hidden = total === 0;
  $('#inboxBadge').textContent = String(total);

  const container = $('#inboxContent');
  container.replaceChildren();

  renderInboxSection(container, 'Live runs', data.activeRuns || [], (run) => inboxCard(`Conversation run ${run.runId.slice(0, 8)}`, `Started ${formatDate(run.startedAt)}`, 'running'));
  renderInboxSection(container, 'Engineer running', data.runningEngineer || [], (loop) => inboxCard(loop.objective, `Phase ${loop.phase} · iteration ${loop.iteration}/${loop.maxIterations}`, 'running'));
  renderInboxSection(container, 'Blocked', data.blockedEngineer || [], (loop) => inboxCard(loop.objective, `Phase ${loop.phase} · waiting for a blocker to clear`, 'blocked'));
  renderInboxSection(container, 'Approvals', data.approvals || [], (approval) => {
    const card = inboxCard(approval.tool, `${approval.risk} action waiting for approval`, 'approval');
    const actions = document.createElement('div');
    actions.className = 'inbox-actions';
    const deny = document.createElement('button');
    deny.className = 'deny';
    deny.textContent = 'Deny';
    deny.addEventListener('click', () => runApproval(approval.id, 'deny'));
    const approve = document.createElement('button');
    approve.className = 'approve';
    approve.textContent = 'Approve & run';
    approve.addEventListener('click', () => runApproval(approval.id, 'approve'));
    actions.append(deny, approve);
    card.append(actions);
    return card;
  });
  renderInboxSection(container, 'Doing', data.doing || [], (item) => inboxCard(item.title, `${item.priority} · ${item.dueAt ? `due ${formatDate(item.dueAt)}` : 'no due date'}`));
  renderInboxSection(container, 'Waiting', data.waiting || [], (item) => inboxCard(item.title, `${item.priority} · waiting`));

  if (!container.children.length) {
    const empty = document.createElement('div');
    empty.className = 'inbox-empty';
    empty.textContent = 'Nothing is running, blocked, waiting, or asking for approval.';
    container.append(empty);
  }
}

async function loadAgentInbox() {
  try {
    const data = await api('/agent-inbox');
    renderAgentInbox(data);
  } catch {
    $('#inboxBadge').hidden = false;
    $('#inboxBadge').textContent = '!';
  }
}

async function checkHealth() {
  try {
    const data = await api('/health');
    $('#statusDot').classList.add('online');
    $('#runtimeStatus').textContent = `${data.model} · ${data.tools} tools`;
  } catch (error) {
    $('#statusDot').classList.remove('online');
    $('#runtimeStatus').textContent = error instanceof Error ? error.message : 'Offline';
  }
}

function resizeComposer() {
  const input = $('#messageInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function bindQuickPrompts() {
  $$('[data-prompt]').forEach((button) => {
    button.addEventListener('click', () => sendMessage(button.dataset.prompt));
  });
}

function closeMobilePanels() {
  $('#conversationSidebar').classList.remove('open');
  $('#inboxPanel').classList.remove('open');
  $('#mobileScrim').classList.remove('show');
}

function openPanel(panel) {
  closeMobilePanels();
  panel.classList.add('open');
  if (window.innerWidth <= 1180) $('#mobileScrim').classList.add('show');
}

$('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  void sendMessage();
});
$('#messageInput').addEventListener('input', resizeComposer);
$('#messageInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#newChatButton').addEventListener('click', newConversation);
$('#conversationSearch').addEventListener('input', renderConversations);
$('#stopRunButton').addEventListener('click', () => void stopRun());
$('#openConversationsButton').addEventListener('click', () => openPanel($('#conversationSidebar')));
$('#openInboxButton').addEventListener('click', () => { openPanel($('#inboxPanel')); void loadAgentInbox(); });
$('#closeInboxButton').addEventListener('click', closeMobilePanels);
$('#mobileScrim').addEventListener('click', closeMobilePanels);

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $('#installButton').hidden = false;
});
$('#installButton').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('#installButton').hidden = true;
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.error);

bindQuickPrompts();
resizeComposer();
await Promise.allSettled([loadConversations(), loadAgentInbox(), checkHealth()]);
if (state.currentConversationId) await selectConversation(state.currentConversationId);
else ensureEmptyState();
setInterval(loadAgentInbox, 5000);
setInterval(loadConversations, 12000);
setInterval(checkHealth, 30000);
