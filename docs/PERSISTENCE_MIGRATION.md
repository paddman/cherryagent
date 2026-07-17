# PostgreSQL/Redis Persistence Migration

## Overview

This document outlines the migration from local JSON persistence to PostgreSQL + Redis for multi-user production support.

## What's New

### Multi-User Support
- ✅ Concurrent user access with ACID transactions
- ✅ Tenant isolation at database level
- ✅ Row-level security ready

### Features Enabled
- ✅ Multi-user concurrency control via PostgreSQL locks
- ✅ Distributed transactions across Engineer Loop and Planner state
- ✅ Audit trail persistence for all operations
- ✅ High-volume analytics via efficient schema design
- ✅ NCA adaptive state persistence
- ✅ Approval inbox persistence

### Architecture

```
┌─────────────────────────────────────────┐
│       Cherry Agent Application           │
├─────────────────────────────────────────┤
│         Persistence Layer API            │
│  (planner, engineer, approvals, audit)   │
├─────────────┬───────────────────────────┤
│  PostgreSQL │      Redis               │
│             │   (hot cache, locks)     │
│  - Ledger   │   - Short-lived state    │
│  - History  │   - Idempotency keys     │
│  - Audit    │   - Distributed locks    │
└─────────────┴───────────────────────────┘
```

## Directory Structure

```
src/persistence/
├── database/
│   ├── schema.ts          # PostgreSQL schema definitions
│   └── postgres.ts        # Connection pool & initialization
├── redis/
│   └── client.ts          # Redis client for cache & locks
├── planner/
│   └── store.ts           # Planner items, reminders, alerts
├── engineer/
│   └── store.ts           # Engineer loops, phases, runbooks
├── approvals/
│   └── store.ts           # Approval inbox & decisions
├── audit/
│   └── store.ts           # Audit trail for all operations
└── index.ts               # Unified persistence API
```

## Database Schemas

### Identity Schema
- `identity.tenants` — Tenant metadata
- `identity.users` — User accounts
- `identity.memberships` — User-tenant relationships with roles

### Planning Schema
- `planning.items` — Tasks/work items with flow states
- `planning.reminders` — Recurring schedules (once, interval, cron)
- `planning.alerts` — Notifications and snoozed reminders

### Engineer Schema
- `engineer.loops` — Active/completed engineering incidents
- `engineer.phase_events` — Phase transitions with evidence
- `engineer.runbooks` — Learned incidents for future reuse

### Approvals Schema
- `approvals.inbox` — External/dangerous action requests

### Audit Schema
- `audit.logs` — Comprehensive operation trail
- `audit.outbox` — Transactional outbox for event fan-out

## Usage

### Initialize Persistence Layer

```typescript
import { initPersistence } from './persistence';

const persistence = initPersistence({
  postgres: {
    host: process.env.CHERRY_POSTGRES_HOST,
    port: parseInt(process.env.CHERRY_POSTGRES_PORT),
    database: process.env.CHERRY_POSTGRES_DATABASE,
    user: process.env.CHERRY_POSTGRES_USER,
    password: process.env.CHERRY_POSTGRES_PASSWORD,
  },
  redis: {
    host: process.env.CHERRY_REDIS_HOST,
    port: parseInt(process.env.CHERRY_REDIS_PORT),
    password: process.env.CHERRY_REDIS_PASSWORD,
  },
});

await persistence.initialize();
```

### Use Planner Store

```typescript
const { planner } = getPersistence();

// Create item
const item = await planner.createItem(tenantId, {
  title: 'Fix bug in auth handler',
  status: 'planned',
  priority: 'high',
  dueAt: new Date('2024-01-15'),
  timezone: 'Asia/Bangkok',
  tags: ['bug', 'auth'],
  dependencies: [],
});

// Get dashboard
const dashboard = await planner.getDashboard(tenantId);
// { items: { inbox: 3, planned: 5, doing: 2, ... }, activeReminders: 8, unreadAlerts: 2 }
```

### Use Engineer Store

```typescript
const { engineer } = getPersistence();

// Start loop
const loop = await engineer.startLoop(
  tenantId,
  'Fix HTTP 524 on trading journal',
  [
    'Health endpoint returns HTTP 200',
    'Journal request completes under proxy timeout',
    'No new 524 during verification',
  ],
  5 // max iterations
);

// Record phase
await engineer.recordPhase(loop.id, 'diagnose', 1, {
  summary: 'Analyzing request latency',
  toolUsed: 'curl',
  command: 'curl -w "@/tmp/curl-format.txt" ...',
  output: 'Total time: 45.3s (upstream: 43.2s)',
});

// Complete loop
await engineer.completeLoop(loop.id, 'succeeded', {
  rootCause: 'Synchronous database query blocking event loop',
  fixApplied: 'Moved query to background worker',
  prevention: 'Added query timeout enforcement',
});

// Save runbook
await engineer.saveRunbook(tenantId, loop.id, {
  title: 'Fix blocking queries in trading journal',
  symptoms: 'HTTP 524 timeout on journal endpoint',
  rootCause: 'Synchronous database operation blocking event loop',
  fix: 'Move query to background worker queue',
  prevention: 'Enforce max query timeout at application layer',
});
```

### Use Approval Store

```typescript
const { approvals } = getPersistence();

// Create approval request
const approval = await approvals.createRequest(tenantId, {
  actionType: 'send_email',
  resourceType: 'email_draft',
  resourceId: 'draft-123',
  description: 'Send email to external customer',
  riskLevel: 'external',
});

// List pending
const pending = await approvals.listPendingRequests(tenantId);

// Approve
await approvals.approveRequest(tenantId, approval.id, userId, 'Verified with customer');
```

### Use Audit Store

```typescript
const { audit } = getPersistence();

// Log operation
await audit.log(tenantId, {
  userId: currentUserId,
  agentName: 'cherry-agent',
  actionType: 'tool_execution',
  resourceType: 'engineer_loop',
  resourceId: loop.id,
  toolName: 'curl',
  riskLevel: 'external',
  status: 'success',
  durationMs: 2341,
  verificationResult: { statusCode: 200 },
});

// Get resource history
const history = await audit.getAuditTrail(tenantId, {
  resourceType: 'engineer_loop',
  resourceId: loop.id,
  limit: 50,
});
```

## Migration Path

### Phase 1: Development (Current)
- ✅ PostgreSQL schema + migration system
- ✅ Redis connection pooling
- ✅ Store implementations for planner, engineer, approvals, audit
- ✅ Type definitions

### Phase 2: API Integration
- Create HTTP endpoints wrapping persistence stores
- Add tenant context middleware
- Implement request validation
- Add WebSocket support for real-time updates

### Phase 3: Migration Tools
- Export JSON state to PostgreSQL
- Data validation and reconciliation
- Rollback capability

### Phase 4: Production Deployment
- PostgreSQL HA setup (primary + replicas)
- Redis Cluster for distributed cache
- Monitoring and observability
- Load testing and capacity planning

## Data Integrity

### ACID Guarantees
- **Atomicity**: Transactions are all-or-nothing
- **Consistency**: Constraints enforced (e.g., loop status transitions)
- **Isolation**: Concurrent users isolated by tenant_id
- **Durability**: Writes persisted to disk

### Audit Trail
All operations logged to `audit.logs`:
- Who executed the operation
- What changed
- When it happened
- Success/failure status
- Duration and performance metrics
- Tool-level details and evidence

## Performance Considerations

### Indexes
Critical indexes already defined:
- Tenant-based queries (every table has `tenant_id` index)
- Status/state queries (status, phase, current conditions)
- Time-based queries (created_at, next_run_at for schedulers)
- Foreign key lookups (loop_id, item_id, user_id)

### Redis Caching
- Engineer loops cached for 1 hour (hot access pattern)
- Planner items cached for 5 minutes (moderate change frequency)
- Reminders checked on each scheduler tick
- Cache invalidated on mutations

### Partitioning (Future)
For massive scale (billions of rows):
```sql
-- Partition by month + tenant
CREATE TABLE audit.logs_2024_01
PARTITION OF audit.logs
FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
```

## Testing

### Local Development Setup
```bash
# Start PostgreSQL
docker run -d \
  --name postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=cherry_agent \
  -p 5432:5432 \
  postgres:15-alpine

# Start Redis
docker run -d \
  --name redis \
  -p 6379:6379 \
  redis:7-alpine

# Initialize database
node -r ts-node/register scripts/init-db.ts
```

### Unit Tests
```bash
npm test -- src/persistence
```

## Monitoring

Key metrics to track:
- PostgreSQL connection pool usage
- Redis cache hit rate
- Lock contention (exclusive locks on loops)
- Query latencies (p50, p95, p99)
- Audit log volume

## Next Steps

1. ✅ Create database schema and persistence stores
2. → Integrate with API layer (HTTP endpoints)
3. → Add WebSocket for real-time updates
4. → Migration tools for existing JSON state
5. → HA deployment configuration
6. → Monitoring and alerting
