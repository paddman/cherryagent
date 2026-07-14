-- CherryAgent SecurityOps database schema
-- Optimized for high-rate append-heavy telemetry, recent-event queries, source-IP lookups,
-- containment audit, and low write amplification.

CREATE SCHEMA IF NOT EXISTS cherry_security;

CREATE TABLE IF NOT EXISTS cherry_security.security_events (
  observed_at timestamptz NOT NULL,
  id uuid NOT NULL,
  host text NOT NULL,
  category text NOT NULL,
  severity smallint NOT NULL DEFAULT 5 CHECK (severity BETWEEN 0 AND 10),
  action text,
  source_ip inet,
  destination_ip inet,
  confidence real CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  blocked boolean NOT NULL DEFAULT false,
  evidence_count integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (observed_at, id)
) PARTITION BY RANGE (observed_at);

-- Zero-downtime safety partition. Production should create monthly partitions ahead of time.
CREATE TABLE IF NOT EXISTS cherry_security.security_events_default
  PARTITION OF cherry_security.security_events DEFAULT;

-- Cheap time-range acceleration for append-heavy data.
CREATE INDEX IF NOT EXISTS security_events_default_observed_brin
  ON cherry_security.security_events_default USING brin (observed_at)
  WITH (pages_per_range = 64);

-- Hot operational queries. Keep index count intentionally small to preserve ingest speed.
CREATE INDEX IF NOT EXISTS security_events_default_category_time_idx
  ON cherry_security.security_events_default (category, observed_at DESC);

CREATE INDEX IF NOT EXISTS security_events_default_severity_time_idx
  ON cherry_security.security_events_default (severity DESC, observed_at DESC)
  WHERE severity >= 7;

CREATE INDEX IF NOT EXISTS security_events_default_source_time_idx
  ON cherry_security.security_events_default (source_ip, observed_at DESC)
  WHERE source_ip IS NOT NULL;

CREATE TABLE IF NOT EXISTS cherry_security.security_blocks (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  removed_at timestamptz,
  host text NOT NULL,
  target cidr NOT NULL,
  reason text,
  mode text NOT NULL CHECK (mode IN ('manual', 'auto', 'emergency')),
  confidence real CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  evidence_count integer NOT NULL DEFAULT 0,
  policy_version text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'removed', 'failed')),
  execution jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS security_blocks_active_target_idx
  ON cherry_security.security_blocks (target, expires_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS security_blocks_created_brin
  ON cherry_security.security_blocks USING brin (created_at);

CREATE TABLE IF NOT EXISTS cherry_security.security_policy_audit (
  decided_at timestamptz NOT NULL DEFAULT now(),
  id uuid NOT NULL,
  host text NOT NULL,
  action text NOT NULL,
  target text,
  mode text NOT NULL,
  allowed boolean NOT NULL,
  hard_deny boolean NOT NULL,
  auto_contain_eligible boolean NOT NULL,
  confidence real,
  evidence_count integer NOT NULL DEFAULT 0,
  policy_version text NOT NULL,
  reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (decided_at, id)
) PARTITION BY RANGE (decided_at);

CREATE TABLE IF NOT EXISTS cherry_security.security_policy_audit_default
  PARTITION OF cherry_security.security_policy_audit DEFAULT;

CREATE INDEX IF NOT EXISTS security_policy_audit_default_time_brin
  ON cherry_security.security_policy_audit_default USING brin (decided_at)
  WITH (pages_per_range = 64);

CREATE TABLE IF NOT EXISTS cherry_security.security_incidents (
  id uuid PRIMARY KEY,
  opened_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  host text NOT NULL,
  title text NOT NULL,
  category text NOT NULL,
  severity smallint NOT NULL CHECK (severity BETWEEN 0 AND 10),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'contained', 'monitoring', 'closed')),
  confidence real CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  source_ips inet[] NOT NULL DEFAULT ARRAY[]::inet[],
  summary text,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  containment jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification jsonb NOT NULL DEFAULT '{}'::jsonb,
  rollback jsonb NOT NULL DEFAULT '{}'::jsonb,
  runbook_id text
);

CREATE INDEX IF NOT EXISTS security_incidents_open_severity_idx
  ON cherry_security.security_incidents (severity DESC, updated_at DESC)
  WHERE status <> 'closed';

-- Creates one monthly event partition and its focused indexes.
CREATE OR REPLACE FUNCTION cherry_security.ensure_security_event_partition(month_start date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  partition_start date := date_trunc('month', month_start)::date;
  partition_end date := (partition_start + interval '1 month')::date;
  partition_name text := format('security_events_%s', to_char(partition_start, 'YYYYMM'));
  full_name text := format('cherry_security.%I', partition_name);
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %s PARTITION OF cherry_security.security_events FOR VALUES FROM (%L) TO (%L)',
    full_name,
    partition_start,
    partition_end
  );
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s USING brin (observed_at) WITH (pages_per_range = 64)', partition_name || '_time_brin', full_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (category, observed_at DESC)', partition_name || '_category_time_idx', full_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (source_ip, observed_at DESC) WHERE source_ip IS NOT NULL', partition_name || '_source_time_idx', full_name);
  RETURN full_name;
END;
$$;

-- Recommended initial partitions. Run again monthly or schedule externally.
SELECT cherry_security.ensure_security_event_partition(current_date);
SELECT cherry_security.ensure_security_event_partition((current_date + interval '1 month')::date);

COMMENT ON TABLE cherry_security.security_events IS
  'Append-heavy normalized SecurityOps telemetry. Payload remains JSONB without a default GIN index to protect ingest throughput.';

COMMENT ON TABLE cherry_security.security_blocks IS
  'Durable containment ledger for temporary firewall actions and explicit rollback tracking.';

COMMENT ON TABLE cherry_security.security_policy_audit IS
  'Immutable policy decision evidence for block/allow/escalate decisions.';
