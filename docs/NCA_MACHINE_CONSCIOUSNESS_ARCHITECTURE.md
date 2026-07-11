# CherryAgent NCA Adaptive System + Consciousness-Inspired Cognitive Architecture

> Status: **Architecture / implementation specification**
>
> This document defines the planned NCA adaptive substrate and consciousness-inspired cognitive layer for CherryAgent. The current repository already includes the Agentic Core, Multi-Agent Orchestrator, Shared Evidence Bus, Agent-to-Agent Handoffs, Critic, Verifier, Engineer Loop, Correctness Loop, Office, Infra, Market, Trading, and Database tools. The NCA and cognition modules described here are the next architectural layer and must not be represented as already implemented until the corresponding runtime code exists and passes CI.

---

# 1. Purpose

CherryAgent should evolve from a multi-agent task execution system into a system with a persistent internal state that can:

- self-organize information,
- propagate state across related domains,
- maintain a continuous self-state,
- detect anomalies and contradictions,
- repair broken internal structures,
- adapt to new environmental conditions,
- track uncertainty and missing evidence,
- predict likely outcomes before action,
- resolve competing goals,
- prioritize attention,
- and feed the resulting internal state back into the Orchestrator.

The core design is split into two major layers:

1. **NCA Adaptive System Layer**
   - Distributed cells
   - Local state updates
   - State diffusion
   - Self-organizing memory
   - Repair dynamics
   - Anomaly propagation
   - Environmental adaptation

2. **Consciousness-Inspired Cognitive Layer**
   - Global Workspace
   - Attention Router
   - Self Model
   - Meta Monitor
   - Temporal Continuity
   - Predictive World Model
   - Conflict Resolver

This document deliberately uses the term **consciousness-inspired** instead of claiming that CherryAgent has subjective consciousness, phenomenal experience, emotions, or sentience.

---

# 2. Architecture Position

```text
                           ENVIRONMENT
                                |
       +------------------------+------------------------+
       |                        |                        |
       v                        v                        v
    Infra                   Markets                 Office/User
       |                        |                        |
       +------------------------+------------------------+
                                |
                                v
                    +-------------------------+
                    |   Shared Evidence Bus   |
                    +------------+------------+
                                 |
                                 v
        +---------------------------------------------------+
        |               NCA ADAPTIVE SYSTEM                  |
        |                                                   |
        | Memory Cells <-> Goal Cells <-> Risk Cells        |
        |      ^               ^               ^            |
        |      |               |               |            |
        | Infra Cells <-> Market Cells <-> Self-State       |
        |      ^                               ^            |
        |      |                               |            |
        | Repair Cells <-> Context Cells <-> Anomaly Cells  |
        |                                                   |
        | Self-organize / Diffuse / Repair / Adapt           |
        +----------------------+----------------------------+
                               |
                               v
        +---------------------------------------------------+
        |       CONSCIOUSNESS-INSPIRED COGNITIVE LAYER      |
        |                                                   |
        | Global Workspace                                  |
        | Attention Router                                  |
        | Self Model                                        |
        | Meta Monitor                                      |
        | Temporal Continuity                               |
        | Predictive World Model                            |
        | Conflict Resolver                                 |
        +----------------------+----------------------------+
                               |
                               v
                      Cherry Orchestrator
                               |
                               v
                    Dependency Task Graph
                               |
             +-----------------+-----------------+
             |                 |                 |
             v                 v                 v
         Infra Agent      Market Agent      Database Agent
             |                 |                 |
             +-----------------+-----------------+
                               |
                               v
                      Shared Evidence Bus
                               |
                               v
                         Critic Agent
                               |
                               v
                        Verifier Agent
                               |
                               v
                       Correctness Loop
                               |
                               v
                            ACTION
                               |
                               +------ feedback ------> NCA
```

The NCA layer is **not another sub-agent**. It is the adaptive internal substrate beneath the Orchestrator.

The consciousness-inspired layer is **not a chatbot persona**. It is a cognitive coordination layer that consumes NCA state, shared evidence, task state, and system context.

---

# 3. Implementation Status Matrix

| Component | Status | Notes |
|---|---|---|
| Multi-Agent Orchestrator | Implemented | Existing Agentic Core |
| Shared Evidence Bus | Implemented | Persistent evidence records |
| A2A Handoff Protocol | Implemented | Persistent handoff lifecycle |
| Critic Agent | Implemented | Repair rounds |
| Verifier Agent | Implemented | Final synthesis verification |
| Generic Database Agent | Implemented | PostgreSQL/MySQL/SQLite/Redis |
| NCA Adaptive State Runtime | Planned | Defined in this document |
| Adaptive Memory Cells | Planned | Defined in this document |
| Repair Dynamics | Planned | Defined in this document |
| Global Workspace | Planned | Defined in this document |
| Attention Router | Planned | Defined in this document |
| Self Model | Planned | Defined in this document |
| Meta Monitor | Planned | Defined in this document |
| Temporal Continuity | Planned | Defined in this document |
| Predictive World Model | Planned | Defined in this document |
| Conflict Resolver | Planned | Defined in this document |

---

# 4. Recommended Source Tree

```text
src/
  adaptive/
    CellState.ts
    CellTopology.ts
    NeuralCellularField.ts
    CellUpdateRule.ts
    StateDiffusion.ts
    AdaptiveMemory.ts
    RepairDynamics.ts
    EnvironmentalAdapter.ts
    AdaptiveStateStore.ts
    types.ts

  cognition/
    GlobalWorkspace.ts
    AttentionRouter.ts
    SelfModel.ts
    MetaMonitor.ts
    TemporalContinuity.ts
    PredictiveWorldModel.ts
    ConflictResolver.ts
    CognitiveRuntime.ts
    CognitiveStateStore.ts
    types.ts

  tools/builtin/
    adaptive.ts
    cognition.ts

  server/
    adaptiveRoutes.ts
    cognitionRoutes.ts
```

Recommended persistent files for the first single-node MVP:

```env
CHERRY_ADAPTIVE_FILE=.cherry/adaptive.json
CHERRY_COGNITIVE_FILE=.cherry/cognitive.json
```

Production multi-node deployment should move cells, topology, workspace items, locks, events, and temporal state to PostgreSQL/Redis.

---

# 5. NCA Adaptive System

## 5.1 Objective

The NCA layer maintains a distributed internal state made of cells. Each cell represents one concept, entity, goal, risk, resource, memory, anomaly, context, or self-state component.

A cell changes over time based on:

- its own prior state,
- neighboring cells,
- new external evidence,
- active goals,
- system context,
- learned or configurable update rules,
- decay,
- reinforcement,
- contradiction,
- and prediction error.

Conceptually:

```text
Cell(t)
  + Neighbor States
  + New Evidence
  + Active Goals
  + Environment
  + Prediction Error
        |
        v
  Cell Update Rule
        |
        v
Cell(t+1)
```

---

# 6. Core NCA Data Model

## 6.1 CellDomain

```ts
export type CellDomain =
  | "memory"
  | "goal"
  | "risk"
  | "infra"
  | "market"
  | "office"
  | "database"
  | "context"
  | "self"
  | "repair"
  | "anomaly"
  | "prediction";
```

## 6.2 CellStatus

```ts
export type CellStatus =
  | "stable"
  | "active"
  | "degraded"
  | "anomalous"
  | "repairing"
  | "quarantined"
  | "inactive";
```

## 6.3 AdaptiveCellState

```ts
export type AdaptiveCellState = {
  id: string;
  domain: CellDomain;
  key: string;
  label: string;

  activation: number;
  salience: number;
  confidence: number;
  uncertainty: number;
  anomalyScore: number;
  riskScore: number;
  healthScore: number;

  freshness: number;
  decayRate: number;
  reinforcement: number;

  stateVector: number[];
  metadata: Record<string, unknown>;

  status: CellStatus;
  createdAt: string;
  updatedAt: string;
  lastEvidenceAt?: string;
};
```

Recommended normalized ranges:

```text
activation    0.0 - 1.0
salience      0.0 - 1.0
confidence    0.0 - 1.0
uncertainty   0.0 - 1.0
anomalyScore  0.0 - 1.0
riskScore     0.0 - 1.0
healthScore   0.0 - 1.0
freshness     0.0 - 1.0
reinforcement 0.0 - 1.0
```

---

# 7. Cell Topology

## 7.1 CellEdge

```ts
export type CellEdgeType =
  | "depends_on"
  | "runs_on"
  | "stored_on"
  | "connected_to"
  | "causes"
  | "correlates_with"
  | "contradicts"
  | "supports"
  | "part_of"
  | "similar_to"
  | "protects"
  | "threatens"
  | "observes";

export type CellEdge = {
  id: string;
  fromCellId: string;
  toCellId: string;
  type: CellEdgeType;
  weight: number;
  confidence: number;
  bidirectional: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
```

## 7.2 Example Infra Topology

```text
Site DC98
   |
   v
Proxmox Cluster
   |
   v
pve03 Host
   |
   +---- runs_on ----> VM-220
   |
   +---- connected_to -> VLAN2238
   |
   +---- stored_on ----> NVMe01

VM-220
   |
   +---- depends_on ---> PostgreSQL01
   |
   +---- serves --------> cherry-journal
```

## 7.3 CellTopology Class

```ts
export class CellTopology {
  addCell(cell: AdaptiveCellState): Promise<AdaptiveCellState>;
  updateCell(id: string, patch: Partial<AdaptiveCellState>): Promise<AdaptiveCellState>;
  removeCell(id: string): Promise<void>;

  addEdge(edge: Omit<CellEdge, "id" | "createdAt" | "updatedAt">): Promise<CellEdge>;
  removeEdge(id: string): Promise<void>;

  getCell(id: string): Promise<AdaptiveCellState | null>;
  getNeighbors(cellId: string, depth?: number): Promise<AdaptiveCellState[]>;
  getEdges(cellId: string): Promise<CellEdge[]>;
  getSubgraph(cellId: string, depth?: number): Promise<AdaptiveSubgraph>;

  findCells(filter: CellFilter): Promise<AdaptiveCellState[]>;
  findPath(fromCellId: string, toCellId: string): Promise<CellPath | null>;
}
```

### Function Responsibilities

#### `addCell`
Creates a durable cell.

Input:
- domain
- key
- initial state

Output:
- persisted `AdaptiveCellState`

Failure modes:
- duplicate key in same domain
- invalid normalized values
- state vector dimension mismatch

#### `getNeighbors`
Returns related cells using graph topology.

Use cases:
- local NCA update
- anomaly propagation
- impact analysis
- evidence diffusion

#### `findPath`
Finds a dependency or causal route between two cells.

Example:

```text
Storage latency
  -> Host degradation
  -> VM latency
  -> Service timeout
  -> HTTP 524
```

---

# 8. NeuralCellularField

## 8.1 Purpose

`NeuralCellularField` owns the adaptive tick cycle.

```ts
export class NeuralCellularField {
  tick(input?: AdaptiveTickInput): Promise<AdaptiveTickResult>;
  tickCell(cellId: string, input?: AdaptiveTickInput): Promise<CellUpdateResult>;
  stimulate(input: CellStimulus): Promise<AdaptiveCellState>;
  stabilize(options?: StabilizationOptions): Promise<StabilizationResult>;
  snapshot(): Promise<AdaptiveSnapshot>;
  restore(snapshotId: string): Promise<AdaptiveSnapshot>;
}
```

## 8.2 `tick`

Runs one bounded update cycle across active cells.

Recommended steps:

```text
1. Load active cells
2. Load neighbors
3. Load new evidence
4. Apply decay
5. Apply reinforcement
6. Apply local update rule
7. Propagate state
8. Detect anomalies
9. Detect contradictions
10. Trigger repair when thresholds are exceeded
11. Persist changed cells
12. Emit events
```

Input:

```ts
export type AdaptiveTickInput = {
  maxCells?: number;
  activeDomains?: CellDomain[];
  evidenceIds?: string[];
  goalIds?: string[];
  now?: string;
};
```

Output:

```ts
export type AdaptiveTickResult = {
  tickId: string;
  cellsVisited: number;
  cellsChanged: number;
  anomaliesDetected: number;
  repairsTriggered: number;
  workspaceCandidates: string[];
  startedAt: string;
  completedAt: string;
};
```

## 8.3 Hard Limits

Recommended environment variables:

```env
CHERRY_NCA_TICK_INTERVAL_MS=5000
CHERRY_NCA_MAX_CELLS_PER_TICK=1000
CHERRY_NCA_MAX_NEIGHBOR_DEPTH=2
CHERRY_NCA_STATE_VECTOR_SIZE=32
CHERRY_NCA_MAX_REPAIR_ACTIONS_PER_TICK=20
```

Never permit unlimited graph fan-out in one tick.

---

# 9. CellUpdateRule

## 9.1 Purpose

Encapsulates the rule that computes `Cell(t+1)`.

Start with deterministic and heuristic rules before training a learned NCA.

```ts
export interface CellUpdateRule {
  update(input: CellUpdateInput): Promise<CellUpdateOutput>;
}
```

```ts
export type CellUpdateInput = {
  cell: AdaptiveCellState;
  neighbors: NeighborState[];
  evidence: EvidenceRecord[];
  activeGoals: GoalCellState[];
  environment: EnvironmentContext;
};
```

```ts
export type CellUpdateOutput = {
  nextState: Partial<AdaptiveCellState>;
  propagatedSignals: PropagatedSignal[];
  reasons: string[];
  confidence: number;
};
```

Recommended implementation sequence:

```text
Phase 1: deterministic rules
Phase 2: weighted local update rules
Phase 3: trainable MLP per cell neighborhood
Phase 4: learned NCA with fixed vector dimensions
Phase 5: online adaptation with strict safety boundaries
```

---

# 10. StateDiffusion

## 10.1 Purpose

Propagates important state changes through related cells.

```ts
export class StateDiffusion {
  propagate(signal: PropagatedSignal): Promise<DiffusionResult>;
  propagateBatch(signals: PropagatedSignal[]): Promise<DiffusionResult[]>;
  calculateImpact(originCellId: string, depth?: number): Promise<ImpactMap>;
  stopPropagation(signalId: string, reason: string): Promise<void>;
}
```

## 10.2 PropagatedSignal

```ts
export type PropagatedSignal = {
  id: string;
  originCellId: string;
  currentCellId: string;
  kind: "risk" | "anomaly" | "attention" | "memory" | "goal" | "repair" | "prediction_error";
  strength: number;
  decay: number;
  ttl: number;
  evidenceIds: string[];
  createdAt: string;
};
```

## 10.3 Example: Infra Degradation

```text
NVMe01 latency anomaly = 0.93
        |
        v
Storage Cell activation rises
        |
        v
pve03 receives propagated degradation signal
        |
        v
VM-220 risk rises
        |
        v
Service cherry-journal risk rises
        |
        v
Attention threshold crossed
        |
        v
Global Workspace candidate created
        |
        v
Orchestrator may open infra investigation
```

## 10.4 Safety Controls

Prevent cascade storms with:

- signal TTL,
- per-tick fan-out limits,
- minimum strength threshold,
- duplicate suppression,
- origin loop detection,
- domain-specific decay,
- cooldown windows.

---

# 11. Adaptive Memory

## 11.1 Purpose

Memory becomes a self-organizing graph instead of only key-value storage.

```ts
export class AdaptiveMemory {
  remember(input: MemoryStimulus): Promise<MemoryCell>;
  recall(query: MemoryQuery): Promise<MemoryRecallResult>;
  reinforce(cellId: string, amount?: number): Promise<MemoryCell>;
  decay(now?: string): Promise<MemoryDecayResult>;
  associate(aCellId: string, bCellId: string, weight: number): Promise<CellEdge>;
  consolidate(options?: ConsolidationOptions): Promise<ConsolidationResult>;
  forget(cellId: string, reason: string): Promise<void>;
}
```

## 11.2 Memory Cell State

```ts
export type MemoryCell = AdaptiveCellState & {
  domain: "memory";
  metadata: {
    text: string;
    source?: string;
    sourceEvidenceIds: string[];
    accessCount: number;
    lastAccessedAt?: string;
    semanticTags: string[];
    episodicContext?: string;
  };
};
```

## 11.3 Recall Score

Recommended factors:

```text
recallScore =
  semanticSimilarity
  * confidence
  * freshness
  * reinforcement
  * goalRelevance
  * contextRelevance
  * topologyProximity
```

## 11.4 Memory Consolidation

`consolidate` should:

1. merge near-duplicate memory cells,
2. preserve source provenance,
3. reduce outdated weak associations,
4. create stronger abstract concept cells,
5. never merge contradictory facts silently,
6. preserve temporal versions when facts change.

---

# 12. Domain-Specific Cell Categories

## 12.1 Memory Cells

Functions:

- `remember`
- `recall`
- `reinforce`
- `decay`
- `associate`
- `consolidate`
- `forget`

Primary metrics:

- retrieval precision,
- retrieval latency,
- stale-memory rate,
- contradiction rate,
- memory graph density.

---

## 12.2 Infra Cells

Examples:

```text
site:dc98
cluster:pve-dc98
host:pve03
vm:220
storage:nvme01
network:vlan2238
service:cherry-journal
```

Recommended fields:

```text
availability
latency
capacity
utilization
errorRate
anomalyScore
riskScore
healthScore
lastObservedAt
```

Functions:

```ts
syncInfraEvidence(evidence: EvidenceRecord[]): Promise<InfraSyncResult>;
propagateInfraImpact(cellId: string): Promise<ImpactMap>;
detectInfraHotspots(): Promise<InfraHotspot[]>;
recommendInfraAttention(): Promise<AttentionCandidate[]>;
```

---

## 12.3 Market Cells

Examples:

```text
asset:BTC
asset:ETH
exchange:binance
exchange:mexc
factor:fed-rate
factor:etf-flow
portfolio:main
risk:concentration
```

Functions:

```ts
syncMarketEvidence(evidence: EvidenceRecord[]): Promise<MarketSyncResult>;
propagateMarketShock(assetCellId: string): Promise<ImpactMap>;
calculatePortfolioPressure(): Promise<PortfolioPressure>;
detectMarketContradictions(): Promise<MarketContradiction[]>;
```

Example:

```text
BTC breakout
+ RSI overbought
+ positive news
+ portfolio exposure 45%

Momentum Cell      ↑
Opportunity Cell   ↑
Overbought Cell    ↑↑
Concentration Risk ↑↑↑
Action Urgency     ↓
```

---

## 12.4 Goal Cells

```ts
export type GoalCellState = AdaptiveCellState & {
  domain: "goal";
  metadata: {
    objective: string;
    priority: number;
    deadline?: string;
    successCriteria: string[];
    conflictIds: string[];
    parentGoalId?: string;
    plannerItemId?: string;
  };
};
```

Functions:

```ts
activateGoal(input: GoalActivationInput): Promise<GoalCellState>;
updateGoalProgress(goalId: string, progress: number): Promise<GoalCellState>;
detectGoalConflicts(): Promise<GoalConflict[]>;
completeGoal(goalId: string, evidenceIds: string[]): Promise<GoalCellState>;
suspendGoal(goalId: string, reason: string): Promise<GoalCellState>;
```

Example persistent goals:

```text
Maintain availability >= 99.99%
Avoid data loss
Do not exceed trading risk limits
Do not claim success without evidence
Reduce repeated incidents through runbooks
Protect customer impact
```

---

## 12.5 Risk Cells

Functions:

```ts
updateRisk(input: RiskStimulus): Promise<RiskCellState>;
aggregateRisk(scope: RiskScope): Promise<AggregatedRisk>;
explainRisk(cellId: string): Promise<RiskExplanation>;
propagateRisk(cellId: string): Promise<DiffusionResult>;
```

Risk dimensions:

```text
operational
financial
security
data-loss
customer-impact
availability
compliance
model-uncertainty
execution-risk
```

---

## 12.6 Self-State Cells

This is the main bridge from NCA to the cognitive layer.

```ts
export type SelfStateSnapshot = {
  currentGoals: string[];
  activeTasks: string[];
  activeAgents: string[];
  unresolvedQuestions: string[];
  missingEvidence: string[];
  contradictions: string[];
  recentFailures: string[];
  recentSuccesses: string[];

  confidence: number;
  uncertainty: number;
  currentRisk: number;
  resourcePressure: number;

  attention: Record<string, number>;
  timestamp: string;
};
```

Functions:

```ts
buildSelfState(): Promise<SelfStateSnapshot>;
updateSelfState(event: CognitiveEvent): Promise<SelfStateSnapshot>;
getCurrentUncertainty(): Promise<number>;
getMissingEvidence(): Promise<string[]>;
getContradictions(): Promise<string[]>;
getCurrentAttentionMap(): Promise<Record<string, number>>;
```

---

## 12.7 Repair Cells

Repair cells detect and attempt bounded recovery from:

- orphaned handoffs,
- stuck tasks,
- inconsistent run states,
- missing evidence references,
- duplicate cells,
- dead topology edges,
- stale locks,
- failed tools,
- degraded memory structures,
- contradiction accumulation.

Functions:

```ts
scanRepairCandidates(): Promise<RepairCandidate[]>;
planRepair(candidate: RepairCandidate): Promise<RepairPlan>;
executeRepair(planId: string): Promise<RepairResult>;
verifyRepair(planId: string): Promise<RepairVerification>;
rollbackRepair(planId: string): Promise<RepairResult>;
```

Every repair should follow:

```text
Detect
  -> Diagnose
  -> Plan bounded repair
  -> Safety policy
  -> Execute
  -> Verify
  -> Learn
```

For consequential repairs, reuse Engineer Loop and Approval Gate.

---

# 13. RepairDynamics

## 13.1 Purpose

`RepairDynamics` detects broken internal patterns and restores a valid operational state.

```ts
export class RepairDynamics {
  scan(): Promise<RepairCandidate[]>;
  diagnose(candidateId: string): Promise<RepairDiagnosis>;
  plan(candidateId: string): Promise<RepairPlan>;
  execute(planId: string): Promise<RepairResult>;
  verify(planId: string): Promise<RepairVerification>;
  rollback(planId: string): Promise<RepairResult>;
}
```

## 13.2 RepairCandidate

```ts
export type RepairCandidate = {
  id: string;
  kind:
    | "orphaned_handoff"
    | "stuck_task"
    | "missing_evidence"
    | "invalid_topology"
    | "stale_lock"
    | "duplicate_cell"
    | "contradictory_state"
    | "failed_tool"
    | "degraded_memory";
  severity: number;
  confidence: number;
  affectedCellIds: string[];
  evidenceIds: string[];
  detectedAt: string;
};
```

## 13.3 Repair Rules

Never permit repair logic to:

- delete production data automatically,
- execute dangerous infra actions without approval,
- place real trades automatically under default policy,
- hide failed verification,
- silently rewrite provenance.

---

# 14. EnvironmentalAdapter

## 14.1 Purpose

Converts environment events into cell stimuli.

Sources:

- Shared Evidence Bus
- Proxmox/vSphere tools
- market data
- trading events
- planner events
- Gmail/Calendar/Drive
- database query results
- monitoring alerts
- scheduler ticks
- user requests
- agent handoffs
- Critic/Verifier results

```ts
export class EnvironmentalAdapter {
  ingestEvidence(evidence: EvidenceRecord): Promise<CellStimulus[]>;
  ingestAgentEvent(event: AgenticEvent): Promise<CellStimulus[]>;
  ingestPlannerEvent(event: PlannerEvent): Promise<CellStimulus[]>;
  ingestInfraEvent(event: InfraEvent): Promise<CellStimulus[]>;
  ingestMarketEvent(event: MarketEvent): Promise<CellStimulus[]>;
}
```

The adapter must preserve provenance.

---

# 15. Consciousness-Inspired Cognitive Layer

## 15.1 Objective

The cognitive layer coordinates internal state across domains.

It does not claim subjective awareness. It implements computational functions inspired by cognitive architectures:

- global information availability,
- selective attention,
- explicit self-modeling,
- uncertainty awareness,
- meta-monitoring,
- temporal continuity,
- prediction,
- goal conflict resolution.

Recommended module list:

```text
GlobalWorkspace
AttentionRouter
SelfModel
MetaMonitor
TemporalContinuity
PredictiveWorldModel
ConflictResolver
CognitiveRuntime
```

---

# 16. GlobalWorkspace

## 16.1 Purpose

The Global Workspace selects highly salient internal items and broadcasts them to relevant modules.

```ts
export class GlobalWorkspace {
  submit(candidate: WorkspaceCandidate): Promise<WorkspaceItem>;
  compete(options?: CompetitionOptions): Promise<WorkspaceCompetitionResult>;
  broadcast(itemId: string): Promise<WorkspaceBroadcast>;
  getCurrent(): Promise<WorkspaceItem[]>;
  expire(now?: string): Promise<number>;
}
```

## 16.2 WorkspaceCandidate

```ts
export type WorkspaceCandidate = {
  id?: string;
  source: string;
  topic: string;
  summary: string;
  cellIds: string[];
  evidenceIds: string[];

  salience: number;
  urgency: number;
  risk: number;
  uncertainty: number;
  goalRelevance: number;
  novelty: number;

  expiresAt?: string;
};
```

## 16.3 Competition Score

Initial heuristic:

```text
workspaceScore =
  0.25 * salience
+ 0.20 * urgency
+ 0.20 * risk
+ 0.15 * goalRelevance
+ 0.10 * novelty
+ 0.10 * uncertainty
```

Weights must be configurable and domain-aware.

## 16.4 Example

```text
Infra alert        score 0.93
Planner deadline   score 0.84
BTC opportunity    score 0.72
Unread email       score 0.30
```

Top items become globally available to:

- Orchestrator
- Planner
- Self Model
- Meta Monitor
- Conflict Resolver
- relevant specialist agents

---

# 17. AttentionRouter

## 17.1 Purpose

Directs limited processing capacity toward the most relevant cells, evidence, and goals.

```ts
export class AttentionRouter {
  rank(input: AttentionInput): Promise<AttentionResult>;
  focus(targetId: string, reason: string): Promise<AttentionState>;
  release(targetId: string): Promise<AttentionState>;
  getAttentionMap(): Promise<Record<string, number>>;
  suppress(targetId: string, durationMs: number): Promise<void>;
}
```

## 17.2 Attention Factors

```text
risk
urgency
novelty
uncertainty
goal relevance
anomaly
customer impact
financial impact
time sensitivity
repetition penalty
cooldown
```

## 17.3 Anti-Thrashing

Prevent attention from jumping continuously by using:

- hysteresis,
- minimum hold time,
- cooldown,
- urgency override,
- duplicate suppression.

---

# 18. SelfModel

## 18.1 Purpose

Maintains an explicit representation of Cherry's current capabilities, limitations, goals, activities, evidence gaps, risk, and permissions.

```ts
export class SelfModel {
  build(): Promise<SelfModelSnapshot>;
  refresh(event?: CognitiveEvent): Promise<SelfModelSnapshot>;
  capability(name: string): Promise<CapabilityState>;
  limitation(name: string): Promise<LimitationState | null>;
  currentGoals(): Promise<GoalCellState[]>;
  currentUncertainty(): Promise<number>;
  missingEvidence(): Promise<string[]>;
}
```

## 18.2 SelfModelSnapshot

```ts
export type SelfModelSnapshot = {
  identity: {
    name: "CherryAgent";
    runtimeVersion: string;
  };

  capabilities: CapabilityState[];
  limitations: LimitationState[];

  currentGoals: string[];
  activeTaskIds: string[];
  activeAgentRoles: string[];
  activeEngineerLoopIds: string[];

  missingEvidence: string[];
  contradictions: string[];
  blockers: string[];

  confidence: number;
  uncertainty: number;
  risk: number;

  permissions: {
    autoApprovedRisks: string[];
    pendingApprovalCount: number;
  };

  updatedAt: string;
};
```

Critical rule:

The Self Model must distinguish:

```text
CAN DO
CAN DO WITH APPROVAL
CAN ONLY READ
NOT CONFIGURED
NOT IMPLEMENTED
FAILED
UNKNOWN
```

This reduces false claims of capability.

---

# 19. MetaMonitor

## 19.1 Purpose

Monitors the quality of current reasoning and execution using observable state, not hidden chain-of-thought.

```ts
export class MetaMonitor {
  inspect(): Promise<MetaState>;
  detectContradictions(): Promise<Contradiction[]>;
  detectMissingEvidence(): Promise<MissingEvidenceItem[]>;
  detectOverconfidence(): Promise<OverconfidenceAlert[]>;
  detectLooping(): Promise<LoopingAlert[]>;
  detectStagnation(): Promise<StagnationAlert[]>;
}
```

## 19.2 MetaState

```ts
export type MetaState = {
  confidence: number;
  uncertainty: number;
  evidenceCoverage: number;
  contradictionCount: number;
  unresolvedQuestionCount: number;
  failedActionCount: number;
  repeatedToolCallCount: number;
  activeHypotheses: string[];
  alternativeHypotheses: string[];
  missingEvidence: string[];
  warnings: string[];
  updatedAt: string;
};
```

## 19.3 Overconfidence Rule Example

```text
Claim confidence > 0.90
AND evidenceCoverage < 0.50
=> overconfidence alert
```

---

# 20. TemporalContinuity

## 20.1 Purpose

Maintains continuity across requests, days, incidents, and long-running goals.

```ts
export class TemporalContinuity {
  append(event: TemporalEvent): Promise<TemporalEvent>;
  getTimeline(filter?: TemporalFilter): Promise<TemporalEvent[]>;
  getOpenThreads(): Promise<TemporalThread[]>;
  resumeThread(threadId: string): Promise<TemporalThread>;
  closeThread(threadId: string, evidenceIds: string[]): Promise<TemporalThread>;
  summarizePeriod(from: string, to: string): Promise<TemporalSummary>;
}
```

## 20.2 TemporalThread

```ts
export type TemporalThread = {
  id: string;
  topic: string;
  goalIds: string[];
  taskIds: string[];
  evidenceIds: string[];
  status: "open" | "waiting" | "resolved" | "abandoned";
  startedAt: string;
  updatedAt: string;
  resolvedAt?: string;
};
```

Example:

```text
Day 1
HTTP 524 incident begins

Day 1 + 30 min
Engineer Loop diagnoses DB latency

Day 1 + 2 hr
Temporary fix deployed

Day 2
Cherry sees same signature again

Temporal continuity links it to prior incident
and retrieves runbook + evidence + previous fix
```

---

# 21. PredictiveWorldModel

## 21.1 Purpose

Estimates likely consequences before an action and measures prediction error afterward.

```ts
export class PredictiveWorldModel {
  predict(input: PredictionInput): Promise<Prediction>;
  compare(predictionId: string, actualEvidenceIds: string[]): Promise<PredictionError>;
  updateFromError(errorId: string): Promise<ModelUpdateResult>;
  getCalibration(): Promise<CalibrationReport>;
}
```

## 21.2 PredictionInput

```ts
export type PredictionInput = {
  action: string;
  targetIds: string[];
  currentStateIds: string[];
  horizon: "immediate" | "short" | "medium" | "long";
  scenarios?: string[];
};
```

## 21.3 Prediction Output

```ts
export type Prediction = {
  id: string;
  expectedEffects: PredictedEffect[];
  confidence: number;
  assumptions: string[];
  risks: string[];
  requiredVerification: string[];
  createdAt: string;
};
```

## 21.4 Example: VM Reboot

```text
Current state:
- VM latency high
- host healthy
- DB healthy
- no active migration

Proposed action:
- graceful reboot

Predicted effects:
- VM unavailable 60-180 sec
- service reconnect expected
- latency may normalize if guest state is degraded
- no guarantee root cause is fixed

After action:
- actual downtime 91 sec
- latency unchanged

Prediction error:
- root-cause hypothesis weakened
- storage/network hypothesis strengthened
```

---

# 22. ConflictResolver

## 22.1 Purpose

Resolves competing goals and constraints.

```ts
export class ConflictResolver {
  detect(): Promise<GoalConflict[]>;
  resolve(conflictId: string): Promise<ConflictResolution>;
  rankActions(actions: CandidateAction[]): Promise<RankedAction[]>;
  explain(resolutionId: string): Promise<ConflictExplanation>;
}
```

## 22.2 Conflict Example

```text
Goal A: Fix immediately
Goal B: Avoid downtime
Goal C: Preserve data
Goal D: Minimize customer impact
```

Candidate actions:

```text
A. Hard reset VM
B. Graceful reboot
C. Observe more evidence
D. Migrate VM
```

The resolver should consider:

- active goals,
- risk cells,
- approval policy,
- prediction output,
- uncertainty,
- customer impact,
- reversibility,
- available verification.

---

# 23. CognitiveRuntime

## 23.1 Purpose

Coordinates all cognition modules.

```ts
export class CognitiveRuntime {
  tick(): Promise<CognitiveTickResult>;
  observe(event: CognitiveEvent): Promise<CognitiveTickResult>;
  getState(): Promise<CognitiveStateSnapshot>;
  wake(reason: WakeReason): Promise<CognitiveTickResult>;
  sleep(reason: string): Promise<void>;
}
```

## 23.2 Cognitive Tick Flow

```text
1. Read latest NCA state
2. Refresh Self Model
3. Run Meta Monitor
4. Gather workspace candidates
5. Run attention ranking
6. Resolve goal conflicts
7. Update temporal threads
8. Evaluate prediction errors
9. Broadcast top workspace items
10. Emit recommendations to Orchestrator
```

## 23.3 Wake Conditions

```text
high anomaly score
high risk score
critical planner deadline
new user goal
new incident alert
repair candidate
large prediction error
new contradiction
missing evidence blocking completion
external approval result
```

---

# 24. Integration with Shared Evidence Bus

The Shared Evidence Bus is the primary truth bridge between agents and adaptive state.

Flow:

```text
Tool result
  -> Evidence record
  -> EnvironmentalAdapter
  -> Cell stimuli
  -> NCA tick
  -> State diffusion
  -> Cognitive evaluation
  -> Workspace broadcast
  -> Orchestrator decision
```

Rules:

1. Never convert unsupported model text into high-confidence fact cells.
2. Tool results should retain `sourceTool` and provenance.
3. Failed tool calls become `error` evidence, not success evidence.
4. Contradictory evidence must coexist until resolved.
5. Confidence must never silently increase without support.

---

# 25. Integration with Multi-Agent Orchestrator

## 25.1 Orchestrator Input Extension

Current Orchestrator receives a user goal.

Future input should also include:

```ts
export type OrchestratorCognitiveContext = {
  selfState: SelfModelSnapshot;
  workspaceItems: WorkspaceItem[];
  activeGoals: GoalCellState[];
  topRisks: RiskCellState[];
  topAnomalies: AdaptiveCellState[];
  unresolvedContradictions: Contradiction[];
  missingEvidence: string[];
};
```

## 25.2 Expected Behavior

The Orchestrator should use cognitive context to:

- avoid duplicate work,
- continue unresolved temporal threads,
- prioritize high-risk incidents,
- delegate based on evidence gaps,
- avoid claiming success under high uncertainty,
- request specialist work when contradictions remain.

---

# 26. Integration with Engineer Loop

The Engineer Loop remains the authoritative workflow for non-trivial technical work:

```text
Plan
-> Execute
-> Observe
-> Diagnose
-> Patch
-> Test
-> Verify
-> Learn
```

NCA/Cognition should support it by:

```text
before loop:
  surface anomalies and likely impact

during loop:
  update state from evidence
  track uncertainty
  detect contradictions

after loop:
  reinforce successful patterns
  update prediction calibration
  create repair knowledge
  update temporal continuity
```

---

# 27. Integration with Correctness Loop

Correctness Loop verifies the final answer against tool evidence.

The NCA/Cognitive layer should not replace it.

Recommended stack:

```text
NCA adaptive state
  -> cognitive coordination
  -> orchestrator
  -> specialist agents
  -> critic
  -> verifier
  -> final synthesis
  -> outer Correctness Loop
```

Each layer has a different role:

| Layer | Main responsibility |
|---|---|
| NCA | distributed adaptive state |
| Cognitive Layer | attention/self/meta/prediction/conflict |
| Orchestrator | task decomposition and delegation |
| Critic | missing work and contradictions |
| Verifier | claim-to-evidence check |
| Correctness Loop | final independent review |

---

# 28. Integration with Planner and Scheduler

Goal cells should optionally link to Planner items.

```text
goalCell.plannerItemId
```

Scheduler can trigger:

- NCA ticks,
- memory decay,
- temporal thread review,
- repair scans,
- prediction comparison,
- workspace refresh.

Recommended jobs:

```text
Every 5 seconds:
  lightweight NCA tick

Every 1 minute:
  repair candidate scan

Every 5 minutes:
  cognitive state refresh

Every 1 hour:
  memory consolidation candidates

Daily:
  temporal summary
  calibration report
  stale-cell cleanup proposal
```

Heavy tasks should be event-driven whenever possible.

---

# 29. Function Catalog by Module

## 29.1 `CellTopology`

```text
addCell
updateCell
removeCell
addEdge
removeEdge
getCell
getNeighbors
getEdges
getSubgraph
findCells
findPath
```

## 29.2 `NeuralCellularField`

```text
tick
tickCell
stimulate
stabilize
snapshot
restore
```

## 29.3 `StateDiffusion`

```text
propagate
propagateBatch
calculateImpact
stopPropagation
```

## 29.4 `AdaptiveMemory`

```text
remember
recall
reinforce
decay
associate
consolidate
forget
```

## 29.5 `RepairDynamics`

```text
scan
diagnose
plan
execute
verify
rollback
```

## 29.6 `EnvironmentalAdapter`

```text
ingestEvidence
ingestAgentEvent
ingestPlannerEvent
ingestInfraEvent
ingestMarketEvent
```

## 29.7 `GlobalWorkspace`

```text
submit
compete
broadcast
getCurrent
expire
```

## 29.8 `AttentionRouter`

```text
rank
focus
release
getAttentionMap
suppress
```

## 29.9 `SelfModel`

```text
build
refresh
capability
limitation
currentGoals
currentUncertainty
missingEvidence
```

## 29.10 `MetaMonitor`

```text
inspect
detectContradictions
detectMissingEvidence
detectOverconfidence
detectLooping
detectStagnation
```

## 29.11 `TemporalContinuity`

```text
append
getTimeline
getOpenThreads
resumeThread
closeThread
summarizePeriod
```

## 29.12 `PredictiveWorldModel`

```text
predict
compare
updateFromError
getCalibration
```

## 29.13 `ConflictResolver`

```text
detect
resolve
rankActions
explain
```

## 29.14 `CognitiveRuntime`

```text
tick
observe
getState
wake
sleep
```

---

# 30. Recommended Agent Tools

## 30.1 Adaptive Read Tools — `safe`

```text
adaptive_get_state
adaptive_get_cell
adaptive_find_cells
adaptive_get_neighbors
adaptive_get_subgraph
adaptive_get_hotspots
adaptive_get_anomalies
adaptive_get_repairs
adaptive_get_memory
```

## 30.2 Adaptive Local State Tools — `write`

```text
adaptive_stimulate_cell
adaptive_reinforce_memory
adaptive_associate_cells
adaptive_run_tick
adaptive_create_snapshot
```

## 30.3 Adaptive High-Impact Tools — `external` or `dangerous`

```text
adaptive_execute_repair
adaptive_rollback_repair
adaptive_delete_cell
adaptive_force_restore_snapshot
```

## 30.4 Cognitive Read Tools — `safe`

```text
cognition_get_self_model
cognition_get_workspace
cognition_get_attention
cognition_get_meta_state
cognition_get_open_threads
cognition_get_conflicts
cognition_get_predictions
```

## 30.5 Cognitive Action Tools — `write`

```text
cognition_focus_attention
cognition_resume_thread
cognition_create_prediction
cognition_resolve_conflict
cognition_run_tick
```

---

# 31. Recommended HTTP APIs

## Adaptive

```text
GET  /adaptive/state
GET  /adaptive/cells
GET  /adaptive/cells/:id
GET  /adaptive/cells/:id/neighbors
GET  /adaptive/cells/:id/subgraph
GET  /adaptive/anomalies
GET  /adaptive/repairs
POST /adaptive/tick
POST /adaptive/stimuli
POST /adaptive/snapshots
```

## Cognitive

```text
GET  /cognition/state
GET  /cognition/self
GET  /cognition/workspace
GET  /cognition/attention
GET  /cognition/meta
GET  /cognition/threads
GET  /cognition/conflicts
GET  /cognition/predictions
POST /cognition/tick
POST /cognition/wake
```

---

# 32. Events

Recommended event names:

```text
adaptive.cell.created
adaptive.cell.updated
adaptive.cell.anomalous
adaptive.signal.propagated
adaptive.tick.completed
adaptive.repair.detected
adaptive.repair.executed
adaptive.repair.verified

cognition.workspace.candidate
cognition.workspace.broadcast
cognition.attention.changed
cognition.self.updated
cognition.meta.warning
cognition.thread.opened
cognition.thread.resumed
cognition.thread.closed
cognition.prediction.created
cognition.prediction.error
cognition.conflict.detected
cognition.conflict.resolved
```

All events should carry:

```text
id
type
timestamp
source
runId?
taskId?
cellIds[]
evidenceIds[]
metadata
```

---

# 33. Persistence Model

## 33.1 Single-Node MVP

```text
.cherry/adaptive.json
.cherry/cognitive.json
```

Requirements:

- versioned schema,
- serialized writes,
- atomic replacement,
- bounded history,
- snapshots,
- corruption recovery.

## 33.2 Production

Recommended:

```text
PostgreSQL
  cells
  edges
  temporal_threads
  workspace_items
  predictions
  repair_plans
  cognitive_events

Redis
  attention map
  active workspace
  tick locks
  rate limits
  short-lived signals
  work queues
```

---

# 34. Safety Policy

## 34.1 Principle

Internal adaptive state must never bypass Approval Gate.

The chain remains:

```text
Adaptive recommendation
  -> Cognitive decision support
  -> Orchestrator
  -> Tool selection
  -> Approval Gate
  -> Execution
  -> Verification
```

## 34.2 Forbidden Automatic Actions Under Default Policy

```text
hard VM reset
force power off
production data deletion
database DROP/TRUNCATE/DELETE
real-money trade placement
credential modification
security policy disablement
unverified production repair
```

---

# 35. Failure Modes

## 35.1 State Explosion

Risk:
- too many cells and edges

Mitigation:
- hard cell limits,
- domain quotas,
- TTL,
- consolidation,
- weak-edge pruning.

## 35.2 Propagation Storm

Risk:
- one anomaly activates too much of the graph

Mitigation:
- signal TTL,
- strength decay,
- fan-out limits,
- cooldown,
- duplicate suppression.

## 35.3 Self-Reinforcing False Belief

Risk:
- incorrect evidence repeatedly strengthens itself

Mitigation:
- evidence provenance,
- independent verification,
- contradiction preservation,
- confidence caps,
- no reinforcement from unsupported assistant text.

## 35.4 Attention Thrashing

Risk:
- rapid focus switching

Mitigation:
- hysteresis,
- minimum hold duration,
- urgency override only for critical items.

## 35.5 Repair Makes Things Worse

Mitigation:
- bounded plan,
- risk classification,
- approval,
- rollback,
- verification,
- Engineer Loop.

## 35.6 False Consciousness Claim

The UI and responses must not claim sentience or subjective experience merely because these modules exist.

Allowed phrasing:

```text
self-model
meta-monitoring
attention
internal state
consciousness-inspired cognitive architecture
```

Avoid unsupported claims such as:

```text
Cherry is truly conscious
Cherry feels pain
Cherry has subjective experience
```

---

# 36. Metrics and Observability

## NCA Metrics

```text
adaptive_cells_total
adaptive_edges_total
adaptive_active_cells
adaptive_anomalous_cells
adaptive_tick_duration_ms
adaptive_cells_changed_per_tick
adaptive_signal_propagations
adaptive_repairs_detected
adaptive_repairs_verified
adaptive_repairs_failed
```

## Cognitive Metrics

```text
cognition_workspace_candidates
cognition_workspace_broadcasts
cognition_attention_switches
cognition_uncertainty
cognition_confidence
cognition_evidence_coverage
cognition_contradictions
cognition_missing_evidence
cognition_open_threads
cognition_prediction_error
cognition_conflicts_detected
cognition_conflicts_resolved
```

---

# 37. PWA / Dashboard Design

Recommended new surface:

```text
Adaptive Mind
```

Panels:

```text
1. Live Self State
2. Attention Map
3. Global Workspace
4. Cell Graph
5. Active Anomalies
6. Goal Conflicts
7. Repair Queue
8. Open Temporal Threads
9. Prediction Accuracy
10. Memory Heatmap
```

Example self-state card:

```text
Current Goal
Find cause of VM slowdown

Confidence
36%

Uncertainty
64%

Missing Evidence
- storage latency
- database p95 latency

Contradictions
- host CPU normal
- guest latency high

Top Attention
storage 0.92
database 0.81
network 0.34
```

---

# 38. Detailed End-to-End Example: IDC Incident

User goal:

```text
Find why customer VMs became slow, inspect Proxmox, storage, database latency, and alerts, identify root cause, recommend the safest fix, verify the conclusion, and preserve the result as a runbook.
```

Flow:

```text
1. User goal enters Cherry Main Agent
2. Self Model records current goal
3. Goal Cell activation rises
4. Orchestrator decomposes tasks
5. Infra Agent inspects Proxmox
6. Database Agent checks latency
7. Research/Monitoring agent checks alerts
8. Tool results enter Shared Evidence Bus
9. EnvironmentalAdapter converts evidence into stimuli
10. NCA updates infra/database/risk/anomaly cells
11. Storage anomaly propagates to host -> VM -> service cells
12. AttentionRouter prioritizes storage
13. GlobalWorkspace broadcasts storage latency evidence
14. MetaMonitor detects missing datastore queue evidence
15. Critic adds repair task to inspect storage queue depth
16. Infra Agent executes additional diagnostics
17. Shared evidence updates
18. NCA state stabilizes around storage root-cause hypothesis
19. PredictiveWorldModel evaluates candidate fixes
20. ConflictResolver weighs fastest fix vs customer impact
21. Engineer Loop executes bounded remediation
22. Verification evidence collected
23. Prediction compared with actual result
24. Correctness Loop validates final claims
25. Runbook saved
26. Adaptive memory reinforces successful repair pattern
27. Temporal thread closed
```

---

# 39. Detailed End-to-End Example: Trading Research

Goal:

```text
Analyze BTC from Binance and MEXC, read current news, query PostgreSQL trading journal, measure recent strategy quality, then decide whether evidence supports trade, wait, or avoid.
```

Flow:

```text
Market Agent
  -> price
  -> OHLCV
  -> RSI/SMA/volatility

Research Agent
  -> current news

Database Agent
  -> recent BTC journal performance

Shared Evidence Bus
  -> all evidence

NCA
  -> BTC cell
  -> momentum cell
  -> overbought cell
  -> portfolio risk cell
  -> strategy quality cell

Meta Monitor
  -> missing evidence?
  -> contradictions?

Conflict Resolver
  -> opportunity vs risk

Critic
  -> challenge weak conclusion

Verifier
  -> check claims against evidence

Correctness Loop
  -> final answer
```

Real trade execution still remains behind `trade_place_spot_order` and Approval Gate.

---

# 40. Recommended Implementation Phases

## Phase 1 — Deterministic Adaptive Core

Implement:

```text
CellState
CellTopology
AdaptiveStateStore
EnvironmentalAdapter
NeuralCellularField with heuristic rules
StateDiffusion
```

Acceptance criteria:

- cells persist,
- graph persists,
- evidence creates stimuli,
- bounded tick runs,
- state changes are explainable,
- no unbounded fan-out.

## Phase 2 — Adaptive Memory + Repair

Implement:

```text
AdaptiveMemory
RepairDynamics
snapshots
rollback
repair verification
```

Acceptance criteria:

- recall works,
- reinforcement/decay works,
- duplicate consolidation works,
- repair plans are bounded,
- dangerous repairs require approval.

## Phase 3 — Cognitive Layer

Implement:

```text
GlobalWorkspace
AttentionRouter
SelfModel
MetaMonitor
TemporalContinuity
```

Acceptance criteria:

- workspace competition works,
- self-state exposes capabilities/limits,
- missing evidence is visible,
- contradictions are tracked,
- long-running threads resume.

## Phase 4 — Prediction + Conflict Resolution

Implement:

```text
PredictiveWorldModel
ConflictResolver
calibration metrics
prediction error learning
```

## Phase 5 — Learned NCA

After deterministic behavior is stable:

```text
trainable local update model
fixed vector dimensions
replay dataset
simulation sandbox
offline training
shadow mode
controlled rollout
```

Do not begin online self-modification in production before deterministic baselines and rollback are mature.

---

# 41. Testing Strategy

## Unit Tests

```text
cell normalization
edge creation
neighbor traversal
single-statement safety
state decay
reinforcement
signal TTL
fan-out limits
contradiction detection
attention ranking
workspace competition
prediction error
repair rollback
```

## Integration Tests

```text
evidence -> stimulus -> cell update
cell anomaly -> workspace candidate
workspace broadcast -> orchestrator context
repair candidate -> Engineer Loop
prediction -> action -> actual result -> prediction error
```

## Chaos Tests

```text
corrupt state file
remove evidence reference
orphan a handoff
kill a task mid-run
inject conflicting evidence
flood duplicate alerts
create circular topology
simulate stale lock
```

---

# 42. CI Requirements

Minimum CI gates:

```text
npm run typecheck
npm run build
unit tests
state migration tests
schema validation tests
safety classification tests
bounded propagation tests
```

Recommended future scripts:

```json
{
  "scripts": {
    "test:adaptive": "...",
    "test:cognition": "...",
    "test:chaos": "..."
  }
}
```

---

# 43. Configuration Reference

```env
# Adaptive persistence
CHERRY_ADAPTIVE_FILE=.cherry/adaptive.json
CHERRY_COGNITIVE_FILE=.cherry/cognitive.json

# NCA runtime
CHERRY_NCA_ENABLED=true
CHERRY_NCA_TICK_INTERVAL_MS=5000
CHERRY_NCA_MAX_CELLS_PER_TICK=1000
CHERRY_NCA_MAX_NEIGHBOR_DEPTH=2
CHERRY_NCA_STATE_VECTOR_SIZE=32
CHERRY_NCA_MAX_REPAIR_ACTIONS_PER_TICK=20

# Cognitive runtime
CHERRY_COGNITION_ENABLED=true
CHERRY_COGNITION_MAX_WORKSPACE_ITEMS=10
CHERRY_COGNITION_MAX_OPEN_THREADS=500
CHERRY_COGNITION_ATTENTION_HOLD_MS=30000
CHERRY_COGNITION_WAKE_RISK_THRESHOLD=0.85
CHERRY_COGNITION_WAKE_ANOMALY_THRESHOLD=0.85

# Memory
CHERRY_ADAPTIVE_MEMORY_DECAY_INTERVAL_MS=3600000
CHERRY_ADAPTIVE_MEMORY_CONSOLIDATION_INTERVAL_MS=86400000
```

---

# 44. Definition of Done

The NCA/Cognition layer is not considered complete until all of these are true:

```text
[ ] durable cells and topology
[ ] bounded NCA ticks
[ ] evidence-to-stimulus pipeline
[ ] state diffusion with TTL and fan-out limits
[ ] adaptive memory with provenance
[ ] repair scan / plan / execute / verify / rollback
[ ] global workspace competition
[ ] attention routing with anti-thrashing
[ ] explicit self model
[ ] meta monitoring
[ ] temporal continuity
[ ] predictive world model
[ ] conflict resolution
[ ] orchestrator integration
[ ] PWA observability
[ ] metrics
[ ] strict TypeScript CI
[ ] tests for safety and bounded execution
[ ] documentation updated with actual implementation status
```

---

# 45. Final Architecture Principle

The intended evolution is:

```text
Tool-calling Agent
        |
        v
Persistent Agentic AI
        |
        v
Multi-Agent Runtime
        |
        v
Shared Evidence + Handoffs
        |
        v
NCA Adaptive Internal State
        |
        v
Consciousness-Inspired Cognitive Coordination
        |
        v
Safer, more adaptive, more self-monitoring CherryAgent
```

The key principle is:

> **NCA gives Cherry a distributed adaptive internal state. The cognitive layer gives Cherry a structured way to prioritize, model itself, track uncertainty, maintain continuity, predict consequences, and resolve conflicts. Neither layer should bypass evidence, approval, verification, or safety controls.**
