# CherryAgent

**Tool-calling-first AI office secretary that can read, think, act, verify, remember, and work across devices.**

CherryAgent is designed as an AI secretary for daily office work: email, calendar, documents, spreadsheets, files, reports, approvals, browser tasks, internal systems, notifications, and infrastructure workflows.

The core principle is simple:

> **The model should not just answer. It should choose tools, execute work, inspect results, recover from errors, and only claim success after verification.**

## Why TypeScript

CherryAgent uses TypeScript as the primary language because one codebase can cover:

- Web and installable PWA
- Windows, macOS, Linux
- iOS and Android through native wrappers
- Node.js server and local agent runtime
- Cloudflare/Bun/Deno-compatible adapters later
- Large JavaScript/TypeScript ecosystem for browser automation, office APIs, document processing, MCP, and AI SDKs

The first cross-device target is an **installable PWA**. Native packaging with **Tauri 2** is the next layer for deeper OS integration.

## Current MVP

Already included:

- Autonomous multi-step agent loop
- OpenAI-compatible LLM provider for Qwen/vLLM/SGLang/Ollama/OpenAI-compatible endpoints
- Native tool registry with JSON-schema tool definitions
- Tool execution loop with result feedback to the model
- Approval gate for external and dangerous actions
- Persistent local JSON memory
- Built-in office task and note tools
- Built-in workspace file tools
- Current-time and calculator tools
- HTTP API
- Installable PWA chat client
- Health and tool discovery endpoints
- Docker support
- CI type checking

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
                                      |
      +---------------+---------------+----------------+
      |               |               |                |
      v               v               v                v
   Office          Files          Browser           Connectors
 tasks/notes     workspace      automation      Gmail/Calendar/etc.
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

## API

### Health

```bash
curl http://localhost:8787/health
```

### List tools

```bash
curl http://localhost:8787/tools
```

### Chat

```bash
curl -X POST http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{"message":"Create a task to prepare the weekly IDC report tomorrow"}'
```

## Safety model

Tools have risk levels:

- `safe` — read-only/local reasoning utility
- `write` — local controlled writes such as tasks and notes
- `external` — sends, posts, or changes external services
- `dangerous` — destructive or high-impact operations

By default, `external` and `dangerous` tools require approval. This keeps the agent useful without letting it silently send mail, delete data, pay money, or change production systems.

## Product direction

CherryAgent should become an **office operating agent**, not just a chatbot.

Priority tool packs:

1. Gmail, Calendar, Drive, Docs, Sheets, Slides
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

## Status

This repository now contains a working foundation. It is intentionally designed so tools can be added without rewriting the agent core.
