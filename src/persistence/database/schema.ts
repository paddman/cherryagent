/**
 * PostgreSQL Schema Definitions
 * 
 * Database schema for multi-user production Cherry Agent
 * Replaces local JSON persistence with ACID-compliant PostgreSQL
 */

export const SCHEMA = `
-- ============================================
-- 1. IDENTITY SCHEMA
-- ============================================

CREATE SCHEMA IF NOT EXISTS identity;

-- Tenants: top-level isolation boundary
CREATE TABLE IF NOT EXISTS identity.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(32) NOT NULL DEFAULT 'personal',
  name TEXT NOT NULL,
  base_currency CHAR(3) NOT NULL DEFAULT 'USD',
  timezone TEXT NOT NULL DEFAULT 'Asia/Bangkok',
  country_code CHAR(2),
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_type_check CHECK (type IN ('personal', 'household', 'sme', 'enterprise'))
);

CREATE INDEX idx_tenants_status ON identity.tenants(status, created_at);

-- Users
CREATE TABLE IF NOT EXISTS identity.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Memberships: user -> tenant with roles
CREATE TABLE IF NOT EXISTS identity.memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL DEFAULT 'staff',
  permissions_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, user_id),
  CONSTRAINT role_check CHECK (role IN ('owner', 'admin', 'accountant', 'staff', 'viewer', 'agent'))
);

CREATE INDEX idx_memberships_tenant ON identity.memberships(tenant_id);
CREATE INDEX idx_memberships_user ON identity.memberships(user_id);

-- ============================================
-- 2. PLANNING SCHEMA (Planner)
-- ============================================

CREATE SCHEMA IF NOT EXISTS planning;

-- Planner Items (Tasks/Work)
CREATE TABLE IF NOT EXISTS planning.items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'inbox',
  priority VARCHAR(32) NOT NULL DEFAULT 'normal',
  flow_id UUID,
  start_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  duration_minutes INTEGER,
  timezone TEXT DEFAULT 'Asia/Bangkok',
  tags JSONB DEFAULT '[]',
  dependencies JSONB DEFAULT '[]',
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT status_check CHECK (status IN ('inbox', 'planned', 'doing', 'waiting', 'done', 'cancelled')),
  CONSTRAINT priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
);

CREATE INDEX idx_planning_items_tenant ON planning.items(tenant_id);
CREATE INDEX idx_planning_items_status ON planning.items(tenant_id, status);
CREATE INDEX idx_planning_items_due ON planning.items(tenant_id, due_at);

-- Reminders/Alerts
CREATE TABLE IF NOT EXISTS planning.reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants(id) ON DELETE CASCADE,
  item_id UUID REFERENCES planning.items(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  schedule_kind VARCHAR(32) NOT NULL,
  schedule_spec_json JSONB NOT NULL,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  channels JSONB DEFAULT '["in_app", "browser"]',
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT schedule_kind_check CHECK (schedule_kind IN ('once', 'interval', 'daily', 'weekdays', 'weekly', 'monthly', 'cron'))
);

CREATE INDEX idx_planning_reminders_tenant ON planning.reminders(tenant_id);
CREATE INDEX idx_planning_reminders_next_run ON planning.reminders(tenant_id, next_run_at);

-- Alerts/Notifications
CREATE TABLE IF NOT EXISTS planning.alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants(id) ON DELETE CASCADE,
  reminder_id UUID REFERENCES planning.reminders(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT,
  priority VARCHAR(32) DEFAULT 'normal',
  read_at TIMESTAMPTZ,
  snoozed_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_planning_alerts_tenant ON planning.alerts(tenant_id);
CREATE INDEX idx_planning_alerts_read ON planning.alerts(tenant_id, read_at);

-- ============================================
-- 3. ENGINEER LOOP SCHEMA
-- ============================================

CREATE SCHEMA IF NOT EXISTS engineer;

-- Engineer Loops
CREATE TABLE IF NOT EXISTS engineer.loops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  success_criteria JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  current_phase VARCHAR(32) NOT NULL DEFAULT 'plan',
  current_iteration INTEGER NOT NULL DEFAULT 1,
  max_iterations INTEGER NOT NULL DEFAULT 5,
  hypothesis TEXT,
  root_cause TEXT,
  fix_applied TEXT,
  rollback_plan TEXT,
  prevention TEXT,
  phase_history JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT status_check CHECK (status IN ('running', 'blocked', 'succeeded', 'failed', 'aborted')),
  CONSTRAINT phase_check CHECK (current_phase IN ('plan', 'execute', 'observe', 'diagnose', 'patch', 'test', 'verify', 'learn', 'complete'))
);

CREATE INDEX idx_engineer_loops_tenant ON engineer.loops(tenant_id);
CREATE INDEX idx_engineer_loops_status ON engineer.loops(tenant_id, status);

-- Phase Events
CREATE TABLE IF NOT EXISTS engineer.phase_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loop_id UUID NOT NULL REFERENCES engineer.loops(id) ON DELETE CASCADE,
  phase VARCHAR(32) NOT NULL,
  iteration INTEGER NOT NULL,
  summary TEXT,
  tool_used TEXT,
  command TEXT,
  output TEXT,
  error TEXT,
  evidence JSONB,
  verification_evidence JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_engineer_phase_events_loop ON engineer.phase_events(loop_id);
CREATE INDEX idx_engineer_phase_events_phase ON engineer.phase_events(loop_id, phase);

-- Runbooks: learned from successful incidents
CREATE TABLE IF NOT EXISTS engineer.runbooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants(id) ON DELETE CASCADE,
  loop_id UUID REFERENCES engineer.loops(id),
  title TEXT NOT NULL,
  symptoms TEXT,
  root_cause TEXT,
  fix TEXT,
  diagnostic_evidence JSONB,
  verification_evidence JSONB,
  rollback_instructions TEXT,
  prevention TEXT,
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_engineer_runbooks_tenant ON engineer.runbooks(tenant_id);

-- ============================================
-- 4. APPROVAL SCHEMA
-- ============================================

CREATE SCHEMA IF NOT EXISTS approvals;

CREATE TABLE IF NOT EXISTS approvals.inbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants(id) ON DELETE CASCADE,
  action_type VARCHAR(64) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(255) NOT NULL,
  description TEXT,
  risk_level VARCHAR(32) NOT NULL DEFAULT 'external',
  details_json JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  approved_at TIMESTAMPTZ,
  approved_by_user_id UUID REFERENCES identity.users(id),
  approval_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT risk_check CHECK (risk_level IN ('safe', 'write', 'external', 'dangerous'))
);

CREATE INDEX idx_approvals_tenant ON approvals.inbox(tenant_id);
CREATE INDEX idx_approvals_status ON approvals.inbox(tenant_id, status);

-- ============================================
-- 5. AUDIT SCHEMA
-- ============================================

CREATE SCHEMA IF NOT EXISTS audit;

-- Comprehensive audit log
CREATE TABLE IF NOT EXISTS audit.logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES identity.users(id),
  agent_name VARCHAR(255),
  action_type VARCHAR(64) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(255) NOT NULL,
  tool_name VARCHAR(255),
  risk_level VARCHAR(32),
  status VARCHAR(32) NOT NULL DEFAULT 'success',
  duration_ms INTEGER,
  details_json JSONB,
  error_message TEXT,
  verification_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT status_check CHECK (status IN ('success', 'failure', 'pending'))
);

CREATE INDEX idx_audit_logs_tenant ON audit.logs(tenant_id);
CREATE INDEX idx_audit_logs_created ON audit.logs(tenant_id, created_at DESC);
CREATE INDEX idx_audit_logs_resource ON audit.logs(tenant_id, resource_type, resource_id);

-- Transactional outbox for event fan-out
CREATE TABLE IF NOT EXISTS audit.outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants(id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_tenant ON audit.outbox(tenant_id);
CREATE INDEX idx_outbox_published ON audit.outbox(tenant_id, published_at) WHERE published_at IS NULL;
`;

export const MIGRATION_VERSION = '001';
