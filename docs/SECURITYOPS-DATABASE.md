# CherryAgent SecurityOps Data Architecture

## Goal

SecurityOps is append-heavy and bursty. During DDoS, brute-force, WAF, IDS, or firewall incidents, telemetry can spike sharply. The storage design must preserve fast ingest, fast recent-event reads, explicit containment audit, and low operational complexity.

## Runtime path

```text
Linux / nftables / conntrack / nginx / Suricata / WAF
                    |
                    v
          SecurityOps tools + sensors
                    |
                    v
          Security Policy Engine
        hard deny / allow / approval
                    |
          +---------+---------+
          |                   |
          v                   v
   in-memory hot ring    batch write queue
   lowest-latency reads      250 events default
          |                   |
          +---------+---------+
                    v
          PostgreSQL durable store
        time partition + focused indexes
```

## Why PostgreSQL

PostgreSQL is the durable source of truth for:

- normalized security telemetry;
- containment actions and rollback history;
- immutable policy decisions;
- incidents and verification evidence;
- correlation by host, source IP, severity, category, and time.

The schema intentionally avoids a default GIN index on the full JSONB payload. A global JSONB GIN index is convenient for ad-hoc search but adds significant write amplification during attack bursts. Promote only repeatedly queried payload fields into typed columns or add narrow expression indexes after measuring real workloads.

## Tables

### `cherry_security.security_events`

High-rate append-only telemetry.

Important columns:

- `observed_at timestamptz`
- `id uuid`
- `host text`
- `category text`
- `severity smallint`
- `source_ip inet`
- `destination_ip inet`
- `confidence real`
- `blocked boolean`
- `evidence_count integer`
- `tags text[]`
- `payload jsonb`

Partitioned by time. The default partition prevents ingestion outage if a monthly partition was not created in advance.

### `cherry_security.security_blocks`

Durable containment ledger:

- target CIDR;
- mode: manual / auto / emergency;
- TTL and expiry;
- confidence and evidence count;
- policy version;
- execution evidence;
- explicit removed/expired/failed state.

### `cherry_security.security_policy_audit`

Immutable decision evidence for allow/deny/auto-contain evaluation.

### `cherry_security.security_incidents`

Incident lifecycle with containment, verification, rollback, and Runbook linkage.

## Index strategy

The default hot indexes are intentionally limited:

1. BRIN on event time for cheap large time-range scans.
2. `(category, observed_at DESC)` for recent category triage.
3. Partial high-severity index for urgent queues.
4. `(source_ip, observed_at DESC)` for attacker history.

Do not add indexes for every dashboard field. Measure `pg_stat_statements` and add only the indexes that support real hot queries.

## Batch ingest

`SecurityEventStore` defaults:

```text
batch size:       250 events
flush interval:   500 ms
memory ring:      10,000 events
```

This reduces process and transaction overhead compared with one PostgreSQL write per event. The current repository uses the existing database CLI abstraction, so each flush is one multi-row `INSERT` instead of one `psql` process per event.

For very high sustained rates, the next upgrade is a persistent PostgreSQL driver plus `COPY FROM STDIN` or a dedicated ingest worker. The schema does not need to change.

## Redis position

Redis is optional and is not required for durable event storage.

Use Redis only for hot ephemeral state such as:

- fleet-wide request counters;
- attacker score TTLs;
- deduplication windows;
- distributed containment locks;
- rate-limit buckets;
- short-lived leader election.

Do not make Redis the only source of truth for incidents or firewall decisions.

Recommended keys:

```text
sec:rate:{host}:{source}:{bucket}
sec:score:{source}
sec:dedupe:{fingerprint}
sec:lock:block:{target}
sec:incident:hot:{incident_id}
```

## Security policy

Every temporary block is wrapped by the hard policy engine.

Hard-deny examples:

- target is allowlisted;
- target is inside protected local/private/link-local ranges;
- CIDR is broader than policy minimum;
- requested TTL exceeds policy maximum;
- emergency mode requested while disabled.

Auto/emergency containment additionally requires minimum confidence and independent evidence counts.

The firewall tool remains `dangerous`, so the existing Approval Gate still applies unless the deployment explicitly auto-approves dangerous actions.

## Migration

Apply:

```bash
psql "$CHERRY_DB_POSTGRES_URL" -f database/security/001_securityops.sql
```

The migration creates the current and next monthly event partitions plus a safe default partition.

## Recommended production PostgreSQL settings

Start with measured workload, but the intended deployment profile is:

- dedicated PostgreSQL volume with fast NVMe;
- connection pooling when a persistent driver is introduced;
- WAL on durable storage;
- `synchronous_commit=on` for containment/audit durability;
- regular partition creation and retention jobs;
- backup of incidents, policy audit, blocks, and Runbooks;
- shorter retention for raw high-volume telemetry than for incidents/audit.

Example retention policy:

```text
raw security_events:       30-90 days
high-severity events:      180 days or archive
security_policy_audit:     1-3 years
security_blocks:           1-3 years
security_incidents:        long-term
Runbooks:                  long-term
```

## Scale path

```text
Phase 1
Single CherryAgent
in-memory ring + batch PostgreSQL

Phase 2
Multiple agents
PostgreSQL + Redis distributed counters/locks

Phase 3
Large fleet / high PPS
local edge collectors -> queue/stream -> ingest workers -> PostgreSQL partitions

Phase 4
SOC analytics at very large volume
PostgreSQL for control plane/audit/incidents
columnar or search backend for deep telemetry analytics
```

The control-plane database and the bulk telemetry analytics backend should remain separable. Firewall decisions, approvals, rollback, and incident evidence must stay in the durable control plane even if raw packet/log analytics moves elsewhere.
