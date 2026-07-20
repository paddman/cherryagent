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
- HTTP API
- Installable responsive PWA
- Docker support
- CI type checking and build
- Local-first authentication with scrypt password hashing, bearer sessions, audit events, and viewer/user/admin roles
- Cherry Report Studio: `.xlsx`/`.csv` upload, deterministic KPI/charts, aggregate-only AI insight, Thai PDF, evidence, and tenant isolation
- Persistent per-Chat-ID model sessions with secret redaction and serialized turns
- Paired Cherry Node execution for remote shell, process, system, and file work
- Dynamic MCP stdio and Streamable HTTP tools through the official MCP SDK
- Runtime-loaded `skills/*/SKILL.md` workflows, including `cherry-node-operator`

See [Cherry Gateway, Nodes, Sessions, and MCP](docs/CHERRY_GATEWAY_MCP.md) for pairing, daemon startup, MCP registration, security boundaries, and API examples.

## PWA work surfaces

The dashboard has eight work surfaces:

1. **Dashboard** — today, overdue work, active work, waiting work, reminders, alerts, quick planning, and timeline.
2. **Report Studio** — upload Excel/CSV or run a built-in sales sample, then inspect KPI, SVG charts, quality warnings, evidence, and a Thai PDF.
3. **Flow board** — drag work across `inbox`, `planned`, `doing`, `waiting`, and `done`.
4. **Office Inbox** — sync Gmail messages, triage them into tenant-scoped work items, and track usage credits.
5. **Reminder center** — create recurring schedules, inspect next runs, pause/resume schedules, read alerts, and snooze notifications.
6. **Engineer** — inspect active technical loops, current phase, iteration budget, evidence, outcomes, and learned runbooks.
7. **Deploy Flow (Advanced)** — launch an asynchronous Agent workflow, inspect the dependency topology, and follow live task/evidence progress over SSE.
8. **Ask Cherry** — natural-language tool calling across routed report, planner, engineer, connector, file, and memory tool packs.

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

## CherryAgent API authentication

Authentication is enabled by default. Set the initial admin credentials before the first server boot:

```env
CHERRY_AUTH_ENABLED=true
CHERRY_AUTH_ADMIN_EMAIL=padd@cherrydeskx.com
CHERRY_AUTH_ADMIN_PASSWORD=use-a-unique-password-with-at-least-12-characters
```

CherryAgent stores local users and hashed session state in `.cherry/auth.json`. See [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) for login, bearer-token API calls, roles, and the local development opt-out.

---

# API

## Health

```bash
curl http://localhost:8787/health
```

The response includes model, tool count, connectors, scheduler state, planner counts, Engineer Loop counts, and pending approvals.

All application API routes require `Authorization: Bearer <token>` when authentication is enabled. `/health` remains public for monitoring; see [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md).

## Report Studio

Create a sample report without any connector setup:

```bash
curl -X POST http://localhost:8787/reports/sample \
  -H 'Authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{}'
```

Upload a real workbook:

```bash
curl -X POST http://localhost:8787/reports \
  -H 'Authorization: Bearer <token>' \
  -F 'file=@sales.xlsx' \
  -F 'template=auto'
```

Generation runs asynchronously through `ingest → profile → analyze → visualize → pdf → verify`. Follow progress at `GET /reports/:id/events`, inspect the report at `GET /reports/:id`, and download the verified artifact at `GET /reports/:id/pdf`. Raw rows remain in the tenant workspace; only schema and aggregates are sent to the narrative model. See [`docs/REPORT_STUDIO.md`](docs/REPORT_STUDIO.md).

## Deploy Flow topology

Start an asynchronous dependency-aware Agent workflow:

```bash
curl -X POST http://localhost:8787/orchestrator/runs \
  -H 'Authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"goal":"Inspect the CherryAgent health endpoint and summarize verified findings","preferredRoles":["engineer"]}'
```

Inspect a run with `GET /orchestrator/runs/RUN_ID`. The live topology stream is available at `GET /orchestrator/runs/RUN_ID/events` as Server-Sent Events. Each task exposes its dependency IDs, status, progress step, active tool, handoff, and evidence records.

Every workflow has a traceable identity chain:

```text
jobId  →  runId + traceId  →  taskId + spanId  →  logId + sequence
```

Optional tags can be sent when starting a run:

```bash
curl -X POST http://localhost:8787/orchestrator/runs \
  -H 'Authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"goal":"Build a sales report","tags":["excel","report","urgent"]}'
```

The run snapshot includes recent structured logs. For a dedicated timeline use `GET /orchestrator/runs/RUN_ID/logs`; filter with `taskId`, `since`, and `limit`. Each log contains action, level, tool, step/maxSteps, tags, and compact event data. Logs are persisted in `.cherry/agentic.json` and also stream through the run SSE channel as `log.created` events.

## Enterprise workspace and Office Inbox

Cherry’s first enterprise wedge is **Inbox-to-Execution**: turn incoming work into an owned, scheduled task with a traceable result. The current control plane is tenant-aware and exposes organization context, RBAC, usage credits, and Office Inbox APIs:

```bash
curl http://localhost:8787/workspace/context \
  -H 'Authorization: Bearer <token>'

curl http://localhost:8787/office/inbox \
  -H 'Authorization: Bearer <token>'

curl -X POST http://localhost:8787/office/inbox/sync \
  -H 'Authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"query":"in:inbox newer_than:7d","maxResults":25}'

curl http://localhost:8787/usage/dashboard \
  -H 'Authorization: Bearer <token>'
```

Usage is measured as workflow/agent credits rather than exposing model token cost. The default pilot budget is 10,000 credits per tenant per calendar month; admins can update it with `POST /usage/budget`. See [`docs/ENTERPRISE_WORKFORCE.md`](docs/ENTERPRISE_WORKFORCE.md) for the tenant boundary, pilot wedge, and PostgreSQL migration contract.

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

- Engineer Loop currently orchestrates whatever real tools are installed. To perform SSH, Proxmox, VMware, Kubernetes, browser automation, or database repair, those tool packs must be added.
- The current pilot runtime persists tenant-scoped control-plane state in local JSON, suitable for a single-node MVP. The PostgreSQL/RLS schema contract is in [`database/postgres/001_enterprise_control_plane.sql`](database/postgres/001_enterprise_control_plane.sql); repositories, locks, audit logs, queues, and SSE fan-out should move to PostgreSQL/Redis before multi-node production.
- Browser notifications require a connected PWA client; full Web Push for completely disconnected clients is not yet implemented.
- Email, LINE, Slack, and webhook delivery require corresponding configuration.
- Notification delivery results are logged but not yet persisted as a per-channel delivery history on each alert.

# Product direction

Priority next layers:

1. PostgreSQL/Redis repositories, locks, queues, audit export, and tenant isolation enforcement
2. SSH + Proxmox + VMware + Docker + Kubernetes engineer tools
3. Playwright browser automation
4. Google Docs, Sheets, Slides
5. Microsoft 365, Teams, Outlook, OneDrive
6. PDF/DOCX/XLSX/PPTX generation and editing
7. Web Push and device-specific background notification workers
8. Meeting capture, transcript, summary, decisions, and follow-up
9. Daily briefing, overdue-task hunting, and proactive work queue
10. Scoped autonomous office/ops autopilot with approval budgets

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the target design.
