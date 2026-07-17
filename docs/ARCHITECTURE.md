# CherryAgent Architecture

## Product thesis

CherryAgent is an **office operating agent**. The core product is not chat. The core product is a controlled execution loop that can select tools, perform work, inspect results, retry when appropriate, verify outcomes, remember useful context, and maintain an audit trail.

## Language and device strategy

### Primary language: TypeScript

TypeScript is the main language for:

- agent core
- tool contracts
- HTTP API
- PWA frontend
- browser automation
- office connectors
- local desktop/mobile UI layer
- shared schemas and SDKs

### Cross-device delivery

1. **PWA baseline** — immediate access from modern desktop and mobile browsers.
2. **Tauri 2 wrapper** — native Windows, macOS, Linux, Android, and iOS packaging for deeper OS integration.
3. **Server/headless mode** — run CherryAgent as a service for teams, automations, and 24/7 workflows.
4. **Remote tool workers** — expose tools from private networks or devices without moving the LLM.

## Core loop

```text
User request
    |
    v
LLM receives conversation + tool schemas
    |
    +--> final answer ------------------------------+
    |                                               |
    +--> tool call                                  |
           |                                        |
           v                                        |
      Approval Gate                                 |
           |                                        |
           v                                        |
      Tool execution                                |
           |                                        |
           v                                        |
      Structured result/error                       |
           |                                        |
           +--> back to LLM --> next tool / retry --+
```

The loop is bounded by `CHERRY_MAX_STEPS` to prevent runaway execution.

## Tool contract

Every tool has:

- unique name
- precise description
- JSON-schema parameters
- risk level
- async executor

Risk levels:

| Risk | Meaning | Default |
|---|---|---|
| `safe` | Read-only/local utility | Auto-approved |
| `write` | Controlled local write | Auto-approved |
| `external` | Changes or sends to another service | Approval required |
| `dangerous` | Destructive/high-impact action | Approval required |

## Tool packs

### Office Core

Current:

- create task
- list tasks
- complete task
- save note
- remember fact
- recall fact

Next:

- recurring tasks
- priorities
- projects
- dependencies
- reminders
- daily briefing
- overdue-task hunter
- autonomous work queue

### Google Workspace

Current:

- Gmail search/read/draft/send/reply/archive
- Calendar list/create/update/delete
- Drive search/read/create-text/move
- Docs create/read/append-text
- Sheets create/read/update-range/append-row (formulas supported as cell values)
- Slides create/read/append-slide

Target (not yet implemented):

- Gmail forward/label
- Calendar free-busy/respond
- Drive upload (binary)/share
- Sheets charts
- Slides export-to-PDF and richer layout/image editing

Sending mail, external sharing, and destructive actions must remain approval-gated.

### Microsoft 365

Target tools:

- Outlook
- Calendar
- OneDrive
- Word
- Excel
- PowerPoint
- Teams

### Documents

Target capabilities:

- PDF extract/edit/generate/signature workflow
- DOCX create/edit/style
- XLSX read/write/formulas/charts
- PPTX create/edit
- OCR/vision
- report generation from mixed files

### Browser

Playwright-based tools:

- navigate
- inspect page
- click
- type
- upload/download
- take screenshot
- extract table
- wait for condition

Browser tools should isolate sessions and redact secrets from traces.

### Communications

Target channels:

- LINE
- Slack
- Microsoft Teams
- Telegram
- Discord
- SMS gateways
- voice/call center adapters

### Infrastructure and Ops

Optional tool packs:

- SSH
- Proxmox
- VMware/vCenter
- Kubernetes
- Docker
- Grafana
- Prometheus
- Cloudflare
- DNS
- firewall/network APIs
- ticketing

High-impact infrastructure changes must use explicit scopes, approvals, dry-run support, verification, and rollback instructions.

## Memory model

The MVP uses local JSON memory for simplicity. Production target:

```text
Short-term conversation memory
            |
            v
     Session working state
            |
            v
Durable structured memory
(tasks, preferences, contacts, projects, facts)
            |
            v
Semantic memory / retrieval
(files, mail, docs, runbooks, incidents)
```

Recommended production storage:

- PostgreSQL for structured state
- pgvector or dedicated vector store for retrieval
- Redis for ephemeral queues and locks
- MinIO/S3 for artifacts

## Autonomy model

CherryAgent should support four autonomy levels:

### Level 0 — Answer only
No tools.

### Level 1 — Assist
Read tools and local writes.

### Level 2 — Act with approval
External actions are proposed and require approval.

### Level 3 — Scoped autopilot
Pre-approved policies allow selected actions inside budgets, time windows, recipients, projects, or environments.

Example:

```text
Allowed:
- draft email to anyone
- send internal email to @company.com
- create calendar events without guests
- create tasks and notes

Approval required:
- email external domain
- add external attendees
- delete files
- production infrastructure changes
```

## Proactive office autopilot

The long-term scheduler should create its own candidate work from signals:

- unread important email
- upcoming meeting without preparation
- overdue task
- document waiting for review
- incident without runbook update
- failed automation
- unanswered customer thread
- KPI anomaly

Candidate jobs enter a work queue with:

- objective
- source signal
- expected value
- risk
- estimated tool cost
- deadline
- approval policy

The agent then chooses the best next job instead of waiting for a direct prompt.

## Verification contract

Every consequential tool should return explicit verification fields where possible.

Examples:

```json
{
  "ok": true,
  "messageId": "...",
  "verified": true
}
```

```json
{
  "ok": true,
  "path": "reports/weekly.md",
  "bytes": 4821,
  "verified": true
}
```

The model is instructed never to claim success without a successful tool result.

## Error recovery

Tools should return structured errors. The model can then:

1. inspect the error
2. adjust arguments
3. select a different tool
4. retry if safe
5. ask for approval or missing access only when necessary
6. stop after bounded attempts

## Audit log target

Production execution should record:

- timestamp
- user/session
- model
- prompt hash
- tool name
- arguments with secret redaction
- risk level
- approval decision
- duration
- output summary
- verification result
- error/rollback data

## Runbook learning

When an incident is successfully resolved, CherryAgent should capture:

- symptoms
- root cause
- fix
- diagnostic commands
- verification steps
- rollback
- prevention

This becomes a reusable Skill/Runbook for later incidents.

## Recommended next implementation order

1. Gmail + Google Calendar tools
2. Playwright browser worker
3. PostgreSQL memory + audit log
4. approval inbox UI
5. document generation pack
6. proactive work queue and scheduler
7. Tauri 2 native packaging
8. LINE/Slack/Teams channels
9. ops tool packs
10. self-improving skill/runbook capture
