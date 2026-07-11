# CherryAgent Documentation Index

เอกสารสถาปัตยกรรมและการออกแบบของ CherryAgent แบ่งตามหมวดดังนี้

## Core Architecture

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — ภาพรวม target architecture ของ CherryAgent
- [`CORRECTNESS_LOOP.md`](CORRECTNESS_LOOP.md) — independent correctness verification loop

## Desktop & Devices

- [`WINDOWS_DESKTOP_AGENT.md`](WINDOWS_DESKTOP_AGENT.md) — Windows installable AI assistant ด้วย Tauri 2, bundled Cherry backend sidecar, local native bridge, mouse/keyboard automation, monitor/window inspection, screen capture, multimodal vision, Windows speech synthesis/recognition, Approval Inbox, installer build pipeline และ operator guide

## Finance & Data Platform

- [`FINANCE_BIGDATA_DATABASE_ARCHITECTURE.md`](FINANCE_BIGDATA_DATABASE_ARCHITECTURE.md) — สถาปัตยกรรมฐานข้อมูล Personal Finance + SME Finance แบบ production-scale ครอบคลุม PostgreSQL OLTP/double-entry ledger, ClickHouse OLAP, Redis hot state/cache, Kafka event backbone, MinIO/S3 data lake, multi-tenancy, partitioning, sharding, idempotency, transactional outbox, audit, NCA integration และ mapping ฟังก์ชันกับตารางทีละหมวด

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
