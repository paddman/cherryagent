# CherryAgent

**Tool-calling-first AI office secretary that can read, think, plan, act, verify, remember, schedule work, and operate across devices.**

CherryAgent is designed as an AI secretary and office operating agent for daily work: planning, flow management, reminders, email, calendar, Drive files, documents, reports, approvals, notifications, browser tasks, internal systems, and infrastructure workflows.

The core principle is simple:

> **The model should not just answer. It should choose tools, execute work, inspect results, recover from errors, schedule follow-ups, and only claim success after verification.**

## Why TypeScript

CherryAgent uses TypeScript as the primary language because one codebase can cover:

- Web and installable PWA
- Windows, macOS, Linux
- iOS and Android through native wrappers
- Node.js server and local agent runtime
- Cloudflare/Bun/Deno-compatible adapters later
- Browser automation, office APIs, MCP, AI SDKs, and native wrappers

The first cross-device target is an **installable PWA**. Native packaging with **Tauri 2** is the next layer for deeper OS integration.

## Current capabilities

Already included:

- Autonomous multi-step agent loop
- OpenAI-compatible LLM provider for Qwen/vLLM/SGLang/Ollama/OpenAI-compatible endpoints
- Native tool registry with JSON-schema tool definitions
- Tool execution loop with result feedback to the model
- Office planner dashboard
- Kanban-style flow board with drag-and-drop status changes
- Today timeline, overdue queue, upcoming work, priorities, tags, dependencies, duration, start time, and deadlines
- Persistent reminder scheduler
- One-time, interval, daily, weekdays, weekly, monthly, and 5-field cron schedules
- Timezone-aware schedules with `Asia/Bangkok` as the default
- Durable in-app alert inbox
- Browser notifications in the PWA
- Snooze controls and reminder enable/disable controls
- Optional scheduled delivery through Gmail, LINE Messaging API, Slack webhook, and generic webhook
- Approval inbox for external and dangerous actions
- Persistent local JSON memory
- Built-in office task and note tools
- Built-in workspace file tools
- Current-time and calculator tools
- Gmail search/read/draft/send/reply/archive tools
- Google Calendar list/create/update/delete tools
- Google Drive search/read/create-text/move tools
- HTTP API
- Installable responsive PWA
- Health and tool discovery endpoints
- Docker support
- CI type checking and build

## Planner dashboard

The PWA now has four primary work surfaces:

1. **Dashboard** — today, overdue work, active work, waiting work, active reminders, unread alerts, quick planning, and timeline.
2. **Flow board** — drag work across `inbox`, `planned`, `doing`, `waiting`, and `done`.
3. **Reminder center** — create recurring schedules, inspect next runs, pause/resume schedules, read alerts, and snooze notifications.
4. **Ask Cherry** — use natural language and tool calling to create plans, move work, schedule reminders, inspect office data, and execute multi-step tasks.

### Flow states

```text
inbox -> planned -> doing -> waiting -> done
             ^          |
             +----------+
```

- `inbox` — captured but not yet triaged
- `planned` — committed work
- `doing` — actively in progress
- `waiting` — blocked or delegated
- `done` — complete
- `cancelled` — no longer active

Planner items can also carry:

- priority: `low`, `normal`, `high`, `urgent`
- start time
- due time
- duration
- timezone
- tags
- flow/project ID
- dependencies with cycle protection

## Reminder scheduler

Supported schedule kinds:

| Kind | Example |
|---|---|
| `once` | Run once at a specific ISO 8601 time |
| `interval` | Every 30 minutes |
| `daily` | Every day at 09:00 |
| `weekdays` | Monday-Friday at 08:30 |
| `weekly` | Monday, Wednesday, Friday at 17:00 |
| `monthly` | Day 1 of every month at 09:00 |
| `cron` | `0 9 * * 1-5` |

The scheduler runs inside the server process and checks due reminders every 15 seconds by default. Change it with:

```env
CHERRY_SCHEDULER_INTERVAL_MS=15000
```

Planner data persists by default at:

```env
CHERRY_PLANNER_FILE=.cherry/planner.json
```

## Notification channels

### Built in without extra server configuration

- `in_app` — durable alert inbox in the planner dashboard
- `browser` — PWA browser notifications after the user grants permission

### Optional server-side delivery

- `email` — Gmail through the configured Google Workspace connector
- `line` — LINE Messaging API push
- `slack` — Slack incoming webhook
- `webhook` — generic JSON webhook receiving `planner.alert` events

Configure optional channels:

```env
CHERRY_NOTIFY_EMAIL_TO=
CHERRY_NOTIFY_SLACK_WEBHOOK=
CHERRY_NOTIFY_WEBHOOK_URL=
CHERRY_NOTIFY_LINE_CHANNEL_ACCESS_TOKEN=
CHERRY_NOTIFY_LINE_TO=
```

For agent tool calls, in-app/browser reminders use a normal `write` tool. A schedule that can later send email, LINE, Slack, or webhook notifications uses an `external` tool and enters the approval inbox before creation.

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

Example natural-language requests:

```text
Plan my weekly IDC report for Friday at 15:00, make it high priority, and remind me 2 hours before.
```

```text
Every weekday at 08:30 remind me to review incidents and overdue tasks.
```

```text
Create a monthly reminder on day 1 at 09:00 and notify me through LINE.
```

```text
Show my dashboard, find overdue work, and move the most urgent task into Doing.
```

## Office and Google Workspace tool packs

### Gmail

- `gmail_search`
- `gmail_read_message`
- `gmail_create_draft`
- `gmail_send_email`
- `gmail_reply`
- `gmail_archive`

### Google Calendar

- `calendar_list_events`
- `calendar_create_event`
- `calendar_update_event`
- `calendar_delete_event`

### Google Drive

- `drive_search_files`
- `drive_read_file`
- `drive_create_text_file`
- `drive_move_file`

The default safety policy auto-approves `safe` and `write` tools. External and dangerous actions enter the approval inbox instead of executing silently.

## Architecture

```text
User / PWA / Native App / API / LINE / Slack / Teams
                         |
                         v
                 +----------------+
                 |  Cherry Agent  |
                 | Plan -> Tool   |
                 | -> Observe     |
                 | -> Verify      |
                 +-------+--------+
                         |
        +----------------+----------------+
        |                |                |
        v                v                v
     Planner          Approval         Tool Registry
        |                |                |
        v                v                v
 Flow / Timeline    Approval Inbox   Office / Files /
 Reminders / Alerts  Approve & run   Gmail / Calendar /
 Scheduler / Snooze                  Drive / Planner
        |
        v
 Notification Dispatcher
 in-app / browser / email / LINE / Slack / webhook
```

## Quick start

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

Run an OpenAI-compatible endpoint such as vLLM or SGLang, then configure:

```env
CHERRY_LLM_BASE_URL=http://127.0.0.1:8000/v1
CHERRY_LLM_API_KEY=local
CHERRY_LLM_MODEL=qwen3.6-27b
```

CherryAgent sends tool definitions to the model and automatically executes returned tool calls.

## Connect Google Workspace

Recommended for a long-running server:

```env
CHERRY_GOOGLE_CLIENT_ID=your-oauth-client-id
CHERRY_GOOGLE_CLIENT_SECRET=your-oauth-client-secret
CHERRY_GOOGLE_REFRESH_TOKEN=your-refresh-token
```

For short-lived testing, an access token is also supported:

```env
CHERRY_GOOGLE_ACCESS_TOKEN=temporary-access-token
```

CherryAgent refreshes OAuth access tokens automatically when client ID, client secret, and refresh token are configured.

Typical Google OAuth scopes for the current tool pack include Gmail, Calendar, and Drive scopes appropriate to the actions you enable. Use the minimum scopes needed for your deployment.

## API

### Health

```bash
curl http://localhost:8787/health
```

The response includes model, tool count, connector status, scheduler state, active reminder count, unread alert count, and pending approval count.

### Planner dashboard

```bash
curl http://localhost:8787/planner/dashboard
```

### Create a plan item

```bash
curl -X POST http://localhost:8787/planner/items \
  -H 'content-type: application/json' \
  -d '{"title":"Prepare weekly IDC report","priority":"high","status":"planned","dueAt":"2026-07-10T15:00:00+07:00"}'
```

### Create a recurring reminder

```bash
curl -X POST http://localhost:8787/planner/reminders \
  -H 'content-type: application/json' \
  -d '{"title":"Morning incident review","schedule":{"kind":"weekdays","time":"08:30","timezone":"Asia/Bangkok"},"channels":["in_app","browser"]}'
```

### Read alerts

```bash
curl 'http://localhost:8787/planner/alerts?unread=true'
```

### Snooze an alert

```bash
curl -X POST http://localhost:8787/planner/alerts/ALERT_ID/snooze \
  -H 'content-type: application/json' \
  -d '{"minutes":60}'
```

### List tools

```bash
curl http://localhost:8787/tools
```

### Approval inbox

```bash
curl http://localhost:8787/approvals
```

Approve and execute one pending action:

```bash
curl -X POST http://localhost:8787/approvals/APPROVAL_ID/approve
```

Deny one pending action:

```bash
curl -X POST http://localhost:8787/approvals/APPROVAL_ID/deny
```

### Chat

```bash
curl -X POST http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{"message":"Plan my weekly report for Friday afternoon and remind me two hours before"}'
```

## Approval lifecycle

```text
Tool request
    |
    v
Risk check
    |
    +--> safe/write auto-approved
    |
    +--> external/dangerous
              |
              v
          pending
              |
       +------+------+
       |             |
     deny          approve
                     |
                     v
                 executing
                     |
              +------+------+
              |             |
           executed       failed
```

Duplicate pending requests from the same session, tool, and arguments are deduplicated to avoid approval spam.

## Safety model

Tools have risk levels:

- `safe` — read-only/local reasoning utility
- `write` — controlled local writes or draft creation
- `external` — sends, posts, or changes an external service
- `dangerous` — destructive or high-impact action

By default, `external` and `dangerous` tools require approval. This keeps the agent useful without letting it silently send mail, create external notification schedules, delete calendar events, move Drive files, pay money, or change production systems.

## Current limitations

- Browser notifications are surfaced by connected PWA clients; a full Web Push subscription service for notifications while every client is completely disconnected is not implemented yet.
- Server-side email, LINE, Slack, and webhook delivery requires the corresponding environment configuration.
- The current planner store is local JSON, suitable for a single-node MVP. Multi-user production deployment should move planner state, locking, audit logs, and queues to PostgreSQL/Redis.
- Notification delivery results are logged by the runtime but are not yet persisted as a per-channel delivery history on each alert.

## Product direction

CherryAgent should become an **office operating agent**, not just a chatbot.

Priority tool packs:

1. Google Docs, Sheets, Slides
2. Microsoft 365, Teams, Outlook, OneDrive
3. Browser automation with Playwright
4. PDF/DOCX/XLSX/PPTX generation and editing
5. Web Push and device-specific background notification workers
6. Meeting capture, transcript, summary, decisions, and follow-up
7. Daily briefing, overdue-task hunting, proactive work queue
8. Internal API, database, SSH, Proxmox, VMware, monitoring, ticketing
9. Skill/runbook learning from successful incidents
10. Autonomous office autopilot with approval budgets and audit logs

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the target design.
