const chat = document.querySelector('#chat');
const composer = document.querySelector('#composer');
const messageInput = document.querySelector('#message');
const sendButton = document.querySelector('#sendButton');
const statusText = document.querySelector('#statusText');
const statusDot = document.querySelector('#statusDot');
const toolCount = document.querySelector('#toolCount');
const installButton = document.querySelector('#installButton');

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

async function checkHealth() {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Health check failed');
    statusText.textContent = `${data.model} · ${data.tools} tools`;
    toolCount.textContent = `${data.tools} tools ready`;
    statusDot.style.background = '#22c55e';
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
    toolCount.textContent = 'Offline';
    statusDot.style.background = '#ef4444';
  }
}

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
