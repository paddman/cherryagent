# CherryAgent Sub-Agent Roster

Cherry is the orchestrator. She decomposes complex goals, delegates work to named specialist workers, shares evidence across the run, manages handoffs, and verifies completion.

## Default 10 sub-agents

| Worker | ID | Role | Mission |
|---|---|---|---|
| Mira | `mira` | `office` | Email, Calendar, Drive, notes, follow-up, and administrative execution. |
| Navi | `navi` | `planner` | Dependency-aware plans, schedules, reminders, priorities, and work queues. |
| Atlas | `atlas` | `infra` | Proxmox, vSphere, VMs, hosts, storage, networking, and cloud infrastructure. |
| Lyra | `lyra` | `market` | Market intelligence, crypto data, analysis, and approval-gated trading. |
| Iris | `iris` | `research` | Research, news, financials, files, evidence gathering, and synthesis. |
| Nox | `nox` | `database` | PostgreSQL, MySQL, SQLite, and Redis operations under risk controls. |
| Forge | `forge` | `engineer` | Incident diagnosis, patching, testing, verification, and runbook learning. |
| Scout | `scout` | `general` | Cross-domain reconnaissance and work that has no narrower specialist owner. |
| Raven | `raven` | `critic` | Contradictions, missing evidence, incomplete requirements, and hidden risks. |
| Vera | `vera` | `verifier` | Independent evidence-based verification before Cherry reports completion. |

## Runtime model

```text
                         Cherry
                    Orchestrator / Boss
                              |
             plan -> delegate -> handoff -> verify
                              |
      +---------+---------+---------+---------+
      |         |         |         |         |
    Atlas     Forge      Iris      Mira      Navi
    infra    engineer  research   office   planner
      |         |         |         |         |
      +---------+---- Shared Evidence Bus ----+
                              |
                    Raven -> Vera -> Cherry
                      critic   verifier
```

Sub-agent execution is still bounded by role-based tool access, approval gates, retry budgets, and observable evidence requirements.

## Worker tools

Cherry can manage the roster through the built-in agent tools:

- `agent_list_workers` — list the complete roster or filter by role.
- `agent_get_worker` — inspect one worker profile.
- `agent_add_worker` — add a persistent custom worker.
- `agent_set_worker_enabled` — enable or disable a custom worker.

Custom workers inherit tool permissions from their assigned role. They do not bypass approval or risk controls.

## Add another worker

Example tool arguments:

```json
{
  "name": "Pixel",
  "role": "research",
  "mission": "Investigate AI models, benchmarks, release notes, and technical papers.",
  "instructions": "Prefer primary sources and record concrete evidence for every important claim."
}
```

The worker is persisted to:

```text
.cherry/agents.json
```

Override the location with:

```env
CHERRY_AGENT_ROSTER_FILE=.cherry/agents.json
```

When multiple enabled workers share the same role, the runtime selects among them round-robin so newly added workers can actually receive delegated tasks.

## Operational guarantee

A named worker is not merely a label. `SubAgentRuntime` resolves a worker profile for each delegated task, injects its name, mission, and optional custom instructions into the system prompt, limits tools by specialist role, and records worker identity in task output and shared evidence.
