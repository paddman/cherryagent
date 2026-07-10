const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const sessionId = localStorage.getItem('cherry-session-id') || crypto.randomUUID();
localStorage.setItem('cherry-session-id', sessionId);

const state = {
  dashboard: null,
  approvals: [],
  currentView: 'dashboard',
  draggedItemId: null,
  seenAlertIds: new Set(JSON.parse(localStorage.getItem('cherry-seen-alerts') || '[]')),
};

const viewTitles = {
  dashboard: 'Office Dashboard',
  flow: 'Flow Planner',
  reminders: 'Reminder Center',
  chat: 'Ask Cherry',
};

const flowColumns = [
  ['inbox', 'Inbox'],
  ['planned', 'Planned'],
  ['doing', 'Doing'],
  ['waiting', 'Waiting'],
  ['done', 'Done'],
];

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
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function formatDateTime(value) {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatTime(value) {
  if (!value) return '--:--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeText(value) {
  return String(value ?? '');
}

function isOverdue(item) {
  return item.status !== 'done' && item.dueAt && new Date(item.dueAt).getTime() < Date.now();
}

function switchView(name) {
  if (!viewTitles[name]) return;
  state.currentView = name;
  $$('.view').forEach((view) => view.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $('#viewTitle').textContent = viewTitles[name];
  if (name === 'chat') $('#message').focus();
}

$$('.nav-button').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$$('[data-switch]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.switch)));

async function checkHealth() {
  try {
    const data = await api('/health');
    $('#statusText').textContent = `${data.model} · ${data.tools} tools`;
    $('#connectorStatus').textContent = `Google Workspace: ${data.connectors?.google ? 'connected' : 'not configured'}`;
    $('#schedulerStatus').textContent = `Scheduler: ${data.planner?.schedulerRunning ? 'running' : 'stopped'} · ${Math.round((data.planner?.schedulerIntervalMs || 0) / 1000)}s`;
    $('#statusDot').style.background = '#22c55e';
  } catch (error) {
    $('#statusText').textContent = error instanceof Error ? error.message : String(error);
    $('#schedulerStatus').textContent = 'Scheduler: unavailable';
    $('#statusDot').style.background = '#ef4444';
  }
}

function renderStats(dashboard) {
  const stats = dashboard.stats || {};
  $('#statToday').textContent = String(stats.today || 0);
  $('#statOverdue').textContent = String(stats.overdue || 0);
  $('#statDoing').textContent = String(stats.doing || 0);
  $('#statWaiting').textContent = String(stats.waiting || 0);
  $('#statReminders').textContent = String(stats.activeReminders || 0);
  $('#statAlerts').textContent = String(stats.unreadAlerts || 0);
  $('#alertNavCount').textContent = String(stats.unreadAlerts || 0);
  const activeFlow = ['inbox', 'planned', 'doing', 'waiting'].reduce((sum, status) => sum + (dashboard.flow?.[status]?.length || 0), 0);
  $('#flowCount').textContent = String(activeFlow);
}

function renderTimeline(items) {
  const container = $('#todayTimeline');
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No work scheduled for today yet.';
    container.append(empty);
    return;
  }

  for (const item of items) {
    const node = document.createElement('article');
    node.className = 'timeline-item';
    const row = document.createElement('div');
    row.className = 'timeline-row';
    const time = document.createElement('span');
    time.className = 'timeline-time';
    time.textContent = formatTime(item.startAt || item.dueAt);
    const content = document.createElement('div');
    content.style.flex = '1';
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = item.title;
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `${item.status} · ${item.priority}${item.dueAt ? ` · due ${formatDateTime(item.dueAt)}` : ''}`;
    content.append(title, meta);
    const pill = document.createElement('span');
    pill.className = `pill ${item.priority}`;
    pill.textContent = item.priority;
    row.append(time, content, pill);
    node.append(row);
    container.append(node);
  }
}

function renderFlow(dashboard) {
  const board = $('#flowBoard');
  board.replaceChildren();

  for (const [status, label] of flowColumns) {
    const column = document.createElement('section');
    column.className = 'column';
    column.dataset.status = status;

    const items = dashboard.flow?.[status] || [];
    const head = document.createElement('div');
    head.className = 'column-head';
    head.innerHTML = `<span>${label}</span><span class="column-count">${items.length}</span>`;
    const list = document.createElement('div');
    list.className = 'flow-list';

    for (const item of items) {
      const card = document.createElement('article');
      card.className = `flow-card${isOverdue(item) ? ' overdue' : ''}`;
      card.draggable = true;
      card.dataset.itemId = item.id;
      card.addEventListener('dragstart', () => { state.draggedItemId = item.id; });
      card.addEventListener('dragend', () => { state.draggedItemId = null; });

      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = item.title;
      const meta = document.createElement('div');
      meta.className = 'item-meta';
      const schedule = item.dueAt ? `Due ${formatDateTime(item.dueAt)}` : item.startAt ? `Starts ${formatDateTime(item.startAt)}` : 'No date';
      meta.textContent = `${schedule}${item.dependsOn?.length ? ` · ${item.dependsOn.length} dependencies` : ''}`;
      const tags = document.createElement('div');
      tags.className = 'flow-tags';
      const priority = document.createElement('span');
      priority.className = `pill ${item.priority}`;
      priority.textContent = item.priority;
      tags.append(priority);
      for (const tag of item.tags || []) {
        const tagNode = document.createElement('span');
        tagNode.className = 'pill';
        tagNode.textContent = tag;
        tags.append(tagNode);
      }
      card.append(title, meta, tags);
      list.append(card);
    }

    column.addEventListener('dragover', (event) => {
      event.preventDefault();
      column.classList.add('dragover');
    });
    column.addEventListener('dragleave', () => column.classList.remove('dragover'));
    column.addEventListener('drop', async (event) => {
      event.preventDefault();
      column.classList.remove('dragover');
      if (!state.draggedItemId) return;
      try {
        await api(`/planner/items/${encodeURIComponent(state.draggedItemId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        });
        toast(`Moved to ${label}`);
        await loadPlanner();
      } catch (error) {
        toast(`Move failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    column.append(head, list);
    board.append(column);
  }
}

function scheduleLabel(schedule) {
  if (!schedule) return 'Unknown schedule';
  switch (schedule.kind) {
    case 'once': return `Once · ${formatDateTime(schedule.at)}`;
    case 'interval': return `Every ${schedule.everyMinutes} minute(s)`;
    case 'daily': return `Daily · ${schedule.time}`;
    case 'weekdays': return `Weekdays · ${schedule.time}`;
    case 'weekly': return `Weekly [${(schedule.weekdays || []).join(',')}] · ${schedule.time}`;
    case 'monthly': return `Monthly day ${schedule.day} · ${schedule.time}`;
    case 'cron': return `Cron · ${schedule.expression}`;
    default: return schedule.kind;
  }
}

function renderReminders(reminders) {
  const container = $('#reminderList');
  container.replaceChildren();
  if (!reminders.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No reminder schedules yet.';
    container.append(empty);
    return;
  }

  for (const reminder of reminders) {
    const card = document.createElement('article');
    card.className = 'reminder-card';
    const content = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = reminder.title;
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `${scheduleLabel(reminder.schedule)} · ${(reminder.channels || []).join(', ')}`;
    const next = document.createElement('div');
    next.className = 'reminder-next';
    next.textContent = reminder.nextRunAt ? `Next: ${formatDateTime(reminder.nextRunAt)}` : 'No next run';
    content.append(title, meta, next);

    const toggle = document.createElement('button');
    toggle.className = `toggle ${reminder.enabled ? 'on' : ''}`;
    toggle.textContent = reminder.enabled ? 'Enabled' : 'Disabled';
    toggle.addEventListener('click', async () => {
      try {
        await api(`/planner/reminders/${encodeURIComponent(reminder.id)}/enabled`, {
          method: 'POST',
          body: JSON.stringify({ enabled: !reminder.enabled }),
        });
        await loadPlanner();
      } catch (error) {
        toast(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    card.append(content, toggle);
    container.append(card);
  }
}

async function browserNotify(alert) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!Array.isArray(alert.channels) || !alert.channels.includes('browser')) return;
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration?.showNotification) {
      await registration.showNotification(alert.title, { body: alert.message, tag: `cherry-${alert.id}`, data: { alertId: alert.id } });
    } else {
      new Notification(alert.title, { body: alert.message, tag: `cherry-${alert.id}` });
    }
  } catch {
    // Browser notification is best-effort; the in-app alert remains durable.
  }
}

function renderAlerts(alerts) {
  const container = $('#alertList');
  container.replaceChildren();
  if (!alerts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No alerts yet.';
    container.append(empty);
    return;
  }

  for (const alert of alerts) {
    const card = document.createElement('article');
    card.className = `alert-card ${alert.readAt ? '' : 'unread'}`;
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = alert.title;
    const message = document.createElement('div');
    message.className = 'item-meta';
    message.textContent = alert.message;
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `${formatDateTime(alert.createdAt)} · ${(alert.channels || []).join(', ')}`;
    const actions = document.createElement('div');
    actions.className = 'alert-actions';

    const actionButton = (label, action) => {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', action);
      actions.append(button);
    };

    if (!alert.readAt) actionButton('Mark read', async () => {
      await api(`/planner/alerts/${encodeURIComponent(alert.id)}/read`, { method: 'POST', body: '{}' });
      await loadPlanner();
    });
    for (const [label, minutes] of [['Snooze 10m', 10], ['1 hour', 60], ['Tomorrow', 1440]]) {
      actionButton(label, async () => {
        await api(`/planner/alerts/${encodeURIComponent(alert.id)}/snooze`, { method: 'POST', body: JSON.stringify({ minutes }) });
        toast(`${alert.title} snoozed: ${label}`);
        await loadPlanner();
      });
    }

    card.append(title, message, meta, actions);
    container.append(card);
  }
}

async function surfaceNewAlerts(alerts) {
  let changed = false;
  for (const alert of alerts) {
    if (state.seenAlertIds.has(alert.id)) continue;
    state.seenAlertIds.add(alert.id);
    changed = true;
    toast(`${alert.title}: ${alert.message}`, 6000);
    await browserNotify(alert);
  }
  if (changed) {
    const ids = [...state.seenAlertIds].slice(-500);
    state.seenAlertIds = new Set(ids);
    localStorage.setItem('cherry-seen-alerts', JSON.stringify(ids));
  }
}

async function loadPlanner() {
  try {
    const data = await api('/planner/dashboard');
    state.dashboard = data.dashboard;
    renderStats(data.dashboard);
    renderTimeline(data.dashboard.today || []);
    renderFlow(data.dashboard);
    renderReminders(data.dashboard.reminders || []);
    renderAlerts(data.dashboard.alerts || []);
    await surfaceNewAlerts(data.dashboard.alerts || []);
  } catch (error) {
    toast(`Planner unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function toIso(localValue) {
  if (!localValue) return undefined;
  const date = new Date(localValue);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function createPlanFromForm(title, priority, dueValue) {
  const body = { title, priority, status: 'planned', timezone: 'Asia/Bangkok' };
  const dueAt = toIso(dueValue);
  if (dueAt) body.dueAt = dueAt;
  return api('/planner/items', { method: 'POST', body: JSON.stringify(body) });
}

$('#quickPlanForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await createPlanFromForm($('#quickTitle').value.trim(), $('#quickPriority').value, $('#quickDue').value);
    $('#quickTitle').value = '';
    $('#quickDue').value = '';
    toast('Added to plan');
    await loadPlanner();
  } catch (error) {
    toast(`Could not add plan: ${error instanceof Error ? error.message : String(error)}`);
  }
});

$('#flowAddForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await createPlanFromForm($('#flowTitle').value.trim(), $('#flowPriority').value, $('#flowDue').value);
    $('#flowTitle').value = '';
    $('#flowDue').value = '';
    toast('Flow item created');
    await loadPlanner();
  } catch (error) {
    toast(`Could not create flow item: ${error instanceof Error ? error.message : String(error)}`);
  }
});

function updateScheduleFields() {
  const kind = $('#scheduleKind').value;
  $$('.schedule-option').forEach((node) => {
    const kinds = (node.dataset.kind || '').split(/\s+/);
    node.classList.toggle('visible', kinds.includes(kind));
  });
}

$('#scheduleKind').addEventListener('change', updateScheduleFields);
updateScheduleFields();

function buildSchedule() {
  const kind = $('#scheduleKind').value;
  const timezone = $('#scheduleTimezone').value.trim() || 'Asia/Bangkok';
  if (kind === 'once') {
    const at = toIso($('#scheduleOnceAt').value);
    if (!at) throw new Error('Choose a valid date and time');
    return { kind, at };
  }
  if (kind === 'interval') return { kind, everyMinutes: Number($('#scheduleInterval').value) };
  if (kind === 'daily' || kind === 'weekdays') return { kind, time: $('#scheduleTime').value, timezone };
  if (kind === 'weekly') {
    const weekdays = $$('#weeklyDays input:checked').map((input) => Number(input.value));
    return { kind, weekdays, time: $('#scheduleTime').value, timezone };
  }
  if (kind === 'monthly') return { kind, day: Number($('#scheduleMonthDay').value), time: $('#scheduleTime').value, timezone };
  if (kind === 'cron') return { kind, expression: $('#scheduleCron').value.trim(), timezone };
  throw new Error(`Unknown schedule kind: ${kind}`);
}

$('#reminderForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const channels = $$('.channel:checked').map((input) => input.value);
    const body = {
      title: $('#reminderTitle').value.trim(),
      message: $('#reminderMessage').value.trim(),
      schedule: buildSchedule(),
      channels,
    };
    await api('/planner/reminders', { method: 'POST', body: JSON.stringify(body) });
    $('#reminderTitle').value = '';
    $('#reminderMessage').value = '';
    toast('Reminder schedule created');
    await loadPlanner();
  } catch (error) {
    toast(`Could not create reminder: ${error instanceof Error ? error.message : String(error)}`);
  }
});

$('#runSchedulerButton').addEventListener('click', async () => {
  try {
    const data = await api('/planner/scheduler/tick', { method: 'POST', body: '{}' });
    toast(`Scheduler checked · ${data.tick?.fired?.length || 0} reminder(s) fired`);
    await loadPlanner();
  } catch (error) {
    toast(`Scheduler failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});

function updateNotificationButton() {
  const supported = 'Notification' in window;
  const permission = supported ? Notification.permission : 'unsupported';
  $('#notifyState').textContent = permission === 'granted' ? 'On' : permission === 'denied' ? 'Blocked' : 'Off';
  $('#notifyButton').classList.toggle('enabled', permission === 'granted');
  $('#notifyButton').disabled = !supported;
}

$('#notifyButton').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  try {
    const permission = await Notification.requestPermission();
    updateNotificationButton();
    toast(permission === 'granted' ? 'Browser alerts enabled' : `Browser alerts: ${permission}`);
  } catch (error) {
    toast(`Notification permission failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});
updateNotificationButton();

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
  $('#chat').append(node);
  $('#chat').scrollTop = $('#chat').scrollHeight;
  return node;
}

$('#composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#message').value.trim();
  if (!message || $('#sendButton').disabled) return;

  addMessage(message, 'user');
  $('#message').value = '';
  $('#sendButton').disabled = true;
  const pending = addMessage('Cherry is planning and working with tools...', 'assistant');
  try {
    const data = await api('/chat', {
      method: 'POST',
      body: JSON.stringify({ message, sessionId, userId: 'pwa-user' }),
    });
    pending.textContent = data.answer;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${data.steps} agent step${data.steps === 1 ? '' : 's'}`;
    pending.append(meta);
  } catch (error) {
    pending.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    $('#sendButton').disabled = false;
    await Promise.all([loadPlanner(), loadApprovals(), checkHealth()]);
  }
});

$('#message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
});

function friendlyArgs(args) {
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

function renderApprovals(approvals) {
  state.approvals = approvals;
  $('#approvalList').replaceChildren();
  $('#approvalCount').textContent = String(approvals.length);
  $('#approvalCount').style.display = approvals.length ? 'inline-grid' : 'none';
  if (!approvals.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No actions are waiting for approval.';
    $('#approvalList').append(empty);
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
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const deny = document.createElement('button');
    deny.className = 'deny'; deny.textContent = 'Deny';
    const approve = document.createElement('button');
    approve.className = 'approve'; approve.textContent = 'Approve & run';

    const runAction = async (action) => {
      approve.disabled = true; deny.disabled = true;
      try {
        const data = await api(`/approvals/${encodeURIComponent(approval.id)}/${action}`, { method: 'POST', body: '{}' });
        if (action === 'approve') toast(data.result?.ok ? `Executed: ${approval.tool}` : `Execution failed: ${approval.tool}`);
      } catch (error) {
        toast(`Approval failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await Promise.all([loadApprovals(), loadPlanner(), checkHealth()]);
      }
    };
    approve.addEventListener('click', () => runAction('approve'));
    deny.addEventListener('click', () => runAction('deny'));
    actions.append(deny, approve);
    card.append(title, args, actions);
    $('#approvalList').append(card);
  }
}

async function loadApprovals() {
  try {
    const data = await api('/approvals');
    renderApprovals(Array.isArray(data.approvals) ? data.approvals : []);
  } catch {
    $('#approvalCount').textContent = '!';
    $('#approvalCount').style.display = 'inline-grid';
  }
}

$('#approvalButton').addEventListener('click', () => { $('#approvalDrawer').classList.add('open'); loadApprovals(); });
$('#approvalClose').addEventListener('click', () => $('#approvalDrawer').classList.remove('open'));

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $('#installButton').style.display = 'block';
});
$('#installButton').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('#installButton').style.display = 'none';
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.error);

$('#todayDate').textContent = new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

await Promise.all([checkHealth(), loadPlanner(), loadApprovals()]);
setInterval(loadPlanner, 5000);
setInterval(loadApprovals, 5000);
setInterval(checkHealth, 30000);
