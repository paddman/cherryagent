const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const chatIdStorageKey = 'cherry-chat-id';
let chatId = localStorage.getItem(chatIdStorageKey) || crypto.randomUUID();
localStorage.setItem(chatIdStorageKey, chatId);
const authTokenKey = 'cherry-auth-token';
let authToken = sessionStorage.getItem(authTokenKey) || '';
let appStarted = false;

const state = {
  dashboard: null,
  workspace: null,
  usage: null,
  connectors: null,
  officeInbox: [],
  reports: [],
  activeReport: null,
  reportStreamAbort: null,
  reportStreamId: null,
  reportPollTimer: null,
  engineerDashboard: null,
  approvals: [],
  deployRuns: [],
  deployRun: null,
  deployHandoffs: [],
  deployEvidence: [],
  deployLogs: [],
  deployActivity: [],
  deploySelectedTaskId: null,
  deployStreamAbort: null,
  deployPollTimer: null,
  deployRefreshTimer: null,
  deployTransform: { x: 0, y: 0, scale: 1 },
  currentView: 'dashboard',
  draggedItemId: null,
  seenAlertIds: new Set(JSON.parse(localStorage.getItem('cherry-seen-alerts') || '[]')),
};

const viewTitles = {
  dashboard: 'ภาพรวมวันนี้',
  reports: 'Cherry Report Studio',
  flow: 'บอร์ดงานของฉัน',
  office: 'Office Inbox · Inbox-to-Execution',
  deploy: 'Deploy Flow · Agent Topology',
  reminders: 'เตือนความจำ',
  engineer: 'ช่างแก้ปัญหา Engineer Loop',
  chat: 'คุยกับ Cherry',
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
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (authToken) headers.set('authorization', `Bearer ${authToken}`);
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers,
  });
  const raw = await response.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = { error: raw }; }
  }
  if (response.status === 401 && path !== '/auth/me') {
    authToken = '';
    sessionStorage.removeItem(authTokenKey);
    showAuthOverlay('Session หมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
  }
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function showAuthOverlay(message = '') {
  const overlay = $('#authOverlay');
  if (!overlay) return;
  overlay.hidden = false;
  $('#authError').textContent = message;
  $('#authEmail').focus();
}

function hideAuthOverlay() {
  const overlay = $('#authOverlay');
  if (overlay) overlay.hidden = true;
  $('#authError').textContent = '';
}

async function checkAuthentication() {
  const headers = new Headers();
  if (authToken) headers.set('authorization', `Bearer ${authToken}`);
  try {
    const response = await fetch('/auth/me', { cache: 'no-store', headers });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Authentication required');
    hideAuthOverlay();
    return true;
  } catch {
    showAuthOverlay();
    return false;
  }
}

$('#authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('#authSubmit');
  submit.disabled = true;
  $('#authError').textContent = '';
  try {
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: $('#authEmail').value.trim(), password: $('#authPassword').value }),
    });
    const data = await response.json();
    if (!response.ok || data.ok === false || !data.token) throw new Error(data.error || 'เข้าสู่ระบบไม่สำเร็จ');
    authToken = data.token;
    sessionStorage.setItem(authTokenKey, authToken);
    hideAuthOverlay();
    await startApp();
  } catch (error) {
    showAuthOverlay(error instanceof Error ? error.message : 'เข้าสู่ระบบไม่สำเร็จ');
  } finally {
    submit.disabled = false;
  }
});

$('#logoutButton').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST', body: '{}' }); } catch { /* session may already be invalid */ }
  authToken = '';
  sessionStorage.removeItem(authTokenKey);
  showAuthOverlay('ออกจากระบบแล้ว');
});

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
  if (name === 'engineer') void loadEngineer();
  if (name === 'deploy') void loadDeployRuns();
  if (name === 'office') void loadOfficeInbox();
  if (name === 'reports') void loadReports();
}

$$('.nav-button').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$$('[data-switch]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.switch)));
$$('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
  switchView('chat');
  $('#message').value = button.dataset.prompt || '';
  $('#message').focus();
}));

async function checkHealth() {
  try {
    const data = await api('/health');
    state.connectors = data.connectors || {};
    $('#statusText').textContent = `${data.model} · ${data.tools} tools`;
    $('#connectorStatus').textContent = `Google Workspace: ${data.connectors?.google ? 'connected' : 'not configured'}`;
    $('#schedulerStatus').textContent = `Scheduler: ${data.planner?.schedulerRunning ? 'running' : 'stopped'} · ${Math.round((data.planner?.schedulerIntervalMs || 0) / 1000)}s`;
    const activeEngineer = (data.engineer?.running || 0) + (data.engineer?.blocked || 0);
    $('#engineerStatus').textContent = `Engineer Loop: ${data.engineer?.running || 0} running · ${data.engineer?.blocked || 0} blocked`;
    updateOfficeConnectorState();
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

function renderUsage(usage) {
  state.usage = usage;
  const percent = Math.min(100, Math.max(0, Number(usage.percent || 0)));
  $('#officeUsageValue').textContent = `${usage.used || 0} / ${usage.budget || 0}`;
  $('#officeUsageBar').style.width = `${percent}%`;
  $('#officeUsageBar').classList.toggle('warning', percent >= 70 && percent < 90);
  $('#officeUsageBar').classList.toggle('danger', percent >= 90);
  $('#officeUsageStatus').textContent = percent >= 90 ? 'ใกล้เต็ม' : percent >= 70 ? 'เฝ้าระวัง' : 'อยู่ในงบ';
  $('#officeUsageMeta').textContent = `${usage.remaining || 0} credits คงเหลือ · ${usage.events || 0} events · รอบ ${usage.period || '--'}`;
  const breakdown = $('#officeUsageBreakdown');
  breakdown.replaceChildren();
  const labels = [['report_run', 'Report Studio'], ['office_inbox', 'Office Inbox'], ['workflow_run', 'Workflow runs'], ['tool_call', 'Tool calls']];
  for (const [key, label] of labels) {
    const row = document.createElement('div');
    row.className = 'usage-row';
    const name = document.createElement('span');
    name.textContent = label;
    const value = document.createElement('strong');
    value.textContent = String(usage.byKind?.[key] || 0);
    row.append(name, value);
    breakdown.append(row);
  }
}

const reportPhases = [
  ['ingest', 'รับไฟล์'],
  ['profile', 'ตรวจข้อมูล'],
  ['analyze', 'วิเคราะห์'],
  ['visualize', 'สร้างกราฟ'],
  ['pdf', 'สร้าง PDF'],
  ['verify', 'ตรวจผล'],
];

function updateOfficeConnectorState() {
  const connected = state.connectors?.google === true;
  const button = $('#officeSyncButton');
  if (button) {
    button.disabled = !connected;
    button.title = connected ? '' : 'ยังไม่ได้เชื่อม Google Workspace';
  }
  const note = $('#officeSourceNote');
  if (note && !connected) note.textContent = 'ยังไม่เชื่อม Google Workspace · ใช้ Report Studio ได้ทันทีโดยไม่ต้องตั้งค่า connector';
}

function reportStatusText(status) {
  return {
    queued: 'รอเริ่ม', running: 'กำลังทำ', succeeded: 'สำเร็จ', degraded: 'สำเร็จแบบสำรอง', failed: 'ล้มเหลว',
  }[status] || status || 'unknown';
}

function reportPhaseIndex(report) {
  if (report.status === 'succeeded' || report.status === 'degraded') return reportPhases.length;
  return Math.max(0, reportPhases.findIndex(([key]) => key === report.phase));
}

function renderReportProgress(report) {
  const card = $('#reportProgressCard');
  const active = ['queued', 'running'].includes(report.status);
  card.hidden = !(active || report.status === 'failed');
  if (card.hidden) return;
  $('#reportStatus').className = `report-status ${report.status}`;
  $('#reportStatus').textContent = reportStatusText(report.status);
  $('#reportProgressTitle').textContent = report.status === 'failed' ? 'สร้างรายงานไม่สำเร็จ' : `${report.title} · ${report.phase}`;
  $('#reportProgressMeta').textContent = report.error || report.warning || `${report.fileName} · ${report.rowCount || 0} rows · อัปเดต ${formatDateTime(report.updatedAt)}`;
  $('#reportProgressPercent').textContent = `${Math.round(report.progress || 0)}%`;
  $('#reportProgressBar').style.width = `${Math.max(0, Math.min(100, report.progress || 0))}%`;
  const pipeline = $('#reportPipeline');
  pipeline.replaceChildren();
  const activeIndex = reportPhaseIndex(report);
  reportPhases.forEach(([key, label], index) => {
    const node = document.createElement('div');
    const isDone = index < activeIndex || ['succeeded', 'degraded'].includes(report.status);
    const isActive = key === report.phase && report.status === 'running';
    node.className = `report-pipeline-step${isDone ? ' done' : ''}${isActive ? ' active' : ''}${report.status === 'failed' && key === report.phase ? ' failed' : ''}`;
    const icon = document.createElement('i');
    icon.textContent = isDone ? '✓' : String(index + 1);
    const text = document.createElement('span');
    text.textContent = label;
    node.append(icon, text);
    pipeline.append(node);
  });
}

function renderReportList() {
  $('#reportNavCount').textContent = String(state.reports.length);
  const container = $('#reportList');
  container.replaceChildren();
  if (!state.reports.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'ยังไม่มีรายงาน ลอง sample ด้านบนได้ทันที';
    container.append(empty);
    return;
  }
  for (const report of state.reports) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `report-list-item ${report.status}${state.activeReport?.id === report.id ? ' active' : ''}`;
    const top = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = report.title;
    const status = document.createElement('span');
    status.className = `report-status ${report.status}`;
    status.textContent = reportStatusText(report.status);
    top.append(title, status);
    const meta = document.createElement('small');
    meta.textContent = `${report.fileName} · ${formatDateTime(report.updatedAt)}`;
    button.append(top, meta);
    button.addEventListener('click', () => void loadReport(report.id));
    container.append(button);
  }
}

function svgElement(name, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function renderReportChart(chart) {
  const card = document.createElement('article');
  card.className = 'card report-chart-card';
  const heading = document.createElement('div');
  heading.className = 'report-chart-head';
  const title = document.createElement('h3');
  title.textContent = chart.title;
  const badge = document.createElement('span');
  badge.textContent = chart.type;
  heading.append(title, badge);
  const svg = svgElement('svg', { viewBox: '0 0 640 270', role: 'img', 'aria-label': chart.title });
  svg.classList.add('report-chart-svg');
  const labels = (chart.labels || []).slice(0, 10);
  const values = (chart.series?.[0]?.values || []).slice(0, 10).map(Number);
  const palette = ['#0b6cff', '#65aaff', '#2eb67d', '#f2ad45', '#805ad5', '#e45465', '#32b9c6', '#7b8fae', '#4c7dff', '#49a276'];

  if (chart.type === 'donut') {
    const total = values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
    const radius = 76;
    const circumference = Math.PI * 2 * radius;
    svg.append(svgElement('circle', { cx: 160, cy: 132, r: radius, fill: 'none', stroke: '#e8eef7', 'stroke-width': 30 }));
    let offset = 0;
    values.forEach((value, index) => {
      const length = Math.max(0, value) / total * circumference;
      const circle = svgElement('circle', { cx: 160, cy: 132, r: radius, fill: 'none', stroke: palette[index % palette.length], 'stroke-width': 30, 'stroke-dasharray': `${length} ${circumference - length}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 160 132)' });
      svg.append(circle);
      offset += length;
      const legend = svgElement('text', { x: 295, y: 42 + index * 24, fill: '#587094', 'font-size': 13 });
      legend.textContent = `${labels[index] || '-'} · ${new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value)}`;
      svg.append(legend);
    });
    const totalText = svgElement('text', { x: 160, y: 139, fill: '#10213f', 'font-size': 20, 'font-weight': 800, 'text-anchor': 'middle' });
    totalText.textContent = new Intl.NumberFormat('th-TH', { notation: 'compact', maximumFractionDigits: 1 }).format(total);
    svg.append(totalText);
  } else if (chart.type === 'line') {
    const width = 540;
    const height = 180;
    const left = 55;
    const top = 28;
    const minimum = Math.min(...values, 0);
    const maximum = Math.max(...values, 1);
    const range = maximum - minimum || 1;
    const points = values.map((value, index) => {
      const x = left + (index / Math.max(1, values.length - 1)) * width;
      const y = top + height - ((value - minimum) / range) * height;
      return [x, y];
    });
    [0, 1, 2, 3].forEach((index) => svg.append(svgElement('line', { x1: left, y1: top + index * 60, x2: left + width, y2: top + index * 60, stroke: '#e6edf7', 'stroke-width': 1 })));
    svg.append(svgElement('polyline', { points: points.map((point) => point.join(',')).join(' '), fill: 'none', stroke: '#0b6cff', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    points.forEach(([x, y], index) => {
      svg.append(svgElement('circle', { cx: x, cy: y, r: 5, fill: '#fff', stroke: '#0b6cff', 'stroke-width': 3 }));
      if (index % Math.max(1, Math.ceil(points.length / 5)) === 0 || index === points.length - 1) {
        const label = svgElement('text', { x, y: 242, fill: '#7589a6', 'font-size': 11, 'text-anchor': 'middle' });
        label.textContent = labels[index] || '';
        svg.append(label);
      }
    });
  } else {
    const maximum = Math.max(1, ...values.map((value) => Math.abs(value)));
    const slot = 540 / Math.max(1, values.length);
    values.forEach((value, index) => {
      const barHeight = Math.max(2, Math.abs(value) / maximum * 170);
      svg.append(svgElement('rect', { x: 55 + index * slot + slot * 0.14, y: 205 - barHeight, width: slot * 0.7, height: barHeight, rx: 6, fill: index === 0 ? '#0b6cff' : '#77b4ff' }));
      const label = svgElement('text', { x: 55 + index * slot + slot * 0.49, y: 230, fill: '#7589a6', 'font-size': 10, 'text-anchor': 'middle' });
      label.textContent = String(labels[index] || '').slice(0, 12);
      svg.append(label);
    });
  }
  card.append(heading, svg);
  return card;
}

function fillMapping(report) {
  const result = report.report;
  if (!result) return;
  const dateSelect = $('#reportDateColumn');
  const metrics = $('#reportMetrics');
  const dimensions = $('#reportDimensions');
  dateSelect.replaceChildren(new Option('Auto / ไม่มี', ''));
  metrics.replaceChildren();
  dimensions.replaceChildren();
  for (const column of result.columns || []) {
    if (column.type === 'date') dateSelect.append(new Option(column.name, column.name, false, result.mapping?.dateColumn === column.name));
    if (column.type === 'number') metrics.append(new Option(column.name, column.name, false, result.mapping?.metrics?.includes(column.name)));
    if (['category', 'text', 'identifier'].includes(column.type)) dimensions.append(new Option(column.name, column.name, false, result.mapping?.dimensions?.includes(column.name)));
  }
  dateSelect.value = result.mapping?.dateColumn || '';
}

function renderReportDashboard(report) {
  state.activeReport = report;
  renderReportProgress(report);
  renderReportList();
  const result = report.report;
  $('#reportEmpty').hidden = Boolean(result);
  $('#reportDashboard').hidden = !result;
  if (!result) return;
  $('#reportResultStatus').className = `report-status ${report.status}`;
  $('#reportResultStatus').textContent = reportStatusText(report.status);
  $('#reportResultTemplate').textContent = result.template;
  $('#reportModelMode').textContent = result.modelEnhanced ? 'AI insight · aggregate only' : 'Deterministic mode';
  $('#reportResultTitle').textContent = report.title || result.title;
  $('#reportSummary').textContent = result.executiveSummary;
  $('#reportSource').textContent = `${result.source.fileName} · ${result.source.sheetName} · ${result.source.rowCount.toLocaleString('th-TH')} แถว · SHA ${result.source.sha256.slice(0, 12)}…`;

  const kpis = $('#reportKpis');
  kpis.replaceChildren();
  for (const kpi of result.kpis || []) {
    const card = document.createElement('article');
    card.className = 'card report-kpi';
    const label = document.createElement('span');
    label.textContent = kpi.label;
    const value = document.createElement('strong');
    value.textContent = kpi.formatted;
    const evidence = document.createElement('small');
    evidence.textContent = `${kpi.aggregation} · ${kpi.sourceColumn || kpi.id}`;
    card.append(label, value, evidence);
    kpis.append(card);
  }

  const charts = $('#reportCharts');
  charts.replaceChildren();
  for (const chart of result.charts || []) charts.append(renderReportChart(chart));
  if (!result.charts?.length) {
    const empty = document.createElement('div');
    empty.className = 'card empty';
    empty.textContent = 'ข้อมูลชุดนี้ยังไม่มีคอลัมน์ที่เหมาะกับการสร้างกราฟ';
    charts.append(empty);
  }

  const insights = $('#reportInsights');
  insights.replaceChildren();
  for (const insight of result.insights || []) {
    const node = document.createElement('article');
    node.className = `report-insight ${insight.severity}`;
    const title = document.createElement('strong');
    title.textContent = insight.title;
    const detail = document.createElement('p');
    detail.textContent = insight.detail;
    const evidence = document.createElement('small');
    evidence.textContent = `Evidence: ${(insight.evidence || []).join(', ')}`;
    node.append(title, detail, evidence);
    insights.append(node);
  }

  const quality = $('#reportQuality');
  quality.replaceChildren();
  if (!result.quality?.length) {
    const ok = document.createElement('div');
    ok.className = 'report-quality-ok';
    ok.textContent = '✓ ไม่พบคำเตือนคุณภาพข้อมูลสำคัญ';
    quality.append(ok);
  } else {
    for (const warning of result.quality) {
      const node = document.createElement('article');
      node.className = 'report-quality-item';
      const code = document.createElement('strong');
      code.textContent = warning.code;
      const message = document.createElement('span');
      message.textContent = warning.message;
      node.append(code, message);
      quality.append(node);
    }
  }
  fillMapping(report);
}

function stopReportLive() {
  if (state.reportStreamAbort) state.reportStreamAbort();
  state.reportStreamAbort = null;
  state.reportStreamId = null;
  if (state.reportPollTimer) clearInterval(state.reportPollTimer);
  state.reportPollTimer = null;
}

function startReportPolling(reportId) {
  if (state.reportPollTimer) clearInterval(state.reportPollTimer);
  state.reportPollTimer = setInterval(() => void loadReport(reportId, false), 2000);
}

function handleReportSseBlock(block, reportId) {
  let eventName = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!data.length) return;
  try {
    const payload = JSON.parse(data.join('\n'));
    if (eventName === 'snapshot' && payload.report) renderReportDashboard(payload.report);
    if (eventName === 'complete' && payload.report) renderReportDashboard(payload.report);
    if (eventName === 'update') setTimeout(() => void loadReport(reportId, false), 80);
  } catch { /* polling will reconcile partial events */ }
}

async function connectReportStream(reportId) {
  stopReportLive();
  const controller = new AbortController();
  state.reportStreamAbort = () => controller.abort();
  state.reportStreamId = reportId;
  try {
    const headers = new Headers();
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);
    const response = await fetch(`/reports/${encodeURIComponent(reportId)}/events`, { headers, cache: 'no-store', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Live stream unavailable (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) handleReportSseBlock(block, reportId);
    }
    if (!controller.signal.aborted) await loadReport(reportId, false);
  } catch {
    if (!controller.signal.aborted) startReportPolling(reportId);
  }
}

async function loadReport(reportId, connect = true) {
  try {
    const data = await api(`/reports/${encodeURIComponent(reportId)}`);
    const report = data.report;
    const index = state.reports.findIndex((item) => item.id === report.id);
    if (index >= 0) state.reports[index] = report;
    else state.reports.unshift(report);
    renderReportDashboard(report);
    if (['queued', 'running'].includes(report.status)) {
      if (connect && state.reportStreamId !== reportId) void connectReportStream(reportId);
    } else if (state.reportStreamId === reportId || state.reportPollTimer) {
      stopReportLive();
    }
  } catch (error) {
    toast(`โหลดรายงานไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadReports() {
  try {
    const data = await api('/reports?limit=50');
    state.reports = Array.isArray(data.reports) ? data.reports : [];
    renderReportList();
    const selected = state.activeReport?.id || state.reports[0]?.id;
    if (selected) await loadReport(selected);
  } catch (error) {
    toast(`Report Studio unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function createSampleReport() {
  const buttons = [$('#reportSampleButton'), $('#dashboardSampleButton')].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  try {
    switchView('reports');
    const data = await api('/reports/sample', { method: 'POST', body: '{}' });
    state.activeReport = data.report;
    state.reports.unshift(data.report);
    renderReportDashboard(data.report);
    toast('เริ่มสร้าง Sample Report แล้ว');
    void connectReportStream(data.reportId);
  } catch (error) {
    toast(`สร้าง sample ไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

$('#reportSampleButton').addEventListener('click', () => void createSampleReport());
$('#dashboardSampleButton').addEventListener('click', () => void createSampleReport());
$('#reportRefreshButton').addEventListener('click', () => void loadReports());

const reportDropzone = $('#reportDropzone');
const reportFileInput = $('#reportFile');
function selectReportFile(file) {
  if (!file) return;
  const extension = file.name.toLowerCase().split('.').pop();
  if (!['xlsx', 'csv'].includes(extension)) {
    toast('รองรับเฉพาะไฟล์ .xlsx และ .csv');
    reportFileInput.value = '';
    return;
  }
  if (file.size > 20_000_000) {
    toast('ไฟล์ใหญ่เกิน 20 MB');
    reportFileInput.value = '';
    return;
  }
  $('#reportFileLabel').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  reportDropzone.classList.add('has-file');
}
reportDropzone.addEventListener('click', () => reportFileInput.click());
reportDropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') reportFileInput.click(); });
reportFileInput.addEventListener('change', () => selectReportFile(reportFileInput.files?.[0]));
for (const eventName of ['dragenter', 'dragover']) reportDropzone.addEventListener(eventName, (event) => { event.preventDefault(); reportDropzone.classList.add('dragging'); });
for (const eventName of ['dragleave', 'drop']) reportDropzone.addEventListener(eventName, (event) => { event.preventDefault(); reportDropzone.classList.remove('dragging'); });
reportDropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  reportFileInput.files = transfer.files;
  selectReportFile(file);
});

$('#reportUploadButton').addEventListener('click', async () => {
  const file = reportFileInput.files?.[0];
  if (!file) { toast('เลือกไฟล์ Excel หรือ CSV ก่อน'); return; }
  const button = $('#reportUploadButton');
  button.disabled = true;
  try {
    const body = new FormData();
    body.append('file', file, file.name);
    body.append('template', $('#reportTemplate').value);
    const data = await api('/reports', { method: 'POST', body });
    state.activeReport = data.report;
    state.reports.unshift(data.report);
    renderReportDashboard(data.report);
    toast('อัปโหลดแล้ว · Cherry กำลังตรวจข้อมูล');
    void connectReportStream(data.reportId);
  } catch (error) {
    toast(`วิเคราะห์ไฟล์ไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    button.disabled = false;
  }
});

$('#reportMappingForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeReport) return;
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const mapping = {
      dateColumn: $('#reportDateColumn').value || undefined,
      metrics: [...$('#reportMetrics').selectedOptions].map((option) => option.value),
      dimensions: [...$('#reportDimensions').selectedOptions].map((option) => option.value),
    };
    const data = await api(`/reports/${encodeURIComponent(state.activeReport.id)}/mapping`, { method: 'PATCH', body: JSON.stringify({ mapping }) });
    state.activeReport = data.report;
    renderReportDashboard(data.report);
    toast('เริ่มสร้างรายงานใหม่ตาม mapping แล้ว');
    void connectReportStream(data.reportId);
  } catch (error) {
    toast(`Regenerate ไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    submit.disabled = false;
  }
});

$('#reportPdfButton').addEventListener('click', async () => {
  if (!state.activeReport) return;
  const button = $('#reportPdfButton');
  button.disabled = true;
  try {
    const headers = new Headers();
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);
    const response = await fetch(`/reports/${encodeURIComponent(state.activeReport.id)}/pdf`, { headers, cache: 'no-store' });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || `Download failed (${response.status})`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.activeReport.title || 'cherry-report'}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast(`ดาวน์โหลด PDF ไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    button.disabled = false;
  }
});

$('#reportDeleteButton').addEventListener('click', async () => {
  const report = state.activeReport;
  if (!report || !window.confirm(`ลบรายงาน “${report.title}” และไฟล์ทั้งหมด?`)) return;
  try {
    await api(`/reports/${encodeURIComponent(report.id)}`, { method: 'DELETE' });
    stopReportLive();
    state.activeReport = null;
    state.reports = state.reports.filter((item) => item.id !== report.id);
    $('#reportDashboard').hidden = true;
    $('#reportEmpty').hidden = false;
    $('#reportProgressCard').hidden = true;
    renderReportList();
    if (state.reports[0]) await loadReport(state.reports[0].id);
    toast('ลบรายงานแล้ว');
  } catch (error) {
    toast(`ลบไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
  }
});

$('#reportOpenFlowButton').addEventListener('click', async () => {
  const runId = state.activeReport?.runId;
  if (!runId) return;
  switchView('deploy');
  await loadDeployRuns();
  await loadDeployRun(runId);
});

function renderOfficeInbox(items) {
  state.officeInbox = items;
  $('#officeInboxCount').textContent = String(items.filter((item) => item.status === 'new').length);
  const container = $('#officeInboxList');
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'ยังไม่มีอีเมลในกล่องงาน กด Sync Inbox เพื่อเริ่มต้น';
    container.append(empty);
    return;
  }
  for (const item of items) {
    const card = document.createElement('article');
    card.className = `office-inbox-item ${item.status}`;
    const head = document.createElement('div');
    head.className = 'office-inbox-head';
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = item.subject || '(no subject)';
    const status = document.createElement('span');
    status.className = `office-status ${item.status}`;
    status.textContent = item.status;
    head.append(title, status);
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `${item.from || 'Unknown sender'} · ${formatDateTime(item.date || item.updatedAt)}`;
    const snippet = document.createElement('div');
    snippet.className = 'office-snippet';
    snippet.textContent = item.snippet || 'ไม่มี preview';
    const actions = document.createElement('div');
    actions.className = 'office-item-actions';
    if (item.status === 'new') {
      const triage = document.createElement('button');
      triage.className = 'primary small-button';
      triage.textContent = 'สร้างเป็นงาน';
      triage.addEventListener('click', async () => {
        triage.disabled = true;
        try {
          await api(`/office/inbox/${encodeURIComponent(item.id)}/triage`, { method: 'POST', body: JSON.stringify({ tags: ['office-inbox'] }) });
          toast('เปลี่ยนอีเมลเป็นงานแล้ว');
          await loadOfficeInbox();
          await loadPlanner();
        } catch (error) {
          toast(`สร้างงานไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
          triage.disabled = false;
        }
      });
      const ignore = document.createElement('button');
      ignore.className = 'secondary small-button';
      ignore.textContent = 'ไม่ใช่งาน';
      ignore.addEventListener('click', async () => {
        try {
          await api(`/office/inbox/${encodeURIComponent(item.id)}/ignore`, { method: 'POST', body: '{}' });
          await loadOfficeInbox();
        } catch (error) {
          toast(`อัปเดต inbox ไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      actions.append(triage, ignore);
    } else if (item.planItemId) {
      const linked = document.createElement('span');
      linked.className = 'office-linked-task';
      linked.textContent = `งาน ${item.planItemId.slice(0, 8)}`;
      actions.append(linked);
    }
    card.append(head, meta, snippet, actions);
    container.append(card);
  }
}

async function loadOfficeInbox() {
  try {
    const [context, inbox, usage] = await Promise.all([
      api('/workspace/context'),
      api('/office/inbox'),
      api('/usage/dashboard'),
    ]);
    state.workspace = context;
    $('#officeTenantBadge').textContent = `${context.organization?.name || 'Workspace'} · ${context.user?.role || 'user'}`;
    if (state.connectors?.google) {
      $('#officeSourceNote').textContent = context.organization?.plan ? `Plan: ${context.organization.plan} · ข้อมูลแยกตาม tenant ${context.organization.id}` : 'ข้อมูลแยกตาม tenant ของ workspace นี้';
    }
    updateOfficeConnectorState();
    renderOfficeInbox(inbox.items || []);
    renderUsage(usage.usage);
  } catch (error) {
    toast(`Office Inbox unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

$('#officeSyncForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#officeSyncButton');
  button.disabled = true;
  try {
    const data = await api('/office/inbox/sync', {
      method: 'POST',
      body: JSON.stringify({ query: $('#officeInboxQuery').value.trim() || 'in:inbox', maxResults: Number($('#officeInboxMax').value) || 25 }),
    });
    toast(`Sync แล้ว ${data.count || 0} อีเมล`);
    await loadOfficeInbox();
  } catch (error) {
    toast(`Sync Inbox ไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    button.disabled = false;
  }
});

$('#officeRefreshButton').addEventListener('click', () => void loadOfficeInbox());

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

const deployStatusLabels = {
  pending: 'รอ dependency',
  running: 'กำลังรัน',
  succeeded: 'สำเร็จ',
  blocked: 'ติดขัด',
  failed: 'ล้มเหลว',
  skipped: 'ข้าม',
  aborted: 'หยุดจากการรีสตาร์ท',
};

const deployRoleLabels = {
  office: 'Office',
  planner: 'Planner',
  infra: 'Infra',
  market: 'Market',
  research: 'Research',
  database: 'Database',
  engineer: 'Engineer',
  general: 'General',
};

function deployTerminal(task) {
  return ['succeeded', 'blocked', 'failed', 'skipped'].includes(task.status);
}

function deployStatusColor(status) {
  return { running: '#0b6cff', succeeded: '#2eb67d', blocked: '#e7a23b', failed: '#e45465', aborted: '#8b98aa' }[status] || '#9db0cb';
}

function deploySnapshot(snapshot) {
  state.deployRun = snapshot.run;
  state.deployHandoffs = Array.isArray(snapshot.handoffs) ? snapshot.handoffs : [];
  state.deployEvidence = Array.isArray(snapshot.evidence) ? snapshot.evidence : [];
  state.deployLogs = Array.isArray(snapshot.logs) ? snapshot.logs : [];
  if (!state.deploySelectedTaskId || !state.deployRun.tasks.some((task) => task.id === state.deploySelectedTaskId)) {
    state.deploySelectedTaskId = state.deployRun.tasks.find((task) => task.status === 'running')?.id || state.deployRun.tasks[0]?.id || null;
  }
  renderDeployRunSummary();
  renderDeployTopology();
  renderDeployInspector();
  renderDeployActivity();
}

function renderDeployRunSummary() {
  const run = state.deployRun;
  const tasks = run?.tasks || [];
  const done = tasks.filter(deployTerminal).length;
  const active = tasks.filter((task) => task.status === 'running').length;
  const pending = tasks.filter((task) => task.status === 'pending').length;
  const failed = tasks.filter((task) => task.status === 'failed' || task.status === 'blocked').length;
  $('#deployNavCount').textContent = String(state.deployRuns.filter((item) => item.status === 'running').length);
  if (!run) {
    $('#deployLiveText').textContent = 'พร้อมรัน Workflow';
    $('#deployLiveDot').style.background = '#2eb67d';
    $('#topologySubtitle').textContent = 'Deploy แล้วจะเห็นเส้นทางงานและ node ที่กำลัง active';
    $('#deployRunIdentity').textContent = 'jobId / runId / traceId จะแสดงเมื่อเลือก run';
    return;
  }
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const live = run.status === 'running' ? `กำลังรัน · ${done}/${tasks.length} tasks · ${pct}%` : `${deployStatusLabels[run.status] || run.status} · ${done}/${tasks.length} tasks`;
  $('#deployLiveText').textContent = live;
  $('#deployLiveDot').style.background = deployStatusColor(run.status);
  $('#topologySubtitle').textContent = `Round ${run.round} · active ${active} · pending ${pending} · blocked/failed ${failed} · อัปเดต ${formatDateTime(run.updatedAt)}`;
  $('#deployRunIdentity').textContent = `jobId=${run.jobId || '—'} · runId=${run.id} · traceId=${run.traceId || '—'} · tags=${run.tags?.join(', ') || '—'}`;
}

function renderDeployRunList() {
  const select = $('#deployRunSelect');
  const selected = state.deployRun?.id || select.value;
  select.replaceChildren();
  if (!state.deployRuns.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'ยังไม่มี run';
    select.append(option);
    return;
  }
  for (const run of state.deployRuns) {
    const option = document.createElement('option');
    option.value = run.id;
    option.textContent = `${run.status === 'running' ? '● ' : ''}${run.goal.slice(0, 72)} · ${formatDateTime(run.createdAt)}`;
    option.selected = run.id === selected;
    select.append(option);
  }
}

function taskDepth(task, byId, visiting = new Set()) {
  if (!task) return 0;
  if (!task.dependsOn?.length) return 0;
  if (visiting.has(task.id)) return 0;
  const next = new Set(visiting);
  next.add(task.id);
  return Math.min(8, 1 + Math.max(...task.dependsOn.map((id) => taskDepth(byId.get(id), byId, next)).filter(Number.isFinite)));
}

function renderDeployTopology() {
  const run = state.deployRun;
  const empty = $('#flowEmpty');
  const nodes = $('#flowNodes');
  const edges = $('#flowEdges');
  nodes.replaceChildren();
  edges.replaceChildren();
  if (!run?.tasks?.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const byId = new Map(run.tasks.map((task) => [task.id, task]));
  const groups = new Map();
  for (const task of run.tasks) {
    const depth = taskDepth(task, byId);
    const list = groups.get(depth) || [];
    list.push(task);
    groups.set(depth, list);
  }
  const positions = new Map();
  const nodeWidth = 236;
  const nodeHeight = 126;
  const colGap = 88;
  const rowGap = 28;
  const marginX = 48;
  const marginY = 48;
  let graphHeight = 620;
  for (const [depth, group] of groups.entries()) {
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    group.forEach((task, index) => {
      positions.set(task.id, { x: marginX + depth * (nodeWidth + colGap), y: marginY + index * (nodeHeight + rowGap) });
    });
    graphHeight = Math.max(graphHeight, marginY * 2 + group.length * (nodeHeight + rowGap));
  }
  const graphWidth = Math.max(1000, marginX * 2 + (Math.max(...groups.keys()) + 1) * (nodeWidth + colGap));
  const stage = $('#flowStage');
  const svg = $('#flowSvg');
  stage.style.width = `${graphWidth}px`;
  stage.style.height = `${graphHeight}px`;
  svg.setAttribute('width', String(graphWidth));
  svg.setAttribute('height', String(graphHeight));
  svg.setAttribute('viewBox', `0 0 ${graphWidth} ${graphHeight}`);

  for (const task of run.tasks) {
    const target = positions.get(task.id);
    if (!target) continue;
    for (const dependencyId of task.dependsOn || []) {
      const source = positions.get(dependencyId);
      if (!source) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const x1 = source.x + nodeWidth;
      const y1 = source.y + nodeHeight / 2;
      const x2 = target.x;
      const y2 = target.y + nodeHeight / 2;
      const bend = Math.max(42, (x2 - x1) / 2);
      path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
      path.classList.add('flow-edge', byId.get(dependencyId)?.status === 'succeeded' ? 'complete' : 'waiting');
      path.setAttribute('marker-end', 'url(#flowArrow)');
      edges.append(path);
    }
  }

  for (const task of run.tasks) {
    const position = positions.get(task.id);
    if (!position) continue;
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `flow-node ${task.status}${state.deploySelectedTaskId === task.id ? ' selected' : ''}`;
    node.style.left = `${position.x}px`;
    node.style.top = `${position.y}px`;
    node.style.width = `${nodeWidth}px`;
    node.style.height = `${nodeHeight}px`;
    node.addEventListener('click', () => {
      state.deploySelectedTaskId = task.id;
      renderDeployTopology();
      renderDeployInspector();
    });

    const head = document.createElement('span');
    head.className = 'flow-node-head';
    const role = document.createElement('span');
    role.className = 'flow-node-role';
    role.textContent = deployRoleLabels[task.role] || task.role;
    const status = document.createElement('span');
    status.className = `flow-node-status ${task.status}`;
    status.textContent = deployStatusLabels[task.status] || task.status;
    head.append(role, status);
    const title = document.createElement('strong');
    title.className = 'flow-node-title';
    title.textContent = task.objective;
    const meta = document.createElement('span');
    meta.className = 'flow-node-meta';
    const progress = task.progress;
    meta.textContent = task.status === 'running' && progress
      ? `${progress.phase}${progress.activeTool ? ` · ${progress.activeTool}` : ''} · step ${progress.step}/${progress.maxSteps}`
      : `${task.key} · ${task.evidenceIds?.length || 0} evidence`;
    const bar = document.createElement('span');
    bar.className = 'flow-node-progress';
    const fill = document.createElement('i');
    fill.style.width = `${task.status === 'succeeded' ? 100 : task.status === 'running' && progress?.maxSteps ? Math.min(96, (progress.step / progress.maxSteps) * 100) : task.status === 'failed' || task.status === 'blocked' ? 100 : 0}%`;
    bar.append(fill);
    node.append(head, title, meta, bar);
    nodes.append(node);
  }
  applyFlowTransform();
}

function renderDeployInspector() {
  const run = state.deployRun;
  const task = run?.tasks?.find((item) => item.id === state.deploySelectedTaskId);
  if (!task) {
    $('#inspectorEmpty').hidden = false;
    $('#inspectorBody').hidden = true;
    $('#inspectorStatus').textContent = 'รอเลือก node';
    return;
  }
  $('#inspectorEmpty').hidden = true;
  $('#inspectorBody').hidden = false;
  $('#inspectorStatus').textContent = deployStatusLabels[task.status] || task.status;
  $('#inspectorStatus').className = `inspector-status ${task.status}`;
  $('#inspectorTitle').textContent = `${deployRoleLabels[task.role] || task.role} · ${task.key}`;
  $('#inspectorMeta').textContent = `${deployStatusLabels[task.status] || task.status} · อัปเดต ${formatDateTime(task.updatedAt)}`;
  $('#inspectorIdentifiers').textContent = [
    `jobId: ${run.jobId || '—'}`,
    `runId: ${run.id}`,
    `traceId: ${run.traceId || '—'}`,
    `taskId: ${task.id}`,
    `spanId: ${task.spanId || '—'}`,
  ].join('\n');
  $('#inspectorTags').textContent = (task.tags?.length ? task.tags : run.tags?.length ? run.tags : ['ไม่มี tag']).join(' · ');
  $('#inspectorObjective').textContent = task.objective;
  const progress = task.progress;
  $('#inspectorProgress').textContent = progress
    ? `${progress.phase} · step ${progress.step}/${progress.maxSteps}${progress.activeTool ? ` · ${progress.activeTool}` : ''}`
    : task.status === 'succeeded' ? 'เสร็จสมบูรณ์' : 'ยังไม่มี progress detail';
  const byId = new Map((run.tasks || []).map((item) => [item.id, item]));
  $('#inspectorDependencies').textContent = task.dependsOn?.length
    ? task.dependsOn.map((id) => byId.get(id)?.key || id).join(', ')
    : 'ไม่มี dependency';
  $('#inspectorActivity').textContent = task.lastActivityAt ? formatDateTime(task.lastActivityAt) : formatDateTime(task.updatedAt);
  $('#inspectorResult').textContent = task.error || task.result || 'ยังไม่มีผลลัพธ์';
  const evidenceEl = $('#inspectorEvidence');
  evidenceEl.replaceChildren();
  const records = state.deployEvidence.filter((item) => item.taskId === task.id).slice(0, 8);
  if (!records.length) {
    evidenceEl.textContent = 'ยังไม่มี evidence';
  } else {
    for (const record of records) {
      const item = document.createElement('div');
      item.className = 'evidence-item';
      item.textContent = `${record.kind} · ${record.sourceTool || record.agent} · ${record.claim}`;
      evidenceEl.append(item);
    }
  }
  const logsEl = $('#inspectorLogs');
  logsEl.replaceChildren();
  const logs = state.deployLogs.filter((item) => item.taskId === task.id).slice(0, 12);
  if (!logs.length) {
    logsEl.textContent = 'ยังไม่มี log';
  } else {
    for (const log of logs) {
      const item = document.createElement('div');
      item.className = `evidence-item ${log.level || ''}`;
      item.textContent = `#${log.sequence} · ${log.action} · ${log.id}\n${log.message}${log.tool ? ` · tool=${log.tool}` : ''}`;
      logsEl.append(item);
    }
  }
}

function renderDeployActivity() {
  const run = state.deployRun;
  const active = $('#activeTaskList');
  const activity = $('#flowActivityList');
  active.replaceChildren();
  activity.replaceChildren();
  if (!run) {
    active.innerHTML = '<div class="empty">ยังไม่มีงานที่กำลังรัน</div>';
    activity.innerHTML = '<div class="empty">Activity จะแสดงเมื่อ Deploy งาน</div>';
    return;
  }
  const tasks = run.tasks || [];
  const activeTasks = tasks.filter((task) => task.status === 'running' || task.status === 'pending');
  if (!activeTasks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = run.status === 'running' ? 'กำลังเตรียม task ถัดไป…' : 'ไม่มี task ที่กำลังรัน';
    active.append(empty);
  } else {
    for (const task of activeTasks) {
      const row = document.createElement('div');
      row.className = `active-task-row ${task.status}`;
      const title = document.createElement('strong');
      title.textContent = task.objective;
      const meta = document.createElement('span');
      const progress = task.progress;
      meta.textContent = task.status === 'running' && progress ? `${deployRoleLabels[task.role] || task.role} · ${progress.phase} · ${progress.activeTool || `step ${progress.step}/${progress.maxSteps}`}` : `${deployRoleLabels[task.role] || task.role} · รอ dependency`;
      row.append(title, meta);
      active.append(row);
    }
  }

  const events = state.deployLogs.slice(0, 24);
  if (!events.length) {
    activity.innerHTML = '<div class="empty">กำลังรอ activity จาก Agent…</div>';
  } else {
    for (const event of events) {
      const row = document.createElement('div');
      row.className = `flow-activity-row ${event.level || ''}`;
      const time = document.createElement('time');
      time.textContent = `#${event.sequence} · ${formatDateTime(event.createdAt)}`;
      const body = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${event.action} · ${event.message}`;
      const detail = document.createElement('span');
      detail.textContent = `logId=${event.id} · taskId=${event.taskId || 'run'} · ${event.tool ? `tool=${event.tool} · ` : ''}${event.tags?.join(', ') || ''}`;
      const meta = document.createElement('small');
      meta.className = 'flow-log-meta';
      meta.textContent = `jobId=${event.jobId} · traceId=${event.traceId}${event.step !== undefined ? ` · step=${event.step}/${event.maxSteps}` : ''}`;
      const tags = document.createElement('small');
      tags.className = 'flow-log-tags';
      tags.textContent = event.tags?.length ? `tags: ${event.tags.join(' · ')}` : '';
      body.append(title, detail, meta, tags);
      row.append(time, body);
      activity.append(row);
    }
  }
}

function applyFlowTransform() {
  const transform = state.deployTransform;
  $('#flowStage').style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
}

function fitDeployGraph() {
  const viewport = $('#flowViewport');
  const stage = $('#flowStage');
  if (!viewport || !stage || !state.deployRun?.tasks?.length) return;
  const scale = Math.min(1, Math.max(0.35, Math.min((viewport.clientWidth - 32) / stage.offsetWidth, (viewport.clientHeight - 32) / stage.offsetHeight)));
  state.deployTransform = { scale, x: Math.max(16, (viewport.clientWidth - stage.offsetWidth * scale) / 2), y: Math.max(16, (viewport.clientHeight - stage.offsetHeight * scale) / 2) };
  applyFlowTransform();
}

function scheduleDeployRefresh() {
  if (state.deployRefreshTimer) return;
  state.deployRefreshTimer = setTimeout(async () => {
    state.deployRefreshTimer = null;
    if (state.deployRun?.id) await loadDeployRun(state.deployRun.id, false);
  }, 160);
}

function startDeployPolling(runId) {
  if (state.deployPollTimer) clearInterval(state.deployPollTimer);
  state.deployPollTimer = setInterval(async () => {
    if (state.deployRun?.id !== runId) return;
    await loadDeployRun(runId, false);
    if (state.deployRun?.status !== 'running') {
      clearInterval(state.deployPollTimer);
      state.deployPollTimer = null;
      await loadDeployRuns();
    }
  }, 2000);
}

function handleDeploySseBlock(block) {
  const lines = block.split(/\r?\n/);
  let eventName = 'message';
  const data = [];
  for (const line of lines) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!data.length) return;
  try {
    const payload = JSON.parse(data.join('\n'));
    if (eventName === 'snapshot') deploySnapshot(payload);
    if (eventName === 'update') scheduleDeployRefresh();
  } catch {
    // Ignore an incomplete heartbeat/event block and let polling recover state.
  }
}

async function connectDeployStream(runId) {
  if (state.deployStreamAbort) state.deployStreamAbort();
  if (state.deployPollTimer) clearInterval(state.deployPollTimer);
  const controller = new AbortController();
  state.deployStreamAbort = () => controller.abort();
  try {
    const headers = new Headers();
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);
    const response = await fetch(`/orchestrator/runs/${encodeURIComponent(runId)}/events`, { headers, cache: 'no-store', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Live stream unavailable (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) handleDeploySseBlock(block);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      startDeployPolling(runId);
      $('#deployLiveText').textContent = 'Live stream หลุด · ใช้ polling สำรอง';
    }
  }
}

async function loadDeployRun(runId, connect = true) {
  try {
    const data = await api(`/orchestrator/runs/${encodeURIComponent(runId)}`);
    const summaryIndex = state.deployRuns.findIndex((item) => item.id === runId);
    if (summaryIndex >= 0) state.deployRuns[summaryIndex] = data.run;
    deploySnapshot(data);
    if (connect && data.run.status === 'running') void connectDeployStream(runId);
    if (data.run.status !== 'running' && state.deployPollTimer) {
      clearInterval(state.deployPollTimer);
      state.deployPollTimer = null;
    }
    if (data.run.status !== 'running') {
      if (state.deployStreamAbort) {
        state.deployStreamAbort();
        state.deployStreamAbort = null;
      }
      renderDeployRunList();
    }
  } catch (error) {
    toast(`โหลด Deploy run ไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadDeployRuns() {
  try {
    const data = await api('/orchestrator/runs?limit=50');
    state.deployRuns = Array.isArray(data.runs) ? data.runs : [];
    renderDeployRunList();
    renderDeployRunSummary();
    const selected = state.deployRun?.id || state.deployRuns[0]?.id;
    if (selected && state.deployRun?.id !== selected) await loadDeployRun(selected);
  } catch (error) {
    toast(`โหลด Deploy runs ไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
  }
}

$('#deployForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('#deploySubmit');
  submit.disabled = true;
  try {
    const preferredRole = $('#deployRole').value;
    const tags = $('#deployTags').value.split(',').map((item) => item.trim().replace(/^#/, '')).filter(Boolean);
    const body = {
      goal: $('#deployGoal').value.trim(),
      ...(preferredRole ? { preferredRoles: [preferredRole] } : {}),
      ...(tags.length ? { tags } : {}),
    };
    const data = await api('/orchestrator/runs', { method: 'POST', body: JSON.stringify(body) });
    $('#deployGoal').value = '';
    $('#deployTags').value = '';
    toast(`Deploy started · ${data.runId.slice(0, 8)}`);
    state.deployRun = data.run;
    state.deploySelectedTaskId = null;
    await loadDeployRuns();
    await loadDeployRun(data.runId);
  } catch (error) {
    toast(`เริ่ม Deploy ไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    submit.disabled = false;
  }
});

$('#deployRunSelect').addEventListener('change', async () => {
  const runId = $('#deployRunSelect').value;
  if (runId) {
    state.deploySelectedTaskId = null;
    await loadDeployRun(runId);
  }
});

$('#flowRefreshButton').addEventListener('click', () => void loadDeployRuns());
$('#flowFitButton').addEventListener('click', fitDeployGraph);
window.addEventListener('resize', () => { if (state.currentView === 'deploy') fitDeployGraph(); });

const flowViewport = $('#flowViewport');
let flowPan = null;
flowViewport.addEventListener('wheel', (event) => {
  if (state.currentView !== 'deploy' || !state.deployRun?.tasks?.length) return;
  event.preventDefault();
  const scale = Math.min(1.8, Math.max(0.35, state.deployTransform.scale * (event.deltaY > 0 ? 0.9 : 1.1)));
  state.deployTransform.scale = scale;
  applyFlowTransform();
}, { passive: false });
flowViewport.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.flow-node')) return;
  flowPan = { x: event.clientX, y: event.clientY, originX: state.deployTransform.x, originY: state.deployTransform.y };
  flowViewport.setPointerCapture(event.pointerId);
  flowViewport.classList.add('panning');
});
flowViewport.addEventListener('pointermove', (event) => {
  if (!flowPan) return;
  state.deployTransform.x = flowPan.originX + event.clientX - flowPan.x;
  state.deployTransform.y = flowPan.originY + event.clientY - flowPan.y;
  applyFlowTransform();
});
flowViewport.addEventListener('pointerup', () => { flowPan = null; flowViewport.classList.remove('panning'); });
flowViewport.addEventListener('pointercancel', () => { flowPan = null; flowViewport.classList.remove('panning'); });

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

function updateChatIdentity() {
  const node = $('#chatIdentity');
  if (node) node.textContent = `Chat ID: ${chatId}`;
}

function startNewChat() {
  chatId = crypto.randomUUID();
  localStorage.setItem(chatIdStorageKey, chatId);
  const welcome = document.createElement('div');
  welcome.className = 'message assistant';
  welcome.textContent = 'เริ่มแชตใหม่ได้เลยค่ะ ส่งงานหรือปัญหามาได้เลย เดี๋ยวเชอรี่ลงมือผ่านเครื่องมือและเก็บ log แยกตาม Chat ID นี้นะคะ';
  $('#chat').replaceChildren(welcome);
  updateChatIdentity();
}

updateChatIdentity();
$('#newChatButton').addEventListener('click', startNewChat);

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
      body: JSON.stringify({ message, chatId }),
    });
    if (typeof data.chatId === 'string' && data.chatId !== chatId) {
      chatId = data.chatId;
      localStorage.setItem(chatIdStorageKey, chatId);
      updateChatIdentity();
    }
    pending.textContent = data.answer;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${data.steps} agent step${data.steps === 1 ? '' : 's'} · logId=${data.logId || data.traceId || '—'}`;
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

async function startApp() {
  if (appStarted) return;
  appStarted = true;
  await Promise.all([checkHealth(), loadPlanner(), loadEngineer(), loadApprovals(), loadDeployRuns(), loadOfficeInbox(), loadReports()]);
  setInterval(loadPlanner, 5000);
  setInterval(loadEngineer, 5000);
  setInterval(loadApprovals, 5000);
  setInterval(loadOfficeInbox, 15000);
  setInterval(checkHealth, 30000);
}

if (await checkAuthentication()) await startApp();
