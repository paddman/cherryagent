# CherryAgent Documentation Index

เอกสารสถาปัตยกรรมและการออกแบบของ CherryAgent แบ่งตามหมวดดังนี้

## Core Architecture

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — ภาพรวม target architecture ของ CherryAgent
- [`CORRECTNESS_LOOP.md`](CORRECTNESS_LOOP.md) — independent correctness verification loop

## Adaptive Intelligence

- [`NCA_MACHINE_CONSCIOUSNESS_ARCHITECTURE.md`](NCA_MACHINE_CONSCIOUSNESS_ARCHITECTURE.md) — รายละเอียด NCA Adaptive System และ Consciousness-Inspired Cognitive Layer แบบแยกหมวด class/function, state model, input/output, event, failure mode, metrics, API, tools, integration, roadmap และ definition of done

## NCA / Cognitive Function Groups

เอกสาร NCA หลักแบ่งฟังก์ชันเป็นหมวด:

1. `CellTopology`
2. `NeuralCellularField`
3. `CellUpdateRule`
4. `StateDiffusion`
5. `AdaptiveMemory`
6. `RepairDynamics`
7. `EnvironmentalAdapter`
8. `GlobalWorkspace`
9. `AttentionRouter`
10. `SelfModel`
11. `MetaMonitor`
12. `TemporalContinuity`
13. `PredictiveWorldModel`
14. `ConflictResolver`
15. `CognitiveRuntime`

สถานะต้องอ่านตามที่ระบุในแต่ละเอกสาร: feature ที่เป็น design/spec จะไม่ถือว่า implemented จนกว่าจะมี runtime code, tests และ CI ผ่านจริง
