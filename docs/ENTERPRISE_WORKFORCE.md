# Cherry Enterprise AI Workforce

Cherry is positioned as a private-cloud AI workforce for Thai organizations, not as another general chatbot. The product promise is **work completed with approval, evidence, audit, and policy**.

## Launch wedge

The first workflow is **Inbox-to-Execution**:

```text
Gmail / meeting / document → Office Inbox → triage → owner + deadline → follow-up → evidence
```

Company Knowledge and Executive Briefing are platform extensions. The shared execution engine is Deploy Flow / `AgenticRun`, with dependency-aware tasks, handoffs, evidence, structured log IDs, approval gates, and live SSE updates.

## Workspace and tenant model

- Every authenticated user belongs to one `tenantId` organization.
- Planner, memory, Office Inbox, usage credits, approvals, Engineer loops, Agentic runs, and tenant workspace files are tenant-scoped.
- `admin`, `user`, and `viewer` roles are available in the local control plane.
- `GET /workspace/context` exposes the current organization and user to the PWA.
- Organization administration is available to admins through `/organizations` and `/organizations/:id/members`.

The current runtime is a single-node JSON implementation for the pilot. Before accepting multiple production organizations, apply [`database/postgres/001_enterprise_control_plane.sql`](../database/postgres/001_enterprise_control_plane.sql), move repositories to PostgreSQL transactions, and use Redis for locks, queues, SSE fan-out, and idempotency keys.

## Usage credits

Credits intentionally hide token and infrastructure cost from customers. Current defaults are 10,000 credits per tenant per calendar month. Tool risk and workflow features reserve credits before execution:

- safe tool call: 1 credit
- write tool call: 2 credits
- external tool call: 5 credits
- dangerous tool call: 8 credits
- Deploy Flow run: 10 credits
- Inbox sync: 5 credits
- Inbox triage: 2 credits

Endpoints:

- `GET /usage/dashboard`
- `GET /usage/events`
- `POST /usage/budget` (admin)

## Office Inbox API

- `GET /office/inbox`
- `POST /office/inbox/sync` with `{ "query": "in:inbox", "maxResults": 25 }`
- `POST /office/inbox/:id/triage`
- `POST /office/inbox/:id/ignore`

The PWA’s Office Inbox is a monitoring and triage surface. It does not bypass Gmail permissions or Cherry approval policy. If Google Workspace OAuth is not configured, sync returns the connector error and does not fabricate messages.

## Pilot operating model

Start with 5–10 Thai design partners in the 100–1,000 employee range. Sell measurable outcomes: follow-up completion, response time, briefing preparation time, and tasks closed with evidence. Price as an annual platform license plus usage credits; use paid pilots to prove time-to-first-value under 14 days.
