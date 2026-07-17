# CherryAgent

**Tool-calling-first AI office secretary, planner, engineer, and operations agent that can read, think, plan, act, verify, remember, schedule work, solve technical problems, and operate across devices.**

CherryAgent is designed as an **office operating agent**, not merely a chatbot. It combines office planning, reminders, Gmail, Calendar, Drive, approvals, notifications, and a persistent Engineer Loop Engine for incidents, debugging, code changes, infrastructure work, and self-repair.

The core principle:

> **The model should not just answer. It should choose tools, execute work, inspect results, recover from errors, verify with evidence, learn from success, and only claim completion after proof.**

## Why TypeScript

TypeScript is the primary language so one codebase can cover:

- Web and installable PWA
- Windows, macOS, Linux
- iOS and Android through native wrappers
- Node.js server and local agent runtime
- Browser automation and office APIs
- MCP, AI SDKs, native wrappers, and remote tool workers

The first cross-device target is an **installable PWA**. Tauri 2 is the next native layer for deeper operating-system integration.

## Current capabilities

Already included:

- Autonomous multi-step agent loop
- OpenAI-compatible LLM provider for Qwen/vLLM/SGLang/Ollama-compatible endpoints
- Native tool registry with JSON-schema tool definitions
- Tool execution with observation feedback and bounded retries
- **Engineer Loop Engine with strict phase state machine**
- Engineer evidence trace, retry budget, block/resume, fail/abort, and verified completion
- Automatic reusable Runbook capture after successful verification
- Office planner dashboard
- Kanban flow board with drag-and-drop status changes
- Today timeline, overdue queue, upcoming work, priorities, tags, dependencies, duration, start time, and deadlines
- Persistent reminder scheduler
- One-time, interval, daily, weekdays, weekly, monthly, and 5-field cron schedules
- Timezone-aware schedules with `Asia/Bangkok` as the default
- Durable in-app alert inbox
- Browser notifications in the PWA
- Snooze and reminder enable/disable controls
- Optional scheduled delivery through Gmail, LINE Messaging API, Slack webhook, and generic webhook
- Approval inbox for external and dangerous actions
- Persistent local JSON memory
- Gmail search/read/draft/send/reply/archive tools
- Google Calendar list/create/update/delete tools
- Google Drive search/read/create-text/move tools
- Google Docs create/read/append-text tools
- Google Sheets create/read/update-range/append-row tools
- Google Slides create/read/append-slide tools
- Local PDF create/append-page/read tools
- Local DOCX create/read tools
- Local XLSX create/read/update-range tools (formula support)
- Local PPTX create/read tools
- HTTP API
- Installable responsive PWA
- Docker support
- CI type checking and build

## PWA work surfaces

The dashboard has five primary work surfaces:

1. **Dashboard** — today, overdue work, active work, waiting work, reminders, alerts, quick planning, and timeline.
2. **Flow board** — drag work across `inbox`, `planned`, `doing`, `waiting`, and `done`.
3. **Reminder center** — create recurring schedules, inspect next runs, pause/resume schedules, read alerts, and snooze notifications.
4. **Engineer** — inspect active technical loops, current phase, iteration budget, evidence, outcomes, and learned runbooks.
5. **Ask Cherry** — natural-language tool calling across planner, engineer, Gmail, Calendar, Drive, files, memory, approvals, and other tools.

---

# Engineer Loop Engine

For incidents, debugging, code changes, infrastructure work, technical troubleshooting, or self-repair, CherryAgent uses a strict bounded engineering loop:

```text
Plan
  ↓
Execute
  ↓
Observe
  ↓
Diagnose
  ↓
Patch
  ↓
Test
  ↓
Verify
  ↓
Learn
```

A loop cannot be completed successfully without **verification evidence**.

Typical evidence:

- command output
- HTTP/API response
- health check result
- test result
- file content
- service status
- metric or monitoring result
- tool-confirmed external state

CherryAgent is explicitly instructed not to invent verification evidence.

## Engineer loop state

Each loop persists:

- objective
- observable success criteria
- current phase
- current iteration
- maximum iteration budget
- status: `running`, `blocked`, `succeeded`, `failed`, or `aborted`
- hypothesis
- full phase event history
- tool/command used
- errors
- evidence
- verification evidence
- root cause
- fix
- rollback
- prevention
- completion reason

Default persistent state file:

```env
CHERRY_ENGINEER_FILE=.cherry/engineer.json
```

## Retry budget and stop conditions

Engineer loops are bounded. Default agent tool-step budget:

```env
CHERRY_MAX_STEPS=24
```

Each Engineer Loop also has its own `maxIterations`, between 1 and 25.

The loop should stop or pause when:

- success criteria are verified
- retry budget is exhausted
- safety policy blocks the required action
- approval is required
- credentials or access are missing
- an external dependency is unavailable
- a maintenance window is required
- a human decision is required

Blocked loops preserve the exact current phase and can later resume.

## Engineer phase transitions

Allowed transitions are deliberately constrained:

```text
plan      -> execute
execute   -> observe
observe   -> diagnose | verify
diagnose  -> patch | execute
patch     -> test
test      -> observe | verify
verify    -> learn | diagnose
learn     -> complete
```

Failed testing or failed verification can consume another bounded iteration through `engineer_next_iteration`.

## Automatic Runbook learning

After verified success and the `learn` phase, `engineer_complete_loop` automatically creates a reusable Runbook containing:

- symptoms
- root cause
- fix
- diagnostic evidence
- verification evidence
- rollback
- prevention

This follows the project policy that successful incidents should become reusable operational knowledge.

## Engineer tool pack

- `engineer_start_loop`
- `engineer_get_loop`
- `engineer_list_loops`
- `engineer_record_phase`
- `engineer_next_iteration`
- `engineer_block_loop`
- `engineer_resume_loop`
- `engineer_complete_loop`
- `engineer_fail_loop`
- `engineer_abort_loop`
- `engineer_get_dashboard`
- `engineer_list_runbooks`

Example request:

```text
HTTP 524 on the Cherry trading journal. Find the root cause, fix it, verify response time, and save the successful incident as a runbook.
```

Expected operating pattern:

```text
engineer_start_loop
        ↓
record plan
        ↓
real diagnostic tools
        ↓
record execute / observe
        ↓
diagnose
        ↓
real patch tools
        ↓
test
        ↓
verify with real evidence
        ↓
learn
        ↓
engineer_complete_loop
        ↓
automatic reusable runbook
```

---

# Planner dashboard

## Flow states

```text
inbox -> planned -> doing -> waiting -> done
             ^          |
             +----------+
```

- `inbox` — captured but not triaged
- `planned` — committed work
- `doing` — actively in progress
- `waiting` — blocked or delegated
- `done` — verified complete
- `cancelled` — no longer active

Planner items can carry:

- priority: `low`, `normal`, `high`, `urgent`
- start time
- due time
- duration
- timezone
- tags
- flow/project ID
- dependencies with cycle protection

## Planner tool pack

- `planner_get_dashboard`
- `planner_create_item`
- `planner_list_items`
- `planner_update_item_status`
- `planner_add_dependency`
- `planner_create_reminder`
- `planner_create_external_reminder`
- `planner_list_reminders`
- `planner_set_reminder_enabled`
- `planner_snooze_alert`
- `planner_mark_alert_read`

---

# Reminder scheduler

Supported schedules:

| Kind | Example |
|---|---|
| `once` | Run once at a specific ISO 8601 time |
| `interval` | Every 30 minutes |
| `daily` | Every day at 09:00 |
| `weekdays` | Monday-Friday at 08:30 |
| `weekly` | Monday, Wednesday, Friday at 17:00 |
| `monthly` | Day 1 of every month at 09:00 |
| `cron` | `0 9 * * 1-5` |

Default scheduler interval:

```env
CHERRY_SCHEDULER_INTERVAL_MS=15000
```

Planner persistence:

```env
CHERRY_PLANNER_FILE=.cherry/planner.json
```

## Notification channels

Built in without extra server configuration:

- `in_app`
- `browser`

Optional server-side delivery:

- `email` — Gmail
- `line` — LINE Messaging API push
- `slack` — Slack incoming webhook
- `webhook` — generic JSON webhook

Configuration:

```env
CHERRY_NOTIFY_EMAIL_TO=
CHERRY_NOTIFY_SLACK_WEBHOOK=
CHERRY_NOTIFY_WEBHOOK_URL=
CHERRY_NOTIFY_LINE_CHANNEL_ACCESS_TOKEN=
CHERRY_NOTIFY_LINE_TO=
```

External notification schedules use an `external` risk tool and should enter the approval inbox before creation.

---

# Google Workspace tools

## Gmail

- `gmail_search`
- `gmail_read_message`
- `gmail_create_draft`
- `gmail_send_email`
- `gmail_reply`
- `gmail_archive`

## Google Calendar

- `calendar_list_events`
- `calendar_create_event`
- `calendar_update_event`
- `calendar_delete_event`

## Google Drive

- `drive_search_files`
- `drive_read_file`
- `drive_create_text_file`
- `drive_move_file`

## Google Docs

- `docs_create`
- `docs_read`
- `docs_append_text`

## Google Sheets

- `sheets_create`
- `sheets_read`
- `sheets_update_range`
- `sheets_append_row`

## Google Slides

- `slides_create`
- `slides_read`
- `slides_append_slide`

---

# Local document tools

Local PDF/DOCX/XLSX/PPTX generation and editing, sandboxed inside `CHERRY_WORKSPACE`
alongside `files_*` tools. Unlike the Google Workspace pack these require no
external auth or network access.

## PDF

- `documents_create_pdf`
- `documents_append_pdf_page`
- `documents_read_pdf`

## Word (DOCX)

- `documents_create_docx`
- `documents_read_docx`

DOCX editing is limited to creating a new file; in-place editing of an
existing `.docx` is not yet supported.

## Excel (XLSX)

- `documents_create_xlsx`
- `documents_read_xlsx`
- `documents_update_xlsx_range`

Cells accept plain values or `{"formula": "SUM(A1:A5)"}` objects. Chart
creation is not yet supported.

## PowerPoint (PPTX)

- `documents_create_pptx`
- `documents_read_pptx`

PPTX editing is limited to creating a new file; appending a slide to an
existing `.pptx` is not yet supported (unlike Google Slides' native API,
no pure-JS library can safely modify an existing OOXML presentation).

---

# Architecture

```text
User / PWA / Native App / API / LINE / Slack / Teams
                         |
                         v
                 +----------------+
                 |  Cherry Agent  |
                 | Tool Calling   |
                 | Observe/Verify |
                 +-------+--------+
                         |
       +-----------------+------------------+
       |                 |                  |
       v                 v                  v
    Planner          Engineer Loop       Approval
       |                 |                  |
       v                 v                  v
 Flow / Timeline    8-phase state       Approval Inbox
 Reminders / Alerts Evidence / Retry     Approve & run
 Scheduler / Snooze Runbook learning
       |
       v
 Notification Dispatcher
 in-app / browser / email / LINE / Slack / webhook

                         |
                         v
                   Tool Registry
                         |
      +------------------+-------------------+
      |          |           |               |
    Files      Gmail      Calendar          Drive
```

# Quick start

```bash
cp .env.example .env
npm install
npm run server
```

Open:

```text
http://localhost:8787
```

## Local Qwen example

```env
CHERRY_LLM_BASE_URL=http://127.0.0.1:8000/v1
CHERRY_LLM_API_KEY=local
CHERRY_LLM_MODEL=qwen3.6-27b
CHERRY_MAX_STEPS=24
```

CherryAgent sends tool definitions to the model and executes returned tool calls through the risk-aware tool registry.

## Google Workspace authentication

Recommended for long-running servers:

```env
CHERRY_GOOGLE_CLIENT_ID=your-oauth-client-id
CHERRY_GOOGLE_CLIENT_SECRET=your-oauth-client-secret
CHERRY_GOOGLE_REFRESH_TOKEN=your-refresh-token
```

Short-lived testing:

```env
CHERRY_GOOGLE_ACCESS_TOKEN=temporary-access-token
```

---

# API

## Health

```bash
curl http://localhost:8787/health
```

The response includes model, tool count, connectors, scheduler state, planner counts, Engineer Loop counts, and pending approvals.

## Engineer dashboard

```bash
curl http://localhost:8787/engineer/dashboard
```

## Start an Engineer Loop

```bash
curl -X POST http://localhost:8787/engineer/loops \
  -H 'content-type: application/json' \
  -d '{
    "objective":"Fix HTTP 524 on the trading journal",
    "successCriteria":[
      "Health endpoint returns HTTP 200",
      "Journal request completes under proxy timeout",
      "No new 524 during verification"
    ],
    "maxIterations":5,
    "hypothesis":"Long synchronous request exceeds proxy timeout"
  }'
```

## Record an Engineer phase

```bash
curl -X POST http://localhost:8787/engineer/loops/LOOP_ID/phase \
  -H 'content-type: application/json' \
  -d '{
    "phase":"plan",
    "summary":"Inspect upstream latency and timeout chain",
    "nextPhase":"execute"
  }'
```

## List Engineer runbooks

```bash
curl http://localhost:8787/engineer/runbooks
```

## Planner dashboard

```bash
curl http://localhost:8787/planner/dashboard
```

## Create a recurring reminder

```bash
curl -X POST http://localhost:8787/planner/reminders \
  -H 'content-type: application/json' \
  -d '{"title":"Morning incident review","schedule":{"kind":"weekdays","time":"08:30","timezone":"Asia/Bangkok"},"channels":["in_app","browser"]}'
```

## Approval inbox

```bash
curl http://localhost:8787/approvals
```

Approve and execute:

```bash
curl -X POST http://localhost:8787/approvals/APPROVAL_ID/approve
```

## Chat

```bash
curl -X POST http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{"message":"Investigate this incident through the Engineer Loop, verify the fix, and capture the runbook"}'
```

---

# Safety model

Tools have four risk levels:

- `safe` — read-only/local utility
- `write` — controlled local writes or draft/state creation
- `external` — sends, posts, or changes an external service
- `dangerous` — destructive or high-impact action

By default:

```env
CHERRY_AUTO_APPROVE=safe,write
```

External and dangerous actions require approval. Engineer Loop tracking does not bypass tool risk policies; consequential real actions still pass through the normal approval gate.

# Current limitations

- SSH, Proxmox, and vSphere/VMware tool packs exist; Kubernetes, Docker orchestration, Grafana, Prometheus, Cloudflare, DNS, firewall, and ticketing tool packs are not yet added.
- Browser automation (Playwright) is not yet implemented.
- Microsoft 365 (Outlook, Teams, OneDrive, Word, Excel, PowerPoint) is not yet implemented.
- Local PDF/DOCX/XLSX/PPTX generation exists (`documents_*` tools), but DOCX and PPTX support create/read only — no in-place editing of an existing file, since no pure-JS library can safely round-trip those OOXML formats. PDF and XLSX support real edits (append page, update range). OCR/vision, PDF signature workflows, and Excel charts are not yet implemented.
- Google Sheets chart creation and Google Slides export-to-PDF are not yet implemented; sheet formulas are supported through cell values.
- Engineer and planner state currently use local JSON, suitable for a single-node MVP. Multi-user production should move state, locks, audit logs, and queues to PostgreSQL/Redis.
- Browser notifications require a connected PWA client; full Web Push for completely disconnected clients is not yet implemented.
- Email, LINE, Slack, and webhook delivery require corresponding configuration.
- Notification delivery results are logged but not yet persisted as a per-channel delivery history on each alert.
- No proactive autopilot yet: daily briefing, overdue-task hunting, and autonomous work-queue generation from signals are not yet implemented.

# Product direction

Priority next layers:

1. Playwright browser automation
2. PostgreSQL/Redis state, locks, queues, and audit logs
3. Microsoft 365, Teams, Outlook, OneDrive
4. In-place DOCX/PPTX editing, PDF signature workflows, Excel charts, and OCR/vision
5. Kubernetes, Docker, Grafana, Prometheus, Cloudflare/DNS/firewall, ticketing tool packs
6. Web Push and device-specific background notification workers
7. Meeting capture, transcript, summary, decisions, and follow-up
8. Daily briefing, overdue-task hunting, and proactive work queue
9. Scoped autonomous office/ops autopilot with approval budgets

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the target design.
