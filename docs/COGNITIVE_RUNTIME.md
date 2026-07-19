# CherryAgent Cognitive Runtime

CherryAgent now includes a bounded cognitive runtime intended to improve general problem-solving across domains.

It is **not a claim of AGI, consciousness, sentience, or human-equivalent intelligence**. It is an engineering architecture that adds persistent goals, metacognition, episodic learning, fallible beliefs, reusable skills, explicit uncertainty, verification, and a self-model on top of CherryAgent's existing tool-calling and multi-agent systems.

## Cognitive cycle

```text
Persistent goal
      |
      v
Metacognitive deliberation
- assumptions
- hypotheses
- known unknowns
- plan
- verification contract
- stop conditions
- confidence
      |
      v
Bounded Global Workspace
- active and blocked goals
- relevant episodes
- evidence-backed beliefs
- reusable skills
- current self-model
      |
      v
Multi-agent execution
- specialist task graph
- tool calls
- approval gates
- critic and verifier
      |
      v
Observable verification
      |
      v
Post-action reflection
- episode
- lessons
- prediction errors
- belief updates
- candidate/active skill
```

## What this adds

### Persistent goal graph

Goals survive process restarts in `.cherry/cognition.json` and include:

- objective and success criteria
- priority and status
- assumptions and hypotheses
- an ordered plan
- known unknowns
- required verification evidence
- explicit stop conditions
- evidence, blockers, outcome, and confidence
- optional parent goal and agentic run linkage

### Metacognition

`cognition_deliberate` asks the model to produce operational artifacts instead of hidden chain-of-thought:

- assumptions that need testing
- hypotheses that can be falsified
- important unknowns
- an execution plan
- verification requirements
- stop/block conditions
- calibrated confidence
- suitable specialist roles

The deliberator may only plan against tools actually registered in the runtime.

### Episodic memory

Completed work becomes an episode containing:

- objective and outcome
- summary and concrete evidence
- reusable lessons
- surprises or prediction errors
- utility and confidence
- goal/run linkage

Recall is bounded and relevance-ranked so old experience informs new tasks without flooding context.

### Fallible world model

Cherry can store evidence-backed propositions as subject/predicate/value beliefs.

Beliefs have confidence, sources, optional expiry, and status. Contradictory values are not silently overwritten: both are retained and marked `contested`, and prior confidence is reduced until new evidence resolves the conflict.

### Skill learning

Verified successful work may create or strengthen a reusable skill containing:

- trigger patterns
- procedure
- verification steps
- known failure modes
- confidence
- success and failure counts
- source episode IDs

A failed, partial, blocked, or unverified run may create only a `candidate` skill. It cannot promote itself to active expertise without observable verification.

### Explicit self-model

`cognition_self_model` audits:

- registered capability domains and exact tools
- safe/write/external/dangerous tool counts
- goal, memory, skill, belief, and evaluation state
- maturity estimates for planning, action, memory, learning, metacognition, and autonomy readiness
- hard boundaries and unsupported claims

The self-model explicitly states that CherryAgent is a bounded software agent and not verified AGI or consciousness.

## Tools

| Tool | Purpose |
|---|---|
| `cognition_get_status` | Cognitive statistics and self-model |
| `cognition_create_goal` | Create a durable goal |
| `cognition_list_goals` | Inspect goal state |
| `cognition_deliberate` | Recall context and create a falsifiable plan |
| `cognition_execute_goal` | Execute through multi-agent orchestration, verify, and learn |
| `cognition_global_workspace` | Inspect the bounded Global Workspace |
| `cognition_recall_experience` | Retrieve relevant episodes |
| `cognition_list_skills` | Inspect learned candidate/active skills |
| `cognition_query_beliefs` | Query the fallible world model |
| `cognition_record_belief` | Store an evidence-backed proposition |
| `cognition_self_model` | Capability and limitation audit |
| `cognition_run_capability_audit` | Persist an engineering maturity evaluation |

## Example

Ask Cherry:

```text
Create a high-priority cognitive goal to reduce recurring HTTP 524 incidents.
Success requires:
- identify a verified root cause
- restore HTTP 200
- keep response time below the proxy timeout
- create a reusable prevention procedure

Deliberate first. Expose assumptions, unknowns, verification evidence, and stop conditions.
Then execute the goal. Do not claim success without evidence.
```

The expected sequence is:

```text
cognition_create_goal
        -> cognition_deliberate
        -> cognition_execute_goal
        -> multi-agent/tool execution
        -> verifier
        -> episode + beliefs + verified skill
```

## Configuration

```env
CHERRY_COGNITIVE_FILE=.cherry/cognition.json
CHERRY_COGNITIVE_MAX_CONTEXT_EPISODES=12
CHERRY_COGNITIVE_MAX_CONTEXT_BELIEFS=20
CHERRY_COGNITIVE_MAX_CONTEXT_SKILLS=20
```

These are context budgets, not autonomy permissions.

## Safety invariants

1. Cognitive execution does not bypass `ToolRegistry` or `ApprovalGate`.
2. External and dangerous tools keep their existing approval requirements.
3. The runtime does not rewrite its own source code automatically.
4. Unverified success cannot become an active skill.
5. Memory and beliefs are treated as fallible context, not ground truth.
6. Contradictions remain visible instead of being erased.
7. All loops remain bounded by existing task, round, concurrency, and tool-step budgets.
8. The capability audit is not an AGI benchmark or consciousness test.

## What still separates this from AGI

Important missing research and product layers include:

- robust semantic memory backed by PostgreSQL/pgvector or another vector database
- multimodal episodic memory across screen, audio, documents, and physical sensors
- calibrated causal world simulation and counterfactual testing
- long-horizon hierarchical planning with resource accounting
- reliable transfer-learning benchmarks across unrelated domains
- automatic curriculum generation inside a sandbox
- adversarial evaluation of learned skills and beliefs
- safe proactive initiative integrated with the latest main branch
- multi-user identity, tenancy, authorization, and durable audit infrastructure
- reproducible benchmark suites measuring generalization rather than demos

The next practical layer should port the autonomy/initiative work from the older chat-workspace branch onto current `main`, then connect it to this cognitive store so autonomous initiative is informed by goals, uncertainty, past outcomes, and policy budgets.
