const CHAT_PATH = '/chat';
const PENDING_TEXT = 'Cherry is planning and working with tools...';
const TRACE_LIMIT = 12000;

const sensitiveKeyPattern = /(password|passwd|secret|token|private.?key|authorization|cookie|credential|api.?key)/i;
const sensitiveValuePatterns = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
];

function redactString(value) {
  let output = value;
  for (const pattern of sensitiveValuePatterns) output = output.replace(pattern, '[REDACTED]');
  return output;
}

function sanitize(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = sensitiveKeyPattern.test(key) ? '[REDACTED]' : sanitize(item, seen);
  }
  return output;
}

function pretty(value) {
  try {
    const text = typeof value === 'string' ? redactString(value) : JSON.stringify(sanitize(value), null, 2);
    if (text.length <= TRACE_LIMIT) return text;
    return `${text.slice(0, TRACE_LIMIT)}\n… output truncated in UI (${text.length - TRACE_LIMIT} more characters)`;
  } catch {
    return redactString(String(value));
  }
}

function parseArguments(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw || '{}'); } catch { return raw; }
}

function injectStyles() {
  if (document.querySelector('#cherry-execution-trail-styles')) return;
  const style = document.createElement('style');
  style.id = 'cherry-execution-trail-styles';
  style.textContent = `
    .message.assistant.has-execution-trail { max-width: min(96%, 980px); width: min(96%, 980px); }
    .cherry-live-status { display:flex; align-items:center; gap:9px; margin-top:10px; padding:9px 11px; border:1px solid #bed8fa; border-radius:11px; color:#38628f; background:#f8fbff; font-size:10px; }
    .cherry-live-dot { width:8px; height:8px; flex:none; border-radius:50%; background:#0b6cff; box-shadow:0 0 0 0 rgba(11,108,255,.35); animation:cherry-live-pulse 1.5s infinite; }
    @keyframes cherry-live-pulse { 70% { box-shadow:0 0 0 8px rgba(11,108,255,0); } 100% { box-shadow:0 0 0 0 rgba(11,108,255,0); } }
    .execution-trail { margin-top:13px; padding-top:12px; border-top:1px solid #cfe1f8; white-space:normal; }
    .execution-trail-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:9px; }
    .execution-trail-head strong { color:#234f86; font-size:11px; }
    .execution-trail-head span { color:#7b90aa; font-size:9px; line-height:1.4; text-align:right; }
    .execution-step-list { display:grid; gap:7px; }
    .execution-step { overflow:hidden; border:1px solid #d5e4f5; border-radius:11px; background:#fff; }
    .execution-step[open] { box-shadow:0 5px 16px rgba(35,79,134,.055); }
    .execution-step summary { display:flex; align-items:center; gap:8px; cursor:pointer; padding:9px 10px; color:#315b8d; background:#f7faff; font-size:10px; font-weight:800; list-style:none; }
    .execution-step summary::-webkit-details-marker { display:none; }
    .execution-step summary::before { content:'›'; color:#7da3d1; font-size:15px; transform:rotate(0); transition:transform .15s ease; }
    .execution-step[open] summary::before { transform:rotate(90deg); }
    .execution-step.tool summary::after, .execution-step.correctness summary::after, .execution-step.error summary::after, .execution-step.assistant summary::after { margin-left:auto; padding:3px 6px; border-radius:999px; font-size:8px; letter-spacing:.04em; text-transform:uppercase; }
    .execution-step.tool summary::after { content:'tool'; color:#187452; background:#e9f8f1; }
    .execution-step.correctness summary::after { content:'verify'; color:#285fa9; background:#e5f0ff; }
    .execution-step.error summary::after { content:'error'; color:#b13b4b; background:#ffebee; }
    .execution-step.assistant summary::after { content:'agent'; color:#76561e; background:#fff3d9; }
    .execution-step-body { padding:10px; border-top:1px solid #e4edf8; }
    .execution-step-note { margin:0 0 7px; color:#5c7190; font-size:9px; line-height:1.55; }
    .execution-tool-call { margin:7px 0 0; padding:8px; border:1px solid #e1eaf5; border-radius:9px; background:#fbfdff; }
    .execution-tool-name { color:#174f96; font:800 9px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .execution-code { max-height:360px; overflow:auto; margin:7px 0 0; padding:9px; border-radius:8px; color:#314863; background:#f1f5fa; white-space:pre-wrap; overflow-wrap:anywhere; font:9px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .execution-summary { margin-top:9px; color:#7489a4; font-size:9px; }
  `;
  document.head.append(style);
}

function lastAssistantMessage() {
  const messages = [...document.querySelectorAll('#chat .message.assistant')];
  return messages.at(-1) || null;
}

function attachLiveStatus(startedAt) {
  const node = lastAssistantMessage();
  if (!node || node.dataset.executionPending === '1') return null;
  if (!node.textContent.includes(PENDING_TEXT)) return null;
  node.dataset.executionPending = '1';
  const live = document.createElement('div');
  live.className = 'cherry-live-status';
  const dot = document.createElement('span');
  dot.className = 'cherry-live-dot';
  const label = document.createElement('span');
  live.append(dot, label);
  node.append(live);
  const update = () => {
    const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    label.textContent = `กำลังประมวลผล เลือกเครื่องมือ และรอหลักฐานจากระบบ · ${elapsed}s`;
  };
  update();
  const timer = setInterval(update, 1000);
  return () => clearInterval(timer);
}

function assistantStepDetail(event) {
  const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
  const calls = Array.isArray(detail.tool_calls) ? detail.tool_calls : [];
  const content = typeof detail.content === 'string' ? detail.content.trim() : '';
  const wrapper = document.createElement('div');
  wrapper.className = 'execution-step-body';

  if (content) {
    const note = document.createElement('p');
    note.className = 'execution-step-note';
    note.textContent = content;
    wrapper.append(note);
  }

  for (const call of calls) {
    const box = document.createElement('div');
    box.className = 'execution-tool-call';
    const name = document.createElement('div');
    name.className = 'execution-tool-name';
    name.textContent = call?.function?.name || 'unknown_tool';
    const args = document.createElement('pre');
    args.className = 'execution-code';
    args.textContent = pretty(parseArguments(call?.function?.arguments));
    box.append(name, args);
    wrapper.append(box);
  }

  if (!content && !calls.length) {
    const note = document.createElement('p');
    note.className = 'execution-step-note';
    note.textContent = 'Agent ประมวลผลคำตอบในขั้นนี้ โดยไม่มี tool call เพิ่ม';
    wrapper.append(note);
  }
  return { wrapper, calls };
}

function toolStepDetail(event) {
  const wrapper = document.createElement('div');
  wrapper.className = 'execution-step-body';
  const note = document.createElement('p');
  note.className = 'execution-step-note';
  const ok = event?.detail?.ok !== false && event.type !== 'error';
  note.textContent = ok ? 'เครื่องมือส่งผลลัพธ์กลับมาแล้ว ด้านล่างคือหลักฐานที่ผ่านการปกปิดข้อมูลลับ' : 'เครื่องมือทำงานไม่สำเร็จ ตรวจ error และผลลัพธ์ด้านล่าง';
  const code = document.createElement('pre');
  code.className = 'execution-code';
  code.textContent = pretty(event.detail);
  wrapper.append(note, code);
  return wrapper;
}

function correctnessStepDetail(event) {
  const review = event?.detail || {};
  const wrapper = document.createElement('div');
  wrapper.className = 'execution-step-body';
  const note = document.createElement('p');
  note.className = 'execution-step-note';
  note.textContent = `${review.verdict || 'unknown'} · confidence ${review.confidence ?? '—'}/100 · ${review.summary || 'ไม่มีสรุปจาก verifier'}`;
  wrapper.append(note);
  const extra = {
    issues: review.issues || [],
    missingEvidence: review.missingEvidence || [],
    suggestedAction: review.suggestedAction || '',
  };
  const code = document.createElement('pre');
  code.className = 'execution-code';
  code.textContent = pretty(extra);
  wrapper.append(code);
  return wrapper;
}

function renderEvent(event, index) {
  const details = document.createElement('details');
  details.className = `execution-step ${event.type || 'assistant'}`;
  details.open = true;
  const summary = document.createElement('summary');
  const step = Number.isFinite(event.step) ? event.step : index + 1;

  if (event.type === 'assistant') {
    const { wrapper, calls } = assistantStepDetail(event);
    summary.textContent = calls.length
      ? `Step ${step} · Cherry เลือก ${calls.length} tool call${calls.length === 1 ? '' : 's'}`
      : `Step ${step} · Cherry สร้างคำตอบ`;
    details.append(summary, wrapper);
    return details;
  }

  if (event.type === 'correctness') {
    summary.textContent = `Step ${step} · ตรวจความถูกต้องของคำตอบ`;
    details.append(summary, correctnessStepDetail(event));
    return details;
  }

  summary.textContent = `Step ${step} · ${event.name || 'tool'} · ${event.type === 'error' ? 'ผิดพลาด' : 'ได้ผลลัพธ์'}`;
  details.append(summary, toolStepDetail(event));
  return details;
}

function decorateAnswer(data, startedAt, attempt = 0) {
  const node = lastAssistantMessage();
  const answer = typeof data.answer === 'string' ? data.answer : '';
  if ((!node || (answer && !node.textContent.includes(answer))) && attempt < 30) {
    setTimeout(() => decorateAnswer(data, startedAt, attempt + 1), 50);
    return;
  }
  if (!node || node.dataset.executionDecorated === '1') return;
  node.dataset.executionDecorated = '1';
  node.classList.add('has-execution-trail');
  node.querySelector('.cherry-live-status')?.remove();

  const trail = document.createElement('section');
  trail.className = 'execution-trail';
  const head = document.createElement('div');
  head.className = 'execution-trail-head';
  const title = document.createElement('strong');
  title.textContent = 'Execution Trail · ขั้นตอนการทำงานจริง';
  const note = document.createElement('span');
  const chatId = typeof data.chatId === 'string' ? data.chatId : '—';
  const logId = typeof data.logId === 'string' ? data.logId : (typeof data.traceId === 'string' ? data.traceId : '—');
  note.textContent = `chatId=${chatId}\nlogId=${logId}`;
  head.append(title, note);

  const list = document.createElement('div');
  list.className = 'execution-step-list';
  const trace = Array.isArray(data.trace) ? data.trace : [];
  if (trace.length) trace.forEach((event, index) => list.append(renderEvent(event, index)));
  else {
    const empty = document.createElement('div');
    empty.className = 'execution-step-note';
    empty.textContent = 'รอบนี้ไม่มี trace จาก agent';
    list.append(empty);
  }

  const summary = document.createElement('div');
  summary.className = 'execution-summary';
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const correctness = data.correctness || {};
  summary.textContent = `${data.steps ?? trace.length} agent steps · ${trace.length} trace events · ${correctness.status || 'unverified'} · confidence ${correctness.confidence ?? '—'}/100 · ${elapsed}s · logStored=${data.logStored === false ? 'no' : 'yes'}`;
  trail.append(head, list, summary);
  node.append(trail);
  node.closest('#chat')?.scrollTo({ top: node.closest('#chat').scrollHeight, behavior: 'smooth' });
}

function isChatRequest(input, init) {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : '';
  try {
    const url = new URL(raw, window.location.href);
    return method === 'POST' && url.origin === window.location.origin && url.pathname === CHAT_PATH;
  } catch {
    return false;
  }
}

injectStyles();
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  if (!isChatRequest(input, init)) return nativeFetch(input, init);
  const startedAt = Date.now();
  let stopTimer = null;
  queueMicrotask(() => { stopTimer = attachLiveStatus(startedAt); });
  try {
    const response = await nativeFetch(input, init);
    const clone = response.clone();
    void clone.text().then((raw) => {
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        if (data?.ok !== false) decorateAnswer(data, startedAt);
      } catch {
        // The original app keeps responsibility for showing malformed responses.
      }
    });
    return response;
  } finally {
    if (stopTimer) stopTimer();
  }
};
