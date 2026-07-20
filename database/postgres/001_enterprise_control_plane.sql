-- Cherry Enterprise AI Workforce control-plane contract.
-- The current single-node runtime uses .cherry/*.json. Apply this migration
-- before enabling multiple production tenants, then move repositories and
-- event delivery behind PostgreSQL transactions + Redis streams/locks.

create table if not exists cherry_organizations (
  id text primary key,
  name text not null,
  slug text not null unique,
  plan text not null check (plan in ('pilot', 'shared', 'enterprise', 'dedicated')),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists cherry_memberships (
  id text primary key,
  tenant_id text not null references cherry_organizations(id),
  user_id text not null,
  role text not null check (role in ('admin', 'user', 'viewer')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table if not exists cherry_usage_events (
  id text primary key,
  tenant_id text not null references cherry_organizations(id),
  user_id text not null,
  kind text not null check (kind in ('tool_call', 'workflow_run', 'office_inbox')),
  units integer not null check (units > 0),
  tool text,
  risk text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists cherry_usage_budgets (
  tenant_id text primary key references cherry_organizations(id),
  monthly_credits integer not null check (monthly_credits > 0),
  updated_at timestamptz not null default now()
);

create table if not exists cherry_office_inbox (
  id text primary key,
  tenant_id text not null references cherry_organizations(id),
  source text not null check (source in ('gmail')),
  external_id text not null,
  thread_id text,
  subject text not null,
  sender text not null default '',
  recipient text,
  message_date timestamptz,
  snippet text not null default '',
  status text not null check (status in ('new', 'triaged', 'ignored')),
  plan_item_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, source, external_id)
);

create table if not exists cherry_agent_runs (
  id text primary key,
  tenant_id text not null references cherry_organizations(id),
  job_id text not null,
  trace_id text not null,
  goal text not null,
  status text not null,
  round integer not null default 1,
  tags jsonb not null default '[]'::jsonb,
  synthesis text,
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists cherry_agent_tasks (
  id text primary key,
  run_id text not null references cherry_agent_runs(id) on delete cascade,
  tenant_id text not null references cherry_organizations(id),
  span_id text not null,
  task_key text not null,
  role text not null,
  objective text not null,
  depends_on jsonb not null default '[]'::jsonb,
  status text not null,
  progress jsonb,
  handoff_id text,
  result text,
  error text,
  evidence_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, task_key)
);

create table if not exists cherry_agent_evidence (
  id text primary key,
  run_id text not null references cherry_agent_runs(id) on delete cascade,
  task_id text,
  tenant_id text not null references cherry_organizations(id),
  agent text not null,
  kind text not null,
  claim text not null,
  data jsonb,
  source_tool text,
  confidence numeric not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists cherry_agent_logs (
  id text primary key,
  tenant_id text not null references cherry_organizations(id),
  job_id text not null,
  run_id text not null references cherry_agent_runs(id) on delete cascade,
  trace_id text not null,
  task_id text,
  sequence bigint not null,
  level text not null,
  action text not null,
  message text not null,
  tags jsonb not null default '[]'::jsonb,
  tool text,
  step integer,
  max_steps integer,
  data jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, sequence)
);

create index if not exists cherry_usage_events_tenant_month_idx on cherry_usage_events (tenant_id, created_at);
create index if not exists cherry_office_inbox_tenant_status_idx on cherry_office_inbox (tenant_id, status, updated_at desc);
create index if not exists cherry_agent_runs_tenant_updated_idx on cherry_agent_runs (tenant_id, updated_at desc);
create index if not exists cherry_agent_logs_run_sequence_idx on cherry_agent_logs (run_id, sequence desc);

-- Set app.tenant_id on every pooled connection after authentication. These
-- policies are defense-in-depth; repositories must still include tenant_id
-- in every query and cache key.
alter table cherry_usage_events enable row level security;
alter table cherry_usage_budgets enable row level security;
alter table cherry_office_inbox enable row level security;
alter table cherry_agent_runs enable row level security;
alter table cherry_agent_tasks enable row level security;
alter table cherry_agent_evidence enable row level security;
alter table cherry_agent_logs enable row level security;

create policy cherry_usage_events_tenant_policy on cherry_usage_events
  using (tenant_id = current_setting('app.tenant_id', true));
create policy cherry_usage_budgets_tenant_policy on cherry_usage_budgets
  using (tenant_id = current_setting('app.tenant_id', true));
create policy cherry_office_inbox_tenant_policy on cherry_office_inbox
  using (tenant_id = current_setting('app.tenant_id', true));
create policy cherry_agent_runs_tenant_policy on cherry_agent_runs
  using (tenant_id = current_setting('app.tenant_id', true));
create policy cherry_agent_tasks_tenant_policy on cherry_agent_tasks
  using (tenant_id = current_setting('app.tenant_id', true));
create policy cherry_agent_evidence_tenant_policy on cherry_agent_evidence
  using (tenant_id = current_setting('app.tenant_id', true));
create policy cherry_agent_logs_tenant_policy on cherry_agent_logs
  using (tenant_id = current_setting('app.tenant_id', true));
