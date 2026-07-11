# CherryAgent Agentic AI Core

CherryAgent now has a persistent multi-agent execution core rather than only a single model loop pretending to play many roles.

## What is implemented

- Goal decomposition into a dependency-aware task graph.
- Multi-agent delegation to specialist roles.
- Bounded parallel sub-agent execution.
- Role-specific tool allowlists.
- Persistent agent-to-agent handoff protocol.
- Persistent Shared Evidence Bus.
- Critic agent repair rounds.
- Final verifier agent.
- Generic PostgreSQL, MySQL, SQLite, and Redis tools.
- Approval Gate enforcement for database, trading, infrastructure, email, and other remote actions.
- Independent outer Correctness Loop before Cherry's final answer.

## End-to-end execution

```text
User Goal
    |
    v
Cherry Main Agent
    |
    | complex / multi-domain / parallelizable goal
    v
orchestrator_run_goal
    |
    v
Goal Decomposition
    |
    v
Dependency Task Graph
    |
    +----------------+----------------+----------------+
    |                |                |                |
    v                v                v                v
Office Agent     Infra Agent      Market Agent     Database Agent
    |                |                |                |
    v                v                v                v
Gmail/Calendar   Proxmox/vSphere  Stocks/Crypto    PostgreSQL/MySQL
Drive/Planner    Engineer tools   News/Trading     SQLite/Redis
    |                |                |                |
    +----------------+--------+-------+----------------+
                              |
                              v
                    Shared Evidence Bus
                              |
                              v
                         Critic Agent
                              |
              pass / needs_more_work / blocked
                              |
                 +------------+------------+
                 |                         |
                 v                         v
               pass                  add repair tasks
                 |                         |
                 |                   delegate again
                 |                         |
                 +------------+------------+
                              |
                              v
                      Final Synthesizer
                              |
                              v
                        Verifier Agent
                              |
                       pass / revise
                              |
                              v
                    Outer Correctness Loop
                              |
                              v
                     Verified final answer
```

## Specialist roles

The orchestrator can delegate to:

- `office`
- `planner`
- `infra`
- `market`
- `research`
- `database`
- `engineer`
- `general`

The orchestration runtime itself also records `orchestrator`, `critic`, and `verifier` roles.

## Role-specific tool isolation

Sub-agents do not receive every tool.

Examples:

```text
office
  office_*
  gmail_*
  calendar_*
  drive_*
  planner_*
  memory_*

infra
  proxmox_*
  vsphere_*
  engineer_*
  db_*
  files_*
  system_*

market
  market_*
  trade_*
  planner_*

research
  market_*
  drive_*
  files_*
  memory_*

database
  db_*
  engineer_*
  files_*
  system_*
```

Sub-agents are explicitly denied `orchestrator_*` and `agent_*` tools, preventing recursive self-spawning and unbounded orchestration loops.

## Persistent agentic state

Default file:

```env
CHERRY_AGENTIC_FILE=.cherry/agentic.json
```

Each orchestration run stores:

- run ID
- original goal
- status
- current repair round
- dependency tasks
- specialist role per task
- task status
- handoff ID
- result/error
- evidence IDs
- critic result
- verifier result
- final synthesis
- timestamps

Statuses:

```text
running
succeeded
blocked
failed
aborted
```

## Agent-to-Agent handoff protocol

A handoff stores:

```text
id
runId
taskId
fromAgent
toAgent
objective
context
evidenceIds
expectedOutput
status
result/error
timestamps
```

Lifecycle:

```text
pending
   |
   v
accepted
   |
   +-------> completed
   |
   +-------> blocked
   |
   +-------> failed
   |
   +-------> rejected
```

The orchestrator creates a real persistent handoff before a specialist starts work. The specialist result and evidence IDs are attached back to the handoff when it completes.

## Shared Evidence Bus

Every evidence record stores:

```text
id
runId
taskId
agent
kind
claim
data
sourceTool
confidence
createdAt
```

Evidence kinds:

```text
observation
tool_result
fact
decision
error
verification
```

Tool results from sub-agents are automatically published to the bus. Critic and verifier decisions are also published.

Shared evidence is not treated as automatically true. Provenance, source tool, confidence, errors, and missing evidence remain visible.

## Critic repair loop

After delegated tasks finish, the critic agent returns:

```json
{
  "verdict": "pass | needs_more_work | blocked",
  "summary": "...",
  "issues": ["..."],
  "additionalTasks": [
    {
      "key": "task-key",
      "role": "research",
      "objective": "...",
      "dependsOn": []
    }
  ]
}
```

When the verdict is `needs_more_work` and repair budget remains, the orchestrator adds the new specialist tasks and delegates again.

Default bounded budgets:

```env
CHERRY_AGENTIC_MAX_TASKS=8
CHERRY_AGENTIC_MAX_ROUNDS=2
CHERRY_AGENTIC_CONCURRENCY=3
CHERRY_SUBAGENT_MAX_STEPS=10
```

Hard bounds in code prevent unlimited fan-out and infinite delegation.

## Verifier agent

After synthesis, a separate verifier agent checks the candidate against task outputs and Shared Evidence Bus records.

Verifier result:

```json
{
  "verdict": "pass | revise",
  "confidence": 95,
  "issues": [],
  "revisedAnswer": "only when revision is needed"
}
```

The main Cherry Correctness Loop still runs after the orchestrator tool result, giving two verification layers for orchestrated work.

## Generic Database Agent

Supported connectors:

- PostgreSQL through `psql`
- MySQL through `mysql`
- SQLite through `sqlite3`
- Redis through `redis-cli`

The corresponding CLI must exist in `PATH` on the CherryAgent host.

Configuration:

```env
CHERRY_DB_TIMEOUT_MS=30000
CHERRY_DB_MAX_OUTPUT_BYTES=1000000
CHERRY_DB_POSTGRES_URL=
CHERRY_DB_MYSQL_URL=
CHERRY_DB_SQLITE_PATH=
CHERRY_DB_REDIS_URL=
```

Real credentials must never be committed to Git.

### Database tools

```text
db_list_connections
db_query_readonly
db_describe_schema
db_explain_query
db_execute_write
db_execute_dangerous
db_redis_read
db_redis_write
db_redis_dangerous
```

### Risk separation

```text
safe
  SELECT
  WITH without mutation
  SHOW
  DESCRIBE
  DESC
  EXPLAIN
  schema inspection
  Redis read commands

external
  INSERT
  UPDATE
  MERGE
  UPSERT
  REPLACE
  non-destructive Redis writes

dangerous
  DELETE
  DROP
  TRUNCATE
  ALTER
  CREATE
  GRANT / REVOKE
  high-impact SQL
  DEL / FLUSHDB / FLUSHALL / EVAL / CONFIG / SHUTDOWN
```

One tool call accepts one SQL statement only. Multiple SQL statements are rejected.

Recommended production default:

```env
CHERRY_AUTO_APPROVE=safe,write
```

Database mutations therefore enter Approval Inbox unless the operator deliberately changes policy.

## Agentic tool pack

```text
orchestrator_run_goal
orchestrator_get_run
orchestrator_list_runs
orchestrator_get_dashboard

agent_create_handoff
agent_accept_handoff
agent_finish_handoff
agent_list_handoffs

agent_publish_evidence
agent_get_evidence
```

## Example: multi-domain IDC incident

User goal:

```text
Find why customer VMs became slow, check Proxmox hosts and database latency, read relevant alerts, identify root cause, propose the safest remediation, and verify the conclusion.
```

Possible task graph:

```text
infra-check
  role=infra
  dependsOn=[]

postgres-check
  role=database
  dependsOn=[]

alert-research
  role=research
  dependsOn=[]

root-cause
  role=engineer
  dependsOn=[infra-check, postgres-check, alert-research]
```

The first three can run in parallel. Their tool outputs become shared evidence. The engineer receives accumulated evidence. The critic checks whether enough evidence exists. The verifier checks the final synthesis.

## Example: market research with database portfolio context

User goal:

```text
Analyze BTC from Binance and MEXC, read current crypto news, query my PostgreSQL trading journal for recent BTC performance, then tell me whether the evidence supports trading or waiting.
```

Possible delegation:

```text
market agent
  Binance/MEXC price and OHLCV analysis

research agent
  current crypto news

database agent
  read-only journal query

critic agent
  find contradictions and missing evidence

verifier agent
  check final claims against shared evidence
```

A real order still requires `trade_place_spot_order`, which is `dangerous`, and must pass Approval Inbox under the recommended policy.

## Important limitations

- Orchestration uses the configured LLM for decomposition, specialist work, critique, synthesis, and verification, so model quality matters.
- CLI-based database adapters require local database client binaries.
- Shared evidence can contain sensitive tool output; production deployments should add per-user authorization, encryption at rest, and retention policies.
- The current persistent state is JSON and is designed for a single-node MVP. Multi-node production should move agentic state, handoffs, locks, evidence, and work queues to PostgreSQL/Redis.
- The API server still needs authentication and a restrictive CORS policy before internet exposure.
- Approval state is in memory and should be moved to persistent storage before production-grade autonomous operations.
