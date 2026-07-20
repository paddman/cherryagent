# CherryAgent

CherryAgent คือ AI operating agent แบบ tool-calling-first สำหรับงานสำนักงาน วิศวกรรมระบบ เซิร์ฟเวอร์ ฐานข้อมูล รายงาน และ workflow หลาย agent โดยหลักการสำคัญคือ:

> Cherry ต้องลงมือผ่านเครื่องมือ ตรวจผลจากหลักฐาน และอ้างว่างานสำเร็จได้เมื่อมีผลลัพธ์ยืนยันเท่านั้น

ระบบรองรับ OpenAI-compatible LLM เช่น Qwen, vLLM, SGLang และ Ollama-compatible endpoints ใช้ TypeScript/Node.js เป็น runtime หลัก และมี PWA/Tauri เป็นหน้าจอใช้งานข้ามอุปกรณ์

## ภาพรวมการทำงาน

```text
ผู้ใช้ / PWA / API / LINE
          |
          v
Chat ID -> CherryAgent -> Tool Router -> Approval Gate
               |              |
               |              +-> Built-in tools
               |              +-> MCP tools
               |              +-> SSH connector
               |              +-> Paired Cherry Node
               |
               +-> Observe -> Verify -> Execution Trail -> คำตอบ
```

## สารบัญฟังก์ชัน

| ฟังก์ชัน | ใช้ทำอะไร | Tool/API หลัก |
|---|---|---|
| 1. Agent Execution | เลือกเครื่องมือ ลงมือ ตรวจผล และแสดง flow | Tool Router, Approval Gate, Correctness Loop |
| 2. Chat Sessions | จำบริบทและ log แยกตาม Chat ID | `/chat`, `/chat/history`, `/chat/logs` |
| 3. Cherry Gateway & Nodes | เชื่อมและทำงานบนเครื่องอื่นแบบ OpenClaw-style | `node_*`, `/nodes/*` |
| 4. MCP Tool Hub | โหลด MCP server และ tools แบบ dynamic | `mcp_*`, `/mcp/servers` |
| 5. Skills | โหลด workflow เฉพาะงานจาก `SKILL.md` | `skills/*/SKILL.md`, `/skills` |
| 6. SSH & Linux | ล็อกอินและดูแล Linux ผ่าน SSH profile | `linux_*`, `/linux/ssh/*` |
| 7. Engineer Loop | แก้ incident แบบมี phase, retry และหลักฐาน | `engineer_*` |
| 8. Multi-agent & Cognition | แตกงาน ส่งต่องาน และเก็บองค์ความรู้ | `orchestrator_*`, `agent_*`, `cognition_*` |
| 9. Planner & Reminders | วางแผน งานประจำ และแจ้งเตือน | `planner_*` |
| 10. Office & Google Workspace | Gmail, Calendar, Drive และ Office Inbox | `gmail_*`, `calendar_*`, `drive_*` |
| 11. Reports & BidPilot | วิเคราะห์ Excel/CSV, สร้าง PDF และงานประมูล | `report_*`, `bidpilot_*` |
| 12. Infrastructure & Data | Proxmox, vSphere, Database, Market | `proxmox_*`, `vsphere_*`, `db_*`, `market_*` |
| 13. Security & Tenancy | Authentication, RBAC, approvals, audit, usage | `/auth/*`, `/approvals`, `/usage/*` |
| 14. PWA, API & Desktop | ใช้งานผ่านเว็บ API และ native wrapper | PWA, HTTP API, Tauri 2 |

## เริ่มใช้งาน

ต้องใช้ Node.js 20 ขึ้นไป

```bash
cp .env.example .env
npm install
npm run server
```

เปิดหน้าเว็บ:

```text
http://localhost:8787
```

ตัวอย่าง LLM configuration:

```env
CHERRY_LLM_BASE_URL=http://127.0.0.1:8000/v1
CHERRY_LLM_API_KEY=local
CHERRY_LLM_MODEL=qwen3.6-27b
CHERRY_MAX_STEPS=24
```

Authentication เปิดโดยค่าเริ่มต้น ควรตั้ง admin ก่อน boot ครั้งแรก:

```env
CHERRY_AUTH_ENABLED=true
CHERRY_AUTH_ADMIN_EMAIL=admin@example.com
CHERRY_AUTH_ADMIN_PASSWORD=use-a-unique-password-with-at-least-12-characters
```

ดูรายละเอียดที่ [Authentication](docs/AUTHENTICATION.md)

---

## ฟังก์ชัน 1 — Agent Execution และ Execution Trail

Agent loop ทำงานเป็นรอบ: รับคำสั่ง เลือก tools อ่านผลลัพธ์ แก้ทางเมื่อผิดพลาด และส่ง candidate answer ให้ Correctness Loop ตรวจอีกชั้น

ความสามารถหลัก:

- route เฉพาะ tool pack ที่เกี่ยวข้อง เพื่อลด context และการเลือกผิด
- เรียกหลาย tools ต่อเนื่องภายในคำสั่งเดียว
- บังคับใช้ risk policy ก่อน tool execution
- เก็บ assistant/tool/error/correctness events เป็น trace
- แสดง Flow Nodes และ Execution Trail ในหน้า Chat
- ไม่แสดง chain-of-thought ภายใน แต่แสดง tool call และหลักฐานที่ตรวจสอบได้

```text
User request
  -> Assistant selects tool
  -> Tool executes or waits for approval
  -> Agent observes result
  -> Correctness verifier
  -> Final answer + trace + logId
```

## ฟังก์ชัน 2 — Persistent Chat Sessions

ทุกห้องมี Chat ID คงที่ ใช้เป็นทั้ง model session, audit session, log grouping และ Cherry Node binding

- เก็บ user/assistant history แบบ bounded
- redact password, token, Authorization header และ private key ก่อนบันทึก
- serialize คำสั่งที่เข้าพร้อมกันใน Chat ID เดียวกัน
- restore ประวัติเดิมเมื่อเปิด PWA ใหม่
- กด “แชตใหม่” เพื่อสร้าง Chat ID ใหม่และแยก context

ไฟล์เริ่มต้น:

```env
CHERRY_CHAT_SESSION_FILE=.cherry/chat-sessions.json
CHERRY_CHAT_LOG_FILE=.cherry/chat-logs.json
```

API:

```text
POST   /chat
GET    /chat/history?chatId=...
DELETE /chat/history?chatId=...
GET    /chat/logs?chatId=...
```

## ฟังก์ชัน 3 — Cherry Gateway และ Paired Nodes

Cherry Gateway เป็น control plane ส่วน `cherry-node` เป็น execution daemon ที่รันบนเครื่องปลายทางและเชื่อมกลับ Gateway ด้วย outbound polling จึงใช้งานหลัง NAT ได้

```text
Chat ID -> node binding -> Gateway task queue -> Cherry Node -> task result
```

Node tools:

- `node_list` — ดูเครื่องที่จับคู่และสถานะ online
- `node_get_binding` — ดูเครื่องของ Chat ID ปัจจุบัน
- `node_bind_chat` — ผูก Chat ID กับเครื่อง
- `node_system_info` — hostname, OS, user, uptime และ workspace
- `node_process_list` — ดู process
- `node_read_file` — อ่านไฟล์ใน node workspace
- `node_write_file` — เขียนไฟล์หลัง approval
- `node_exec` — รัน shell command หลัง dangerous approval

### วิธี Pair เครื่อง

1. เปิดหน้า Chat แล้วกด `Pair Node`
2. ตั้งชื่อเครื่องและ workspace
3. กดสร้าง one-time pairing code
4. copy คำสั่งไปรันบนเครื่องปลายทาง
5. เมื่อ node online ให้ Bind กับ Chat ID หากมีหลายเครื่อง

หรือรันด้วย environment โดยตรง:

```bash
CHERRY_GATEWAY_URL=https://cherry.example.com \
CHERRY_NODE_PAIRING_CODE='cherry-...' \
CHERRY_NODE_NAME='production-01' \
CHERRY_NODE_WORKSPACE=/srv/apps \
npm run node:agent
```

Node token ถูกบันทึกที่ `~/.cherry-node/profile.json` ด้วย mode `0600`; Gateway เก็บเฉพาะ token hash ควรรัน daemon ด้วย OS account ที่มีสิทธิ์เท่าที่จำเป็น

คู่มือเต็ม: [Cherry Gateway, Nodes, Sessions, and MCP](docs/CHERRY_GATEWAY_MCP.md)

## ฟังก์ชัน 4 — MCP Tool Hub

Cherry เป็น MCP client และรองรับสอง transport:

- stdio — Gateway spawn MCP server process
- Streamable HTTP — Gateway เชื่อม MCP endpoint ผ่าน HTTP/SSE

เมื่อเชื่อมสำเร็จ tools จะถูกเพิ่มใน Tool Registry เป็น:

```text
mcp_<server>_<server-id>_<tool>
```

MCP tools ใช้ Approval Gate, audit, usage accounting และ Execution Trail ชุดเดียวกับ built-in tools

ตัวอย่างลงทะเบียน stdio server:

```bash
curl -X POST http://localhost:8787/mcp/servers \
  -H 'Authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{
    "name":"filesystem",
    "transport":"stdio",
    "command":"npx",
    "args":["-y","@modelcontextprotocol/server-filesystem","/srv/shared"],
    "risk":"external"
  }'
```

Secret ไม่ควรถูกส่งใน JSON config ให้ใช้ `envFrom` หรือ `headersFrom` เพื่ออ้างถึง environment variable ของ Gateway

```text
GET    /mcp/servers
POST   /mcp/servers
POST   /mcp/servers/:id/reconnect
DELETE /mcp/servers/:id
```

## ฟังก์ชัน 5 — Runtime Skills

Cherry ค้นหา skills จาก:

```text
skills/<skill-name>/SKILL.md
```

แต่ละ skill มี YAML frontmatter `name` และ `description` เมื่อข้อความตรงกับ metadata ระบบจะ inject เฉพาะ skill ที่เกี่ยวข้อง ไม่โหลดทุก skill เข้า context

skill ที่มาพร้อมระบบ:

- `cherry-node-operator` — บังคับ workflow ให้ Cherry ไปต่อจาก connection status สู่ execution และ verification บน Node/MCP/SSH

```text
GET /skills
```

## ฟังก์ชัน 6 — SSH และ Linux Operations

SSH Login panel รองรับ:

- private key
- password ที่เข้ารหัส AES-256-GCM ก่อนบันทึก
- SSH agent
- host fingerprint confirmation
- strict host-key checking

เครื่องมือหลัก:

```text
linux_login                 linux_exec
linux_read_file             linux_write_file
linux_service_status        linux_service_action
linux_logs                  linux_disk_status
linux_process_list          linux_network_status
linux_verify_http
```

Credential ส่งเข้า connector โดยตรง ไม่เข้า model prompt, Chat history หรือ Execution Trail

## ฟังก์ชัน 7 — Engineer Loop

งาน incident, debugging และ system changes ใช้ state machine แบบ bounded:

```text
Plan -> Execute -> Observe -> Diagnose -> Patch -> Test -> Verify -> Learn
```

- กำหนด observable success criteria
- เก็บ phase, hypothesis, evidence และ error
- retry ด้วย iteration budget
- block/resume เมื่อรอ approval หรือ dependency
- complete ได้เมื่อมี verification evidence
- สร้าง reusable Runbook หลัง verified success

Tool pack ใช้ prefix `engineer_*` เช่น `engineer_start_loop`, `engineer_record_phase`, `engineer_next_iteration`, `engineer_complete_loop` และ `engineer_list_runbooks`

คู่มือ: [Architecture](docs/ARCHITECTURE.md)

## ฟังก์ชัน 8 — Multi-agent, Handoffs และ Cognition

Deploy Flow แตกเป้าหมายเป็น dependency graph แล้วมอบหมาย specialist workers ตาม role

- `orchestrator_*` — สร้างและติดตาม workflow
- `agent_*` — worker registry, handoff และ evidence bus
- `cognition_*` — persistent goals, episodes, beliefs, learned skills และ capability audit
- live topology ผ่าน Server-Sent Events
- identity chain: `jobId -> runId/traceId -> taskId/spanId -> logId`

เอกสาร:

- [Agentic AI](docs/AGENTIC-AI.md)
- [Sub Agents](docs/SUB_AGENTS.md)
- [Cognitive Runtime](docs/COGNITIVE_RUNTIME.md)

## ฟังก์ชัน 9 — Planner, Reminders และ Notifications

Planner รองรับสถานะ:

```text
inbox -> planned -> doing -> waiting -> done
```

แต่ละงานมี priority, tags, project/flow ID, start/due time, duration, timezone และ dependencies

Reminder schedules:

| ชนิด | ตัวอย่าง |
|---|---|
| `once` | รันครั้งเดียวตาม ISO time |
| `interval` | ทุก 30 นาที |
| `daily` | ทุกวัน 09:00 |
| `weekdays` | จันทร์–ศุกร์ 08:30 |
| `weekly` | วันที่เลือกในแต่ละสัปดาห์ |
| `monthly` | วันที่กำหนดของเดือน |
| `cron` | `0 9 * * 1-5` |

ช่องทางแจ้งเตือน: in-app, browser, Gmail, LINE, Slack และ generic webhook โดย external delivery ต้องผ่าน approval

## ฟังก์ชัน 10 — Office และ Google Workspace

### Gmail

ค้นหา/อ่านข้อความ, สร้าง draft, ส่ง, reply และ archive ผ่าน `gmail_*`

### Google Calendar

ดู, สร้าง, แก้ไข และลบ event ผ่าน `calendar_*`

### Google Drive

ค้นหา, อ่าน, สร้าง text file และย้ายไฟล์ผ่าน `drive_*`

### Office Inbox

sync Gmail เข้ากล่องงาน, triage เป็น tenant-scoped planner item และติดตาม usage credits

```env
CHERRY_GOOGLE_CLIENT_ID=
CHERRY_GOOGLE_CLIENT_SECRET=
CHERRY_GOOGLE_REFRESH_TOKEN=
```

## ฟังก์ชัน 11 — Report Studio และ BidPilot

Report Studio:

- upload `.xlsx`/`.csv`
- profile schema และ data quality
- คำนวณ KPI/charts แบบ deterministic
- ส่งเฉพาะ schema/aggregates เข้า narrative model
- สร้าง Thai PDF พร้อม evidence
- รองรับ tenant isolation และ retention

Pipeline:

```text
ingest -> profile -> analyze -> visualize -> pdf -> verify
```

BidPilot รองรับ extract เอกสาร/TOR, requirements, compliance matrix, proposal generation และ pipeline ผ่าน `bidpilot_*`

เอกสาร: [Report Studio](docs/REPORT_STUDIO.md) และ [BidPilot](docs/BIDPILOT.md)

## ฟังก์ชัน 12 — Infrastructure, Database และ Markets

### Infrastructure

- Proxmox: cluster, nodes, VMs, storage, network, task log, power, snapshot และ migration
- vSphere: VMs, hosts, clusters, datastores, networks และ power operations
- Observability และ security operations tools

### Database

- PostgreSQL, MySQL, SQLite และ Redis
- inspect connection/schema ก่อน query
- read-only query และ `EXPLAIN`
- write/dangerous operations แยก risk level
- จำกัดหนึ่ง SQL statement ต่อ call

### Markets และ Trading

- stock/crypto quote และ candles
- technical analysis, financials และ news
- research packs
- spot order และ order status สำหรับ exchange ที่ตั้งค่าไว้

## ฟังก์ชัน 13 — Security, Approval, Audit และ Tenancy

Risk levels:

| Risk | ความหมาย |
|---|---|
| `safe` | read-only/local utility |
| `write` | controlled local write |
| `external` | ส่งหรือเปลี่ยนข้อมูลใน external service |
| `dangerous` | destructive หรือ high-impact action |

ค่าเริ่มต้น:

```env
CHERRY_AUTO_APPROVE=safe,write
```

ระบบมี local authentication, scrypt password hashing, bearer sessions, admin/user/viewer RBAC, tenant IDs, usage budgets และ PostgreSQL audit logger แบบ fail-soft

Approval API:

```text
GET  /approvals
POST /approvals/:id/approve
POST /approvals/:id/deny
```

## ฟังก์ชัน 14 — PWA, HTTP API และ Desktop

หน้า PWA แบ่ง work surfaces เป็น Dashboard, Report Studio, Flow Board, Office Inbox, Reminders, Engineer, Deploy Flow และ Ask Cherry

API สำคัญ:

| Endpoint | หน้าที่ |
|---|---|
| `GET /health` | model, tools, connectors, nodes, MCP และ runtime status |
| `GET /tools` | รายการ tools และ risk |
| `POST /chat` | รัน agent ด้วย Chat ID |
| `GET /planner/dashboard` | planner summary |
| `GET /engineer/dashboard` | Engineer Loop summary |
| `POST /orchestrator/runs` | เริ่ม Deploy Flow |
| `GET /reports` | รายการ reports |
| `GET /usage/dashboard` | usage credits |
| `GET /workspace/context` | tenant/user context |

Tauri 2 เป็น native wrapper สำหรับ Windows/macOS/Linux และเป็นฐานสำหรับ OS integrations เพิ่มเติม

## คำสั่งสำหรับพัฒนา

```bash
npm run dev             # interactive CLI
npm run server          # HTTP/PWA Gateway
npm run node:agent      # paired execution node
npm run test:gateway    # session/node/MCP/skill integration tests
npm run typecheck       # TypeScript validation
npm run build           # compile backend to dist
npm run desktop:dev     # Tauri development
npm run desktop:build   # Tauri package
```

## Environment สำคัญ

| Variable | ค่าเริ่มต้น/หน้าที่ |
|---|---|
| `CHERRY_PORT` | `8787` |
| `CHERRY_WORKSPACE` | `workspace` |
| `CHERRY_CHAT_SESSION_FILE` | `.cherry/chat-sessions.json` |
| `CHERRY_NODE_FILE` | `.cherry/nodes.json` |
| `CHERRY_NODE_TASK_TIMEOUT_MS` | `60000` |
| `CHERRY_MCP_SERVER_FILE` | `.cherry/mcp-servers.json` |
| `CHERRY_SKILLS_DIRECTORY` | `skills` |
| `CHERRY_ENGINEER_FILE` | `.cherry/engineer.json` |
| `CHERRY_PLANNER_FILE` | `.cherry/planner.json` |
| `CHERRY_AUTH_FILE` | `.cherry/auth.json` |

## ข้อจำกัดปัจจุบัน

- Cherry Node MVP ใช้ authenticated polling; WebSocket streaming และ resumable streams ยังเป็นงานถัดไป
- state หลักยังเป็น tenant-scoped local JSON เหมาะกับ single-node MVP; multi-node production ควรย้าย queue/locks/state ไป PostgreSQL และ Redis
- `node_exec` มีพลังเท่ากับ OS account ที่รัน daemon จึงต้องใช้ least privilege และ dangerous approval
- MCP secrets ต้องมาจาก Gateway environment ผ่าน `envFrom`/`headersFrom`
- browser notifications ต้องมี PWA client เชื่อมอยู่; full Web Push ยังไม่ครบ
- external connectors ทำงานได้เมื่อกำหนด credential และ endpoint ที่เกี่ยวข้องแล้ว

## เอกสารเพิ่มเติม

- [Cherry Gateway, Nodes, Sessions, and MCP](docs/CHERRY_GATEWAY_MCP.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Authentication](docs/AUTHENTICATION.md)
- [Enterprise Workforce](docs/ENTERPRISE_WORKFORCE.md)
- [Report Studio](docs/REPORT_STUDIO.md)
- [Infrastructure Agent](docs/INFRA_AGENT.md)
- [Markets](docs/MARKETS.md)
- [Security Operations](docs/SECURITYOPS-DATABASE.md)
- [Windows Desktop Agent](docs/WINDOWS_DESKTOP_AGENT.md)

## Product direction

ลำดับงานถัดไปคือ PostgreSQL/Redis control plane, realtime node transport, per-node execution policy, browser automation, Microsoft 365, Web Push และ device-native workers เพื่อขยาย CherryAgent จาก single-Gateway MVP ไปสู่ distributed operating agent เต็มรูปแบบ
