const chat = document.querySelector('#chat');
const composer = document.querySelector('#composer');
const messageInput = document.querySelector('#message');
const sendButton = document.querySelector('#sendButton');
const statusText = document.querySelector('#statusText');
const statusDot = document.querySelector('#statusDot');
const connectorStatus = document.querySelector('#connectorStatus');
const toolCount = document.querySelector('#toolCount');
const installButton = document.querySelector('#installButton');
const approvalButton = document.querySelector('#approvalButton');
const approvalCount = document.querySelector('#approvalCount');
const approvalDrawer = document.querySelector('#approvalDrawer');
const approvalClose = document.querySelector('#approvalClose');
const approvalList = document.querySelector('#approvalList');

const sessionId = localStorage.getItem('cherry-session-id') || crypto.randomUUID();
localStorage.setItem('cherry-session-id', sessionId);

function addMessage(text, role, meta = '') {
  const node = document.createElement('div');
  node.className = `message ${role}`;
  node.textContent = text;
  if (meta) {
    const metaNode = document.createElement('div');
    metaNode.className = 'meta';
    metaNode.textContent = meta;
    node.append(metaNode);
  }
  chat.append(node);
  chat.scrollTop = chat.scrollHeight;
  return node;
}

function friendlyArgs(args) {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

async function checkHealth() {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Health check failed');
    statusText.textContent = `${data.model} · ${data.tools} tools`;
    toolCount.textContent = `${data.tools} tools ready`;
    connectorStatus.textContent = `Google Workspace: ${data.connectors?.google ? 'connected' : 'not configured'}`;
    statusDot.style.background = '#22c55e';
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
    toolCount.textContent = 'Offline';
    connectorStatus.textContent = 'Google Workspace: unavailable';
    statusDot.style.background = '#ef4444';
  }
}

function renderApprovals(approvals) {
  approvalList.replaceChildren();
  approvalCount.textContent = String(approvals.length);
  approvalCount.style.display = approvals.length ? 'inline-grid' : 'none';

  if (!approvals.length) {
    const empty = document.createElement('div');
    empty.className = 'approval-empty';
    empty.textContent = 'No actions are waiting for approval.';
    approvalList.append(empty);
    return;
  }

  for (const approval of approvals) {
    const card = document.createElement('article');
    card.className = 'approval-card';

    const title = document.createElement('div');
    title.className = 'approval-title';
    const name = document.createElement('strong');
    name.textContent = approval.tool;
    const risk = document.createElement('span');
    risk.className = `risk ${approval.risk}`;
    risk.textContent = approval.risk;
    title.append(name, risk);

    const args = document.createElement('pre');
    args.className = 'approval-args';
    args.textContent = friendlyArgs(approval.args);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = new Date(approval.createdAt).toLocaleString();

    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const deny = document.createElement('button');
    deny.className = 'deny';
    deny.textContent = 'Deny';
    const approve = document.createElement('button');
    approve.className = 'approve';
    approve.textContent = 'Approve & run';

    const runAction = async (action) => {
      approve.disabled = true;
      deny.disabled = true;
      const originalText = action === 'approve' ? approve.textContent : deny.textContent;
      if (action === 'approve') approve.textContent = 'Running...';
      else deny.textContent = 'Denying...';

      try {
        const response = await fetch(`/approvals/${encodeURIComponent(approval.id)}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || `Approval ${action} failed`);

        if (action === 'approve') {
          const resultText = data.result?.ok
            ? `Approved and executed: ${approval.tool}`
            : `Approved but execution failed: ${approval.tool}`;
          addMessage(resultText, 'assistant', data.result?.ok ? 'Verified tool execution' : 'Execution error');
        }
      } catch (error) {
        addMessage(`Approval error: ${error instanceof Error ? error.message : String(error)}`, 'assistant');
        approve.disabled = false;
        deny.disabled = false;
        if (action === 'approve') approve.textContent = originalText;
        else deny.textContent = originalText;
      } finally {
        await Promise.all([loadApprovals(), checkHealth()]);
      }
    };

    approve.addEventListener('click', () => runAction('approve'));
    deny.addEventListener('click', () => runAction('deny'));
    actions.append(deny, approve);

    card.append(title, args, meta, actions);
    approvalList.append(card);
  }
}

async function loadApprovals() {
  try {
    const response = await fetch('/approvals', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load approvals');
    renderApprovals(Array.isArray(data.approvals) ? data.approvals : []);
  } catch {
    approvalCount.textContent = '!';
    approvalCount.style.display = 'inline-grid';
  }
}

approvalButton.addEventListener('click', () => {
  approvalDrawer.classList.add('open');
  loadApprovals();
});

approvalClose.addEventListener('click', () => {
  approvalDrawer.classList.remove('open');
});

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message || sendButton.disabled) return;

  addMessage(message, 'user');
  messageInput.value = '';
  sendButton.disabled = true;
  const pending = addMessage('Cherry is working with tools...', 'assistant');

  try {
    const response = await fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, sessionId, userId: 'pwa-user' }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Agent request failed');
    pending.textContent = data.answer;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${data.steps} agent step${data.steps === 1 ? '' : 's'}`;
    pending.append(meta);
  } catch (error) {
    pending.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    sendButton.disabled = false;
    messageInput.focus();
    chat.scrollTop = chat.scrollHeight;
    await Promise.all([loadApprovals(), checkHealth()]);
  }
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.style.display = 'block';
});

installButton.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installButton.style.display = 'none';
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.error);
}

checkHealth();
loadApprovals();
setInterval(loadApprovals, 5000);
