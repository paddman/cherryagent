# CherryAgent

**Tool-calling-first AI office secretary that can read, think, act, verify, remember, and work across devices.**

CherryAgent is designed as an AI secretary for daily office work: email, calendar, Drive files, documents, spreadsheets, reports, approvals, browser tasks, internal systems, notifications, and infrastructure workflows.

The core principle is simple:

> **The model should not just answer. It should choose tools, execute work, inspect results, recover from errors, and only claim success after verification.**

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
- Approval inbox for external and dangerous actions
- Persistent local JSON memory
- Built-in office task and note tools
- Built-in workspace file tools
- Current-time and calculator tools
- Gmail search/read/draft/send/reply/archive tools
- Google Calendar list/create/update/delete tools
- Google Drive search/read/create-text/move tools
- HTTP API
- Installable PWA chat client
- Approval drawer with Approve & run / Deny actions
- Health and tool discovery endpoints
- Docker support
- CI type checking and build

## Tool packs

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
                 |  Plan -> Tool  |
                 |  -> Observe    |
                 |  -> Verify     |
                 +-------+--------+
                         |
             +-----------+-----------+
             |           |           |
             v           v           v
          Memory      Approval     Tool Registry
                         |              |
                         v              v
                  Approval Inbox   Office / Files /
                  Approve & run    Gmail / Calendar /
                                   Drive / Browser
```

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

For the HTTP server and PWA:

```bash
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

The response includes model, tool count, connector status, and pending approval count.

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
  -d '{"message":"Find unread important email from this week and summarize what needs my attention"}'
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

By default, `external` and `dangerous` tools require approval. This keeps the agent useful without letting it silently send mail, delete calendar events, move Drive files, pay money, or change production systems.

## Product direction

CherryAgent should become an **office operating agent**, not just a chatbot.

Priority tool packs:

1. Google Docs, Sheets, Slides
2. Microsoft 365, Teams, Outlook, OneDrive
3. Browser automation with Playwright
4. PDF/DOCX/XLSX/PPTX generation and editing
5. LINE/Slack/Telegram notification and command channels
6. Meeting capture, transcript, summary, decisions, and follow-up
7. Daily briefing, overdue-task hunting, proactive work queue
8. Internal API, database, SSH, Proxmox, VMware, monitoring, ticketing
9. Skill/runbook learning from successful incidents
10. Autonomous office autopilot with approval budgets and audit logs

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the target design.
