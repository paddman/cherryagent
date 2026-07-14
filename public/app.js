const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const sessionId = localStorage.getItem('cherry-session-id') || crypto.randomUUID();
localStorage.setItem('cherry-session-id', sessionId);

const state = {
  dashboard: null,
  engineerDashboard: null,
  approvals: [],
  currentView: 'dashboard',
  draggedItemId: null,
  seenAlertIds: new Set(JSON.parse(localStorage.getItem('cherry-seen-alerts') || '[]')),
};

const viewTitles = {
  dashboard: 'Office Dashboard',
  flow: 'Flow Planner',
  reminders: 'Reminder Center',
  engineer: 'Engineer Loop Engine',
  chat: 'Ask Cherry',
  voice: 'Voice Assistant',
};

const flowColumns = [
  ['inbox', 'Inbox'],
  ['planned', 'Planned'],
  ['doing', 'Doing'],
  ['waiting', 'Waiting'],
  ['done', 'Done'],
];

const engineerPhases = ['plan', 'execute', 'observe', 'diagnose', 'patch', 'test', 'verify', 'learn'];

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

function isOverdue(item) {
  return item.status !== 'done' && item.dueAt && new Date(item.dueAt).getTime() < Date.now();
}

function switchView(name) {
  if (!viewTitles[name]) return;
  state.currentView = name;
  $$('.view').forEach((view) => view.classList.remove('active'));
  $(`#view-${name}`)?.classList.add('active');
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $('#viewTitle').textContent = viewTitles[name];
  if (name === 'chat') $('#message').focus();
  if (name === 'voice') $('#voiceText').focus();
  if (name === 'engineer') void loadEngineer();
}

$$('.nav-button').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$$('[data-switch]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.switch)));

async function checkHealth() {
  try {
    const data = await api('/health');
    $('#statusText').textContent = `${data.model} · ${data.tools} tools`;
    $('#connectorStatus').textContent = `LLM: ${data.model} · Voice: ${data.connectors?.voice ? 'TTS on' : 'TTS off'} · STT: ${data.connectors?.stt ? 'on' : 'off'}`;
    $('#schedulerStatus').textContent = `Scheduler: ${data.planner?.schedulerRunning ? 'running' : 'stopped'} · ${Math.round((data.planner?.schedulerIntervalMs || 0) / 1000)}s`;
    const activeEngineer = (data.engineer?.running || 0) + (data.engineer?.blocked || 0);
    $('#engineerStatus').textContent = `Engineer Loop: ${data.engineer?.running || 0} running · ${data.engineer?.blocked || 0} blocked`;
    $('#engineerNavCount').textContent = String(activeEngineer);
    $('#statusDot').style.background = '#22c55e';
  } catch (error) {
    $('#statusText').textContent = error instanceof Error ? error.message : String(error);
    $('#schedulerStatus').textContent = 'Scheduler: unavailable';
    $('#engineerStatus').textContent = 'Engineer Loop: unavailable';
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
    const headLabel = document.createElement('span');
    headLabel.textContent = label;
    const count = document.createElement('span');
    count.className = 'column-count';
    count.textContent = String(items.length);
    head.append(headLabel, count);
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
    // Best effort. Durable in-app alert remains available.
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

function renderEngineerStats(dashboard) {
  const stats = dashboard.stats || {};
  $('#engineerStatRunning').textContent = String(stats.running || 0);
  $('#engineerStatBlocked').textContent = String(stats.blocked || 0);
  $('#engineerStatSucceeded').textContent = String(stats.succeeded || 0);
  $('#engineerStatFailed').textContent = String(stats.failed || 0);
  $('#engineerStatRunbooks').textContent = String(stats.runbooks || 0);
  $('#engineerNavCount').textContent = String((stats.running || 0) + (stats.blocked || 0));
}

function renderEngineerPhases(loop) {
  const track = document.createElement('div');
  track.className = 'engineer-phase-track';
  const activeIndex = engineerPhases.indexOf(loop.phase);
  for (const [index, phase] of engineerPhases.entries()) {
    const node = document.createElement('div');
    node.className = 'engineer-phase';
    if (index < activeIndex || loop.status === 'succeeded') node.classList.add('done');
    if (index === activeIndex && loop.status !== 'succeeded') node.classList.add('active');
    node.textContent = phase;
    track.append(node);
  }
  return track;
}

function renderEngineerLoops(loops) {
  const container = $('#engineerLoopList');
  container.replaceChildren();
  if (!loops.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No engineering loops yet. Start one here or ask Cherry to solve a technical task.';
    container.append(empty);
    return;
  }

  for (const loop of loops) {
    const card = document.createElement('article');
    card.className = `engineer-loop-card ${loop.status}`;
    const head = document.createElement('div');
    head.className = 'engineer-loop-head';
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = loop.objective;
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `Iteration ${loop.iteration}/${loop.maxIterations} · phase ${loop.phase} · updated ${formatDateTime(loop.updatedAt)}`;
    left.append(title, meta);
    const status = document.createElement('span');
    status.className = `engineer-status ${loop.status}`;
    status.textContent = loop.status;
    head.append(left, status);

    const criteria = document.createElement('div');
    criteria.className = 'engineer-evidence';
    criteria.textContent = `Success criteria:\n${(loop.successCriteria || []).map((item) => `• ${item}`).join('\n')}`;

    const latest = (loop.events || []).at(-1);
    const evidence = document.createElement('div');
    evidence.className = 'engineer-evidence';
    if (latest) {
      const lines = [`Latest ${latest.phase}: ${latest.summary}`];
      if (latest.evidence?.length) lines.push(...latest.evidence.map((item) => `• ${item}`));
      if (latest.error) lines.push(`Error: ${latest.error}`);
      evidence.textContent = lines.join('\n');
    } else {
      evidence.textContent = 'Waiting for the plan phase to be recorded.';
    }

    card.append(head, renderEngineerPhases(loop), criteria, evidence);
    container.append(card);
  }
}

function renderEngineerRunbooks(runbooks) {
  const container = $('#engineerRunbookList');
  container.replaceChildren();
  if (!runbooks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No learned runbooks yet. Verified successful loops will create them automatically.';
    container.append(empty);
    return;
  }

  for (const runbook of runbooks) {
    const card = document.createElement('article');
    card.className = 'runbook-card';
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = runbook.title;
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = formatDateTime(runbook.createdAt);
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Root cause · fix · verify · rollback · prevention';
    const body = document.createElement('div');
    body.className = 'runbook-body';
    const sections = [
      ['Root cause', [runbook.rootCause]],
      ['Fix', [runbook.fix]],
      ['Verification', runbook.verification || []],
      ['Rollback', runbook.rollback || []],
      ['Prevention', runbook.prevention || []],
    ];
    body.textContent = sections.map(([name, values]) => `${name}:\n${values.length ? values.map((value) => `• ${value}`).join('\n') : '• Not recorded'}`).join('\n\n');
    details.append(summary, body);
    card.append(title, meta, details);
    container.append(card);
  }
}

async function loadEngineer() {
  try {
    const data = await api('/engineer/dashboard');
    state.engineerDashboard = data.dashboard;
    renderEngineerStats(data.dashboard);
    renderEngineerLoops(data.dashboard.recent || []);
    renderEngineerRunbooks(data.dashboard.runbooks || []);
  } catch (error) {
    toast(`Engineer Loop unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

$('#engineerLoopForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const successCriteria = $('#engineerCriteria').value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const body = {
      objective: $('#engineerObjective').value.trim(),
      successCriteria,
      maxIterations: Number($('#engineerMaxIterations').value || 5),
      hypothesis: $('#engineerHypothesis').value.trim(),
    };
    const data = await api('/engineer/loops', { method: 'POST', body: JSON.stringify(body) });
    $('#engineerObjective').value = '';
    $('#engineerCriteria').value = '';
    $('#engineerHypothesis').value = '';
    toast(`Engineer Loop started · ${data.loop.id.slice(0, 8)}`);
    await loadEngineer();
  } catch (error) {
    toast(`Could not start Engineer Loop: ${error instanceof Error ? error.message : String(error)}`);
  }
});

$('#refreshEngineerButton').addEventListener('click', () => void loadEngineer());

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
    await Promise.all([loadPlanner(), loadEngineer(), loadApprovals(), checkHealth()]);
  }
});

$('#message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
});

const voiceState = {
  mediaRecorder: null,
  chunks: [],
  busy: false,
};

function appendVoiceLog(label, text) {
  const entry = document.createElement('div');
  entry.className = 'voice-entry';
  const title = document.createElement('strong');
  title.textContent = label;
  const body = document.createElement('div');
  body.textContent = text;
  entry.append(title, body);
  $('#voiceLog').prepend(entry);
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function audioBufferToWav(audioBuffer) {
  const channel = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const bytesPerSample = 2;
  const dataSize = channel.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < channel.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, channel[i] ?? 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

async function convertBlobToWav(blob, targetSampleRate = 24000) {
  if (blob.type.includes('wav')) return blob;
  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * targetSampleRate));
    const offline = new OfflineAudioContext(1, frames, targetSampleRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    return new Blob([audioBufferToWav(rendered)], { type: 'audio/wav' });
  } finally {
    await audioContext.close();
  }
}

async function sendVoiceRequest(payload) {
  if (voiceState.busy) return;
  voiceState.busy = true;
  $('#voiceStatus').textContent = 'กำลังประมวลผล...';
  try {
    const response = await fetch('/voice/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, sessionId, userId: 'voice-user', speak: true }),
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || `Voice chat failed (${response.status})`);
    if (data.transcript) appendVoiceLog('คุณ', data.transcript);
    appendVoiceLog('Cherry', data.answer || '(empty answer)');
    if (data.audioBase64) {
      const player = $('#voicePlayer');
      player.style.display = 'block';
      player.src = `data:audio/${data.audioFormat || 'wav'};base64,${data.audioBase64}`;
      await player.play().catch(() => {});
    }
    $('#voiceStatus').textContent = `เสร็จแล้ว · ${data.steps || 0} ขั้นตอน`;
  } catch (error) {
    $('#voiceStatus').textContent = error instanceof Error ? error.message : String(error);
    toast($('#voiceStatus').textContent);
  } finally {
    voiceState.busy = false;
  }
}

async function sendVoiceAudio(blob) {
  const wavBlob = await convertBlobToWav(blob);
  await sendVoiceRequest({ audioBase64: await blobToBase64(wavBlob) });
}

async function sendVoiceText(text) {
  const message = text.trim();
  if (!message) return;
  appendVoiceLog('คุณ', message);
  await sendVoiceRequest({ text: message });
}

async function startVoiceRecording() {
  if (voiceState.busy || voiceState.mediaRecorder) return;
  if (!window.isSecureContext) {
    $('#voiceStatus').textContent = 'ต้องเปิดผ่าน HTTPS ถึงจะใช้ไมค์ได้';
    toast($('#voiceStatus').textContent);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('เบราว์เซอร์ไม่รองรับไมค์');
    return;
  }

  $('#voiceStatus').textContent = 'กำลังตรวจหาไมโครโฟน...';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((device) => device.kind === 'audioinput');
    if (mics.length === 0) {
      $('#voiceStatus').textContent = 'ไม่พบไมโครโฟนบนเครื่องนี้ — ใช้ช่องพิมพ์ด้านล่าง แล้วกด 🔊 ได้เลย';
      toast('ไม่พบไมโครโฟน — พิมพ์แล้วกด 🔊 ได้');
      $('#voiceText').focus();
      return;
    }

    $('#voiceStatus').textContent = 'กำลังเปิดไมโครโฟน...';
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    voiceState.chunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    voiceState.mediaRecorder = recorder;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) voiceState.chunks.push(event.data);
    });
    recorder.addEventListener('stop', async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(voiceState.chunks, { type: recorder.mimeType || 'audio/webm' });
      voiceState.mediaRecorder = null;
      voiceState.chunks = [];
      $('#voiceMicButton').classList.remove('recording');
      $('#voiceMicButton').textContent = '🎤 ใช้ไมโครโฟน';
      $('#voiceMicButton').disabled = false;
      if (!blob.size) {
        $('#voiceStatus').textContent = 'ไม่ได้ยินเสียง — ลองพูดให้นานขึ้นแล้วกดส่งอีกครั้ง';
        return;
      }
      try {
        await sendVoiceAudio(blob);
      } catch (error) {
        $('#voiceStatus').textContent = error instanceof Error ? error.message : String(error);
        toast($('#voiceStatus').textContent);
      }
    }, { once: true });
    recorder.start(250);
    $('#voiceMicButton').classList.add('recording');
    $('#voiceMicButton').textContent = '⏹ กดอีกครั้งเพื่อส่ง';
    $('#voiceStatus').textContent = 'กำลังฟัง... พูดเสร็จแล้วกดปุ่มอีกครั้ง';
  } catch (error) {
    voiceState.mediaRecorder = null;
    $('#voiceMicButton').classList.remove('recording');
    $('#voiceMicButton').textContent = '🎤 ใช้ไมโครโฟน';
    const name = error instanceof DOMException ? error.name : '';
    const detail = error instanceof Error ? error.message : String(error);
    let message = `เปิดไมค์ไม่ได้: ${detail}`;
    if (name === 'NotFoundError' || /Requested device not found/i.test(detail)) {
      message = 'ไม่พบไมโครโฟนบนเครื่องนี้ — เสียบไมค์/หูฟัง หรือใช้ช่องพิมพ์ด้านล่างแล้วกด 🔊';
      $('#voiceText').focus();
    } else if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      message = 'เบราว์เซอร์บล็อกไมค์ — กดไอคอนไมค์/ล็อกในแถบที่อยู่เว็บ แล้วเลือก Allow';
    } else if (name === 'NotReadableError') {
      message = 'ไมค์ถูกโปรแกรมอื่นใช้อยู่ — ปิด Zoom/Teams/Discord แล้วลองใหม่ หรือพิมพ์แล้วกด 🔊';
    }
    $('#voiceStatus').textContent = message;
    toast(message);
  }
}

function stopVoiceRecording() {
  const recorder = voiceState.mediaRecorder;
  if (!recorder || recorder.state === 'inactive') return;
  $('#voiceStatus').textContent = 'กำลังส่งเสียง...';
  $('#voiceMicButton').disabled = true;
  recorder.stop();
}

function toggleVoiceRecording() {
  if (voiceState.busy) return;
  if (voiceState.mediaRecorder && voiceState.mediaRecorder.state !== 'inactive') {
    stopVoiceRecording();
    return;
  }
  void startVoiceRecording();
}

const voiceMicButton = $('#voiceMicButton');
voiceMicButton.addEventListener('click', (event) => {
  event.preventDefault();
  toggleVoiceRecording();
});

$('#voiceTextForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('#voiceText').value;
  $('#voiceText').value = '';
  await sendVoiceText(text);
});

if (location.hash === '#voice') switchView('voice');

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
    deny.className = 'deny';
    deny.textContent = 'Deny';
    const approve = document.createElement('button');
    approve.className = 'approve';
    approve.textContent = 'Approve & run';

    const runAction = async (action) => {
      approve.disabled = true;
      deny.disabled = true;
      try {
        const data = await api(`/approvals/${encodeURIComponent(approval.id)}/${action}`, { method: 'POST', body: '{}' });
        if (action === 'approve') toast(data.result?.ok ? `Executed: ${approval.tool}` : `Execution failed: ${approval.tool}`);
      } catch (error) {
        toast(`Approval failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await Promise.all([loadApprovals(), loadPlanner(), loadEngineer(), checkHealth()]);
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

$('#approvalButton').addEventListener('click', () => { $('#approvalDrawer').classList.add('open'); void loadApprovals(); });
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

await Promise.all([checkHealth(), loadPlanner(), loadEngineer(), loadApprovals()]);
setInterval(loadPlanner, 5000);
setInterval(loadEngineer, 5000);
setInterval(loadApprovals, 5000);
setInterval(checkHealth, 30000);
