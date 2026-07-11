# CherryAgent Personal + SME Finance Big-Data Database Architecture

> Status: **Architecture / implementation specification**
>
> This document defines the production-oriented data architecture for CherryAgent Personal Finance, SME Finance, Financial Intelligence, Agentic AI, NCA adaptive state, audit, and analytics workloads.
>
> The design prioritizes **financial correctness, immutable auditability, low-latency reads, high ingest throughput, horizontal scalability, tenant isolation, and AI-ready historical data**.

---

# 1. Design Goals

The system should support:

- personal income and expense tracking,
- household finance,
- SME income and expense,
- invoices and bills,
- accounts receivable and accounts payable,
- payments and allocation,
- bank and wallet accounts,
- budgets and financial goals,
- cash-flow reporting,
- profit and loss,
- balance summaries,
- net worth,
- recurring transactions,
- document ingestion,
- OCR/import pipelines,
- anomaly detection,
- financial forecasting,
- financial risk signals,
- Agentic AI workflows,
- NCA adaptive cells,
- multi-agent evidence,
- full audit history,
- real-time and historical analytics.

The architecture is designed around the principle:

> **Financial truth must be transactional and immutable; analytics must be independently scalable; AI state must not corrupt accounting truth.**

---

# 2. Recommended Data Platform

```text
                        Users / APIs / Agents / Imports
                                     |
                                     v
                         +------------------------+
                         |   Finance API Layer    |
                         | Validation / Auth / ACL|
                         +-----------+------------+
                                     |
                         Command + Query separation
                                     |
                +--------------------+--------------------+
                |                    |                    |
                v                    v                    v
        +---------------+    +---------------+    +---------------+
        | PostgreSQL    |    | Redis         |    | MinIO / S3    |
        | Source of     |    | Hot State     |    | Documents     |
        | Truth         |    | Cache / Locks |    | Raw Imports   |
        +-------+-------+    +-------+-------+    +-------+-------+
                |                    |                    |
                +--------------------+--------------------+
                                     |
                                     v
                              Transactional Outbox
                                     |
                                     v
                              +--------------+
                              | Kafka/Event  |
                              | Backbone     |
                              +------+-------+
                                     |
                 +-------------------+-------------------+
                 |                   |                   |
                 v                   v                   v
        +----------------+   +---------------+   +----------------+
        | ClickHouse     |   | NCA Adaptive  |   | Agentic Core   |
        | OLAP / BigData |   | State Runtime |   | Evidence/Tasks |
        +----------------+   +---------------+   +----------------+
```

## 2.1 Technology Responsibilities

| Technology | Responsibility | Must not be used as |
|---|---|---|
| PostgreSQL | Financial source of truth, ledger, invoices, payments, budgets, goals, tenant metadata | giant historical OLAP engine for every dashboard query |
| ClickHouse | Real-time analytics, history, aggregates, anomaly features, BI, large scans | transactional accounting source of truth |
| Redis | Hot cache, idempotency, short-lived locks, rate limits, active attention/NCA hot state | durable financial ledger |
| Kafka | Durable event stream, asynchronous fan-out, analytics ingestion, AI stimuli | primary relational database |
| MinIO/S3 | Statements, receipts, PDFs, OCR source files, Parquet, export archives | row-level transactional ledger |

---

# 3. Scale Targets

These are **design targets, not performance guarantees**. Final capacity must be validated with benchmark data, hardware, network, storage, query patterns, and tenant distribution.

## 3.1 Initial Scale Envelope

```text
Tenants                  100,000+
Users                    1,000,000+
Financial transactions   1 billion+
Ledger lines             2-10 billion+
Documents                100 million+
Events/day               100 million+
Analytics history        multi-year
```

## 3.2 Recommended Deployment Tiers

### Tier A — MVP / Small Production

```text
PostgreSQL primary + replica
Redis
MinIO/S3
No Kafka required initially
No ClickHouse required initially
```

Use this while data volume and analytics load remain moderate.

### Tier B — Scale

```text
PostgreSQL HA
Redis HA
Kafka cluster
ClickHouse cluster
Distributed MinIO/S3
Read replicas
Background ingestion workers
```

### Tier C — Massive Multi-Tenant

```text
Tenant Directory Service
Multiple PostgreSQL shards
Kafka cluster with tenant-keyed partitions
ClickHouse distributed cluster
Redis Cluster
Distributed object storage
Dedicated large-tenant shards when required
```

---

# 4. Financial Correctness Model

Cherry must not model money as a mutable balance only.

The canonical model is:

```text
User-visible Transaction
        |
        v
Journal Entry
        |
        +----------------------+
        |                      |
        v                      v
Debit Journal Line       Credit Journal Line
        |
        v
Derived account balance
```

## 4.1 Double-Entry Rule

Every posted journal entry must balance:

```text
SUM(debit) = SUM(credit)
```

Examples:

### Personal Expense

```text
Debit   Expense:Food       500 THB
Credit  Asset:Bank         500 THB
```

### Salary Income

```text
Debit   Asset:Bank       50,000 THB
Credit  Income:Salary    50,000 THB
```

### SME Invoice Issued

```text
Debit   Accounts Receivable   100,000 THB
Credit  Revenue               100,000 THB
```

### SME Customer Payment

```text
Debit   Cash/Bank              100,000 THB
Credit  Accounts Receivable    100,000 THB
```

## 4.2 Immutability Rule

Posted ledger entries are immutable.

Never:

```text
UPDATE posted journal amount
DELETE posted journal line
```

Corrections use:

```text
Original entry
    -> Reversal entry
    -> Correct replacement entry
```

This preserves auditability.

---

# 5. Multi-Tenant Model

Every business-domain table must include:

```text
tenant_id
```

Recommended tenant types:

```text
personal
household
sme
enterprise
```

## 5.1 Tenant Isolation

Use:

- mandatory `tenant_id` filters,
- PostgreSQL Row Level Security where appropriate,
- per-request tenant context,
- tenant-aware cache keys,
- tenant-aware Kafka partition keys,
- tenant-aware object prefixes,
- per-tenant encryption policies for sensitive deployments.

Never accept `tenant_id` directly from an untrusted client without authorization checks.

## 5.2 Shard Key

Recommended shard key:

```text
tenant_id
```

Reason:

- all financial writes for one tenant remain local,
- ledger posting stays on one shard,
- invoice/payment/account operations remain transactional,
- avoids cross-shard financial transactions.

Large enterprise tenants may be moved to dedicated shards.

---

# 6. Identifier Strategy

Use application-generated UUIDv7-compatible identifiers for externally visible entities.

Recommended properties:

- globally unique,
- time sortable,
- safe across shards,
- no central sequence dependency.

Examples:

```text
tenant_id
account_id
transaction_id
journal_entry_id
invoice_id
payment_id
event_id
evidence_id
```

Do not expose sequential internal IDs as security boundaries.

---

# 7. Money Representation

Never use floating point for accounting amounts.

Recommended core representation:

```text
amount_minor BIGINT
currency_code CHAR(3)
```

Examples:

```text
50000 THB minor units -> 500.00 THB
1999 USD minor units  -> 19.99 USD
```

For assets requiring variable precision:

```text
quantity NUMERIC(38,18)
asset_code VARCHAR(32)
```

Recommended rule:

- accounting amount: integer minor units,
- crypto/security quantity: exact decimal,
- valuation: explicit quote currency + timestamp + price source.

---

# 8. PostgreSQL Logical Schemas

Recommended schema groups:

```text
identity
finance
sme
planning
intelligence
agentic
adaptive
system
```

---

# 9. Identity Schema

## 9.1 `identity.tenants`

Purpose: top-level financial isolation boundary.

```text
id                  uuid primary key
type                personal | household | sme | enterprise
name                text
base_currency       char(3)
timezone            text
country_code        char(2)
status              active | suspended | closed
created_at          timestamptz
updated_at          timestamptz
```

Indexes:

```text
PK(id)
INDEX(status, created_at)
```

## 9.2 `identity.users`

```text
id
email
name
status
created_at
updated_at
```

## 9.3 `identity.memberships`

```text
id
tenant_id
user_id
role
permissions_json
created_at
```

Unique constraint:

```text
UNIQUE(tenant_id, user_id)
```

Roles:

```text
owner
admin
accountant
staff
viewer
agent
```

---

# 10. Finance Core Schema

## 10.1 `finance.accounts`

Represents bank accounts, cash, cards, loans, receivables, payables, revenue, expense categories, equity, and virtual accounting accounts.

```text
id                  uuid
tenant_id           uuid
parent_account_id   uuid nullable
account_code        varchar(64)
name                text
account_type        asset | liability | equity | income | expense
subtype             text
currency_code       char(3)
institution_name    text nullable
external_ref        text nullable
is_system           boolean
is_active           boolean
created_at          timestamptz
updated_at          timestamptz
```

Unique:

```text
UNIQUE(tenant_id, account_code)
```

Critical indexes:

```text
(tenant_id, account_type, is_active)
(tenant_id, parent_account_id)
```

## 10.2 `finance.categories`

User-facing classification layer.

```text
id
tenant_id
parent_id
name
type              income | expense | transfer | tax | payroll | other
rules_json
is_active
created_at
updated_at
```

## 10.3 `finance.counterparties`

```text
id
tenant_id
type              person | customer | vendor | bank | government | platform | other
name
tax_id_hash       nullable
contact_json
metadata_json
created_at
updated_at
```

Do not store unnecessary raw sensitive identifiers when a hash/token is sufficient.

---

# 11. Transaction Schema

## 11.1 `finance.transactions`

User-facing normalized transaction record.

```text
id
 tenant_id
account_id
counterparty_id nullable
category_id nullable
occurred_at
posted_at nullable
description
amount_minor
currency_code
transaction_type
status
source
external_ref nullable
import_batch_id nullable
idempotency_key nullable
metadata_json
created_at
updated_at
```

Recommended transaction types:

```text
income
expense
transfer
refund
fee
interest
dividend
tax
payroll
adjustment
```

Recommended status:

```text
pending
posted
reversed
voided
```

Indexes:

```text
(tenant_id, occurred_at DESC, id)
(tenant_id, account_id, occurred_at DESC, id)
(tenant_id, category_id, occurred_at DESC, id)
(tenant_id, counterparty_id, occurred_at DESC, id)
UNIQUE(tenant_id, source, external_ref) WHERE external_ref IS NOT NULL
UNIQUE(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
```

Partitioning recommendation for high scale:

```text
RANGE(occurred_at) monthly
```

At extreme scale:

```text
RANGE(month) -> HASH(tenant_id)
```

Do not partition small deployments prematurely.

## 11.2 `finance.transaction_splits`

Supports one transaction split across multiple categories/projects/cost centers.

```text
id
 tenant_id
transaction_id
category_id nullable
project_id nullable
cost_center_id nullable
amount_minor
memo
created_at
```

Constraint:

```text
SUM(split amount) = transaction amount
```

---

# 12. Immutable Ledger Schema

## 12.1 `finance.journal_entries`

```text
id
tenant_id
source_type
source_id
entry_date
occurred_at
status              draft | posted | reversed
reversal_of_id nullable
memo
idempotency_key
created_by_type     user | agent | import | system
created_by_id nullable
posted_at nullable
created_at
```

Critical rules:

```text
posted entries immutable
one source operation -> one idempotent journal entry
reversal references original entry
```

Indexes:

```text
(tenant_id, occurred_at DESC, id)
(tenant_id, source_type, source_id)
UNIQUE(tenant_id, idempotency_key)
```

## 12.2 `finance.journal_lines`

```text
id
tenant_id
journal_entry_id
account_id
direction           debit | credit
amount_minor
currency_code
quantity nullable
asset_code nullable
exchange_rate nullable
base_amount_minor nullable
metadata_json
created_at
```

Indexes:

```text
(tenant_id, account_id, created_at DESC, id)
(tenant_id, journal_entry_id)
```

Validation:

```text
amount_minor > 0
for each journal_entry:
SUM(debit base amount) = SUM(credit base amount)
```

---

# 13. Transfers

## 13.1 `finance.transfers`

```text
id
tenant_id
from_account_id
to_account_id
source_transaction_id
destination_transaction_id
amount_minor
currency_code
fee_minor
occurred_at
status
created_at
```

For FX transfers include:

```text
source_currency
source_amount_minor
destination_currency
destination_amount_minor
exchange_rate
rate_source
```

---

# 14. Recurring Transactions

## 14.1 `finance.recurring_rules`

```text
id
tenant_id
name
rule_type
schedule_spec_json
template_json
next_run_at
last_run_at nullable
status
created_at
updated_at
```

Functions:

```text
finance_create_recurring_rule
finance_list_recurring_rules
finance_pause_recurring_rule
finance_run_due_recurring_rules
```

---

# 15. Personal Finance Functions -> Tables

## 15.1 `finance_add_income`

Reads/writes:

```text
finance.transactions
finance.journal_entries
finance.journal_lines
system.outbox_events
system.audit_log
```

Flow:

```text
Validate tenant/account/category
    -> dedupe idempotency key
    -> insert transaction
    -> post balanced ledger entry
    -> insert outbox event
    -> commit atomically
```

## 15.2 `finance_add_expense`

Same transaction boundary as income.

Additional optional behavior:

```text
budget threshold evaluation
anomaly feature emission
NCA financial stimulus
```

## 15.3 `finance_list_transactions`

Primary source:

```text
PostgreSQL for recent/detail views
ClickHouse for very large scans/aggregations
```

## 15.4 `finance_get_monthly_summary`

Preferred source:

```text
ClickHouse materialized aggregate
```

Fallback:

```text
PostgreSQL for small deployments
```

## 15.5 `finance_get_cashflow`

Data sources:

```text
historical transactions
journal lines
recurring rules
forecast scenarios
```

## 15.6 `finance_get_budget_status`

Reads:

```text
planning.budgets
planning.budget_lines
analytics daily/monthly category spend
```

## 15.7 `finance_get_savings_rate`

Formula inputs:

```text
income
expense
savings/investment transfers
period
```

Store the computed report cache, not the formula result as financial truth.

## 15.8 `finance_get_net_worth`

Reads:

```text
asset account balances
liability account balances
latest valuation prices
```

## 15.9 `finance_detect_unusual_spending`

Preferred processing:

```text
ClickHouse feature query
    -> anomaly worker/model
    -> intelligence.anomalies
    -> Kafka event
    -> NCA stimulus
```

## 15.10 `finance_forecast_cashflow`

Reads:

```text
historical cash flow
recurring rules
known future obligations
planned income
receivables/payables for SME
seasonality features
```

Writes:

```text
planning.forecasts
planning.forecast_points
intelligence.predictions
```

## 15.11 `finance_create_budget`

Writes:

```text
planning.budgets
planning.budget_lines
system.audit_log
system.outbox_events
```

## 15.12 `finance_set_financial_goal`

Writes:

```text
planning.financial_goals
adaptive goal cell stimulus
```

---

# 16. SME Master Data

## 16.1 `sme.customers`

```text
id
tenant_id
customer_code
name
billing_profile_json
payment_terms_days
credit_limit_minor nullable
currency_code
status
created_at
updated_at
```

## 16.2 `sme.vendors`

```text
id
tenant_id
vendor_code
name
payment_terms_days
currency_code
status
created_at
updated_at
```

## 16.3 `sme.products`

```text
id
tenant_id
sku
name
type              product | service
unit
sale_price_minor nullable
cost_price_minor nullable
currency_code
tax_code_id nullable
status
created_at
updated_at
```

## 16.4 `sme.projects`

```text
id
tenant_id
code
name
customer_id nullable
status
start_at nullable
end_at nullable
```

## 16.5 `sme.cost_centers`

```text
id
tenant_id
code
name
parent_id nullable
is_active
```

---

# 17. Invoices and Receivables

## 17.1 `sme.invoices`

```text
id
tenant_id
invoice_number
customer_id
issue_date
due_date
currency_code
subtotal_minor
discount_minor
tax_minor
total_minor
paid_minor
outstanding_minor
status
external_ref nullable
metadata_json
created_at
updated_at
```

Status:

```text
draft
issued
partially_paid
paid
overdue
voided
```

Indexes:

```text
UNIQUE(tenant_id, invoice_number)
(tenant_id, customer_id, issue_date DESC)
(tenant_id, due_date, status)
PARTIAL INDEX for open receivables
```

## 17.2 `sme.invoice_lines`

```text
id
tenant_id
invoice_id
product_id nullable
description
quantity
unit_price_minor
discount_minor
tax_minor
line_total_minor
project_id nullable
cost_center_id nullable
created_at
```

## 17.3 `sme.receivables`

This may be derived from invoices and payment allocations, but a dedicated operational projection is useful for fast aging queries.

```text
id
tenant_id
invoice_id
customer_id
original_minor
outstanding_minor
due_date
aging_bucket
status
version
updated_at
```

Treat as a projection, not independent accounting truth.

---

# 18. Bills and Payables

## 18.1 `sme.bills`

```text
id
tenant_id
bill_number
vendor_id
issue_date
due_date
currency_code
subtotal_minor
tax_minor
total_minor
paid_minor
outstanding_minor
status
created_at
updated_at
```

## 18.2 `sme.bill_lines`

```text
id
tenant_id
bill_id
product_id nullable
description
quantity
unit_cost_minor
tax_minor
line_total_minor
category_id nullable
project_id nullable
cost_center_id nullable
created_at
```

## 18.3 `sme.payables`

Operational projection for fast AP aging.

```text
id
tenant_id
bill_id
vendor_id
original_minor
outstanding_minor
due_date
aging_bucket
status
version
updated_at
```

---

# 19. Payments

## 19.1 `sme.payments`

```text
id
tenant_id
payment_type       incoming | outgoing
account_id
counterparty_type  customer | vendor | other
counterparty_id nullable
amount_minor
currency_code
occurred_at
method
external_ref nullable
status
created_at
```

## 19.2 `sme.payment_allocations`

One payment can settle multiple invoices/bills.

```text
id
tenant_id
payment_id
document_type      invoice | bill
document_id
allocated_minor
created_at
```

Constraint:

```text
SUM(allocations) <= payment amount
```

---

# 20. SME Functions -> Tables

## 20.1 `sme_create_income`

Writes:

```text
finance.transactions
finance.journal_entries
finance.journal_lines
system.outbox_events
```

## 20.2 `sme_create_expense`

Writes same financial core and optional vendor/project/cost-center dimensions.

## 20.3 `sme_create_invoice`

Writes atomically:

```text
sme.invoices
sme.invoice_lines
finance.journal_entries
finance.journal_lines
system.outbox_events
system.audit_log
```

Posting example:

```text
Debit   Accounts Receivable
Credit  Revenue
Credit  Tax Payable when applicable
```

## 20.4 `sme_record_payment`

Writes:

```text
sme.payments
sme.payment_allocations
receivable/payable projection update
finance journal
outbox event
```

Must be idempotent.

## 20.5 `sme_create_bill`

Writes:

```text
sme.bills
sme.bill_lines
finance journal
payables projection
outbox event
```

## 20.6 `sme_get_profit_loss`

Preferred source:

```text
ClickHouse accounting fact tables
pre-aggregated monthly P&L projections
```

Never calculate P&L only from user-facing categories when ledger account types are available.

## 20.7 `sme_get_cashflow`

Uses:

```text
cash/bank ledger movements
receivable/payable schedule
recurring obligations
payroll obligations
forecast scenarios
```

## 20.8 `sme_get_balance_summary`

Reads asset/liability/equity ledger balances.

## 20.9 `sme_get_accounts_receivable`

Reads:

```text
sme.receivables projection
```

For audit/detail:

```text
invoice + payment allocations + ledger
```

## 20.10 `sme_get_accounts_payable`

Same pattern using payables.

## 20.11 `sme_get_customer_profitability`

Preferred source:

```text
ClickHouse facts grouped by tenant/customer/project/product
```

## 20.12 `sme_get_product_profitability`

Requires:

```text
revenue allocation
COGS/cost allocation
refunds
fees
project/customer dimensions
```

## 20.13 `sme_get_cost_breakdown`

Uses:

```text
expense accounts
categories
vendors
projects
cost centers
period
```

## 20.14 `sme_forecast_cashflow`

Uses:

```text
cash position
AR due schedule
AP due schedule
payroll
recurring expenses
seasonality
historical payment-delay behavior
known planned transactions
```

## 20.15 `sme_detect_cash_shortage`

Writes:

```text
intelligence.risk_signals
intelligence.anomalies
adaptive/NCA stimulus
planner alert when threshold crossed
```

## 20.16 `sme_detect_late_payment`

Primary keys:

```text
tenant_id
invoice_id
customer_id
due_date
status
```

## 20.17 `sme_detect_expense_anomaly`

Preferred execution:

```text
ClickHouse feature extraction
    -> anomaly scoring
    -> persistent signal
    -> Evidence Bus
    -> NCA
    -> attention/workflow
```

---

# 21. Budget Schema

## 21.1 `planning.budgets`

```text
id
tenant_id
name
scope_type        personal | household | sme | project | cost_center
scope_id nullable
period_type       monthly | quarterly | yearly | custom
start_date
end_date
currency_code
status
created_at
updated_at
```

## 21.2 `planning.budget_lines`

```text
id
tenant_id
budget_id
category_id nullable
account_id nullable
project_id nullable
cost_center_id nullable
limit_minor
warning_percent
created_at
```

---

# 22. Financial Goals

## 22.1 `planning.financial_goals`

```text
id
tenant_id
goal_type
name
target_minor nullable
target_currency nullable
target_date nullable
current_minor nullable
priority
status
metadata_json
created_at
updated_at
```

Examples:

```text
emergency fund
pay off debt
save 1 million THB
maintain 6 months runway
reduce customer concentration
keep daily loss below threshold
```

---

# 23. Forecast Schema

## 23.1 `planning.forecasts`

```text
id
tenant_id
forecast_type
model_name
model_version
scenario           best | base | worst | custom
horizon_start
horizon_end
currency_code
confidence
assumptions_json
created_at
```

## 23.2 `planning.forecast_points`

```text
id
tenant_id
forecast_id
point_at
inflow_minor
outflow_minor
net_minor
balance_minor
confidence
```

Large forecast history should be replicated into ClickHouse.

---

# 24. Financial Intelligence Schema

## 24.1 `intelligence.anomalies`

```text
id
tenant_id
domain
entity_type
entity_id
anomaly_type
score
severity
claim
evidence_ids
model_name
model_version
status
created_at
resolved_at nullable
```

## 24.2 `intelligence.risk_signals`

```text
id
tenant_id
risk_type
scope_type
scope_id nullable
score
severity
explanation
inputs_json
evidence_ids
created_at
expires_at nullable
```

Risk types:

```text
liquidity
overspending
debt
cash-shortage
late-payment
customer-concentration
vendor-concentration
fraud
reconciliation-gap
forecast-uncertainty
execution-risk
```

## 24.3 `intelligence.predictions`

```text
id
tenant_id
prediction_type
scope_type
scope_id nullable
model_name
model_version
prediction_json
confidence
assumptions_json
required_verification_json
created_at
```

---

# 25. Import and Ingestion

## 25.1 `system.ingestion_batches`

```text
id
tenant_id
source_type
source_name
object_ref
status
row_count
success_count
error_count
started_at
completed_at nullable
created_at
```

Sources:

```text
bank_csv
bank_api
credit_card_csv
invoice_pdf
receipt_image
accounting_export
manual_upload
email_attachment
webhook
```

## 25.2 `system.ingestion_rows`

```text
id
tenant_id
batch_id
row_number
raw_json
normalized_json nullable
status
error_code nullable
error_message nullable
created_at
```

At very large scale, keep raw rows in object storage and only persist errors/metadata in PostgreSQL.

---

# 26. Document/Object Storage

## 26.1 `system.object_refs`

```text
id
tenant_id
bucket
object_key
content_type
size_bytes
sha256
version_id nullable
retention_class
created_at
```

Recommended object layout:

```text
tenant/{tenant_id}/statements/YYYY/MM/...
tenant/{tenant_id}/receipts/YYYY/MM/...
tenant/{tenant_id}/invoices/YYYY/MM/...
tenant/{tenant_id}/exports/...
tenant/{tenant_id}/ml-features/...
```

Store binaries in MinIO/S3, not PostgreSQL rows.

---

# 27. Idempotency

## 27.1 `system.idempotency_keys`

```text
id
tenant_id
key
operation
request_hash
status
response_ref nullable
expires_at
created_at
```

Unique:

```text
UNIQUE(tenant_id, key)
```

Required for:

```text
bank imports
webhooks
payment recording
invoice posting
ledger posting
agent retries
external API retries
```

---

# 28. Transactional Outbox

## 28.1 `system.outbox_events`

```text
id
tenant_id
aggregate_type
aggregate_id
event_type
payload_json
schema_version
occurred_at
published_at nullable
retry_count
last_error nullable
```

Critical pattern:

```text
BEGIN
  write financial rows
  write journal
  write outbox event
COMMIT

Async publisher:
  read unpublished outbox
  publish to Kafka
  mark published
```

This avoids an unsafe dual write where PostgreSQL succeeds but Kafka fails, or vice versa.

Recommended partitioning:

```text
RANGE(occurred_at) monthly
```

---

# 29. Audit Log

## 29.1 `system.audit_log`

Append-only.

```text
id
tenant_id
actor_type          user | agent | system | import
actor_id nullable
action
entity_type
entity_id nullable
request_id
session_id nullable
before_hash nullable
after_hash nullable
evidence_ids
metadata_json
occurred_at
```

Never store secrets/tokens in audit payloads.

Partition by time at high scale.

---

# 30. ClickHouse Analytical Model

Do not copy the normalized PostgreSQL schema 1:1.

Use denormalized facts optimized for analytical access.

Recommended tables:

```text
fact_financial_events
fact_transactions
fact_ledger_lines
fact_invoices
fact_payments
fact_cashflow_daily
fact_account_balances_daily
fact_category_spend_daily
fact_customer_profitability_daily
fact_product_profitability_daily
fact_risk_signals
fact_anomalies
fact_agent_evidence
fact_nca_state_snapshots
```

## 30.1 Example `fact_transactions`

```text
tenant_id
transaction_id
event_time
event_date
account_id
account_type
category_id
counterparty_id
project_id
cost_center_id
transaction_type
amount_minor
currency_code
base_amount_minor
base_currency
source
status
version
```

Recommended engine concept:

```text
MergeTree / ReplacingMergeTree as appropriate
```

Recommended ordering:

```text
ORDER BY (tenant_id, event_date, account_id, transaction_id)
```

Recommended partitioning:

```text
PARTITION BY toYYYYMM(event_time)
```

Do not create one ClickHouse partition per tenant.

## 30.2 Materialized Aggregates

Recommended:

```text
monthly income/expense
monthly P&L
cash flow by day
spend by category
revenue by customer
revenue by product
aging summaries
risk signal counts
anomaly frequency
agent action metrics
```

---

# 31. Redis Key Design

Redis is not financial truth.

Recommended key patterns:

```text
finance:summary:{tenant_id}:{period}
finance:balance:{tenant_id}:{account_id}
finance:budget:{tenant_id}:{budget_id}
finance:dashboard:{tenant_id}
finance:idempotency:{tenant_id}:{key}
finance:lock:{tenant_id}:{resource}:{id}
finance:rate:{tenant_id}:{operation}
finance:attention:{tenant_id}
nca:hot:{tenant_id}:{cell_id}
agent:run:{run_id}:hot
```

Use TTLs for cache/hot state.

Never use Redis balance as canonical account balance.

---

# 32. Kafka Event Design

Recommended topics:

```text
finance.transaction.created.v1
finance.transaction.posted.v1
finance.journal.posted.v1
finance.invoice.created.v1
finance.invoice.overdue.v1
finance.payment.recorded.v1
finance.budget.threshold.v1
finance.cashflow.risk.v1
finance.anomaly.detected.v1
finance.forecast.created.v1
finance.document.ingested.v1
finance.reconciliation.failed.v1
agent.evidence.published.v1
nca.stimulus.finance.v1
audit.event.v1
```

Recommended Kafka message key:

```text
tenant_id
```

This preserves tenant-local event ordering within a partition.

Event envelope:

```json
{
  "eventId": "uuid",
  "eventType": "finance.transaction.posted.v1",
  "tenantId": "uuid",
  "aggregateType": "transaction",
  "aggregateId": "uuid",
  "schemaVersion": 1,
  "occurredAt": "2026-07-11T00:00:00Z",
  "traceId": "uuid",
  "causationId": "uuid|null",
  "correlationId": "uuid|null",
  "payload": {}
}
```

---

# 33. NCA Finance Integration

NCA must not mutate ledger truth directly.

Recommended adaptive cell categories:

```text
finance:cash
finance:income
finance:expense
finance:debt
finance:savings
finance:budget
finance:receivable
finance:payable
finance:liquidity-risk
finance:overspending-risk
finance:customer-concentration
finance:forecast-uncertainty
finance:anomaly
finance:goal
```

## 33.1 NCA Storage Split

```text
Current canonical adaptive cell state   -> PostgreSQL
Hot active cell state                   -> Redis
Historical cell snapshots               -> ClickHouse
Raw evidence/documents                  -> PostgreSQL + MinIO
Stimulus stream                         -> Kafka
```

## 33.2 Example

```text
Major customer payment becomes overdue
    -> invoice.overdue event
    -> receivable risk cell rises
    -> cash-flow pressure rises
    -> payroll risk rises
    -> attention score crosses threshold
    -> Global Workspace broadcast
    -> Orchestrator wakes SME Finance Agent
    -> forecast + alert + action plan
```

---

# 34. Agentic AI Integration

Finance tools should map to domain services rather than direct arbitrary SQL.

Recommended tools:

```text
finance_add_income
finance_add_expense
finance_list_transactions
finance_get_monthly_summary
finance_get_cashflow
finance_get_budget_status
finance_get_savings_rate
finance_get_net_worth
finance_detect_unusual_spending
finance_forecast_cashflow
finance_create_budget
finance_set_financial_goal

sme_create_income
sme_create_expense
sme_create_invoice
sme_record_payment
sme_create_bill
sme_get_profit_loss
sme_get_cashflow
sme_get_balance_summary
sme_get_accounts_receivable
sme_get_accounts_payable
sme_get_customer_profitability
sme_get_product_profitability
sme_get_cost_breakdown
sme_forecast_cashflow
sme_detect_cash_shortage
sme_detect_late_payment
sme_detect_expense_anomaly
```

The generic `db_*` tools remain useful for diagnostics and controlled administration, but normal financial actions should use finance-domain tools with business invariants.

---

# 35. Domain Service Boundary

Recommended source tree:

```text
src/finance/
  core/
    Money.ts
    Currency.ts
    Account.ts
    Transaction.ts
    JournalEntry.ts
    LedgerPolicy.ts

  personal/
    PersonalFinanceService.ts
    BudgetService.ts
    GoalService.ts
    NetWorthService.ts

  sme/
    SmeFinanceService.ts
    InvoiceService.ts
    BillService.ts
    PaymentService.ts
    ReceivableService.ts
    PayableService.ts
    ProfitabilityService.ts

  forecast/
    CashflowForecastService.ts
    ScenarioEngine.ts

  intelligence/
    ExpenseAnomalyDetector.ts
    LiquidityRiskEngine.ts
    LatePaymentDetector.ts
    ConcentrationRiskEngine.ts

  persistence/
    FinanceRepository.ts
    LedgerRepository.ts
    InvoiceRepository.ts
    PaymentRepository.ts
    BudgetRepository.ts
    ForecastRepository.ts

  events/
    FinanceEventPublisher.ts
    OutboxPublisher.ts

  analytics/
    FinanceAnalyticsClient.ts
    ClickHouseFinanceAnalytics.ts
```

---

# 36. Function Signatures

## 36.1 Personal Finance

```ts
addIncome(input: AddIncomeInput): Promise<PostedTransaction>;
addExpense(input: AddExpenseInput): Promise<PostedTransaction>;
listTransactions(input: TransactionQuery): Promise<TransactionPage>;
getMonthlySummary(input: MonthlySummaryQuery): Promise<MonthlySummary>;
getCashflow(input: CashflowQuery): Promise<CashflowReport>;
getBudgetStatus(input: BudgetStatusQuery): Promise<BudgetStatus[]>;
getSavingsRate(input: SavingsRateQuery): Promise<SavingsRateReport>;
getNetWorth(input: NetWorthQuery): Promise<NetWorthReport>;
detectUnusualSpending(input: AnomalyQuery): Promise<ExpenseAnomaly[]>;
forecastCashflow(input: CashflowForecastInput): Promise<CashflowForecast>;
createBudget(input: CreateBudgetInput): Promise<Budget>;
setFinancialGoal(input: CreateFinancialGoalInput): Promise<FinancialGoal>;
```

## 36.2 SME Finance

```ts
createIncome(input: SmeIncomeInput): Promise<PostedTransaction>;
createExpense(input: SmeExpenseInput): Promise<PostedTransaction>;
createInvoice(input: CreateInvoiceInput): Promise<Invoice>;
recordPayment(input: RecordPaymentInput): Promise<PaymentResult>;
createBill(input: CreateBillInput): Promise<Bill>;
getProfitLoss(input: ProfitLossQuery): Promise<ProfitLossReport>;
getCashflow(input: SmeCashflowQuery): Promise<CashflowReport>;
getBalanceSummary(input: BalanceSummaryQuery): Promise<BalanceSummary>;
getAccountsReceivable(input: ReceivableQuery): Promise<ReceivableReport>;
getAccountsPayable(input: PayableQuery): Promise<PayableReport>;
getCustomerProfitability(input: ProfitabilityQuery): Promise<CustomerProfitability[]>;
getProductProfitability(input: ProfitabilityQuery): Promise<ProductProfitability[]>;
getCostBreakdown(input: CostBreakdownQuery): Promise<CostBreakdown>;
forecastCashflow(input: SmeForecastInput): Promise<CashflowForecast>;
detectCashShortage(input: RiskQuery): Promise<LiquidityRisk[]>;
detectLatePayment(input: LatePaymentQuery): Promise<LatePaymentSignal[]>;
detectExpenseAnomaly(input: AnomalyQuery): Promise<ExpenseAnomaly[]>;
```

---

# 37. Write Path

Every financial write should follow:

```text
1. Authenticate user/agent
2. Resolve tenant
3. Authorize operation
4. Validate input
5. Check idempotency
6. BEGIN PostgreSQL transaction
7. Lock only required resources
8. Write domain entity
9. Write balanced journal entry
10. Write projection changes when required
11. Write audit row
12. Write outbox event
13. COMMIT
14. Async publish to Kafka
15. Update Redis cache asynchronously
16. Ingest analytics into ClickHouse
17. Publish Evidence Bus / NCA stimulus when relevant
```

Never make Redis, ClickHouse, or Kafka success a prerequisite for committing accounting truth.

---

# 38. Read Path

## 38.1 Detail Query

Use PostgreSQL:

```text
single transaction
single invoice
single payment
account detail
recent history
```

## 38.2 Dashboard Query

Use:

```text
Redis cache
    -> ClickHouse aggregate
    -> PostgreSQL fallback
```

## 38.3 Large Historical Query

Use ClickHouse.

Do not scan billions of PostgreSQL ledger rows for every dashboard request.

---

# 39. Partitioning Strategy

Partition only high-volume append-heavy tables.

Recommended PostgreSQL partition candidates:

```text
finance.transactions
finance.journal_entries
system.outbox_events
system.audit_log
system.ingestion_rows
agent evidence history at very high volume
```

Recommended partition key:

```text
monthly time range
```

Optional second level at extreme volume:

```text
hash(tenant_id)
```

Do not partition small dimension tables:

```text
tenants
users
accounts
categories
customers
vendors
products
```

---

# 40. Indexing Strategy

Rule:

> Index actual access paths, not every column.

Critical composite pattern:

```text
(tenant_id, time DESC, id)
```

Examples:

```text
transactions: (tenant_id, occurred_at DESC, id)
invoices: (tenant_id, customer_id, issue_date DESC)
open AR: (tenant_id, due_date, customer_id) WHERE status is open
audit: (tenant_id, occurred_at DESC, id)
outbox: (published_at, occurred_at) WHERE published_at IS NULL
```

Avoid excessive indexes on write-heavy tables.

---

# 41. Sharding Strategy

Do not shard on day one without need.

Recommended evolution:

```text
Stage 1: One PostgreSQL cluster
Stage 2: Read replicas + partitions
Stage 3: Tenant directory + multiple shards
Stage 4: Dedicated shard for very large tenant
```

## 41.1 Tenant Directory

```text
tenant_id -> shard_id -> connection pool
```

Keep tenant financial operations on one shard.

Global analytics should query ClickHouse instead of broadcasting requests to every PostgreSQL shard.

---

# 42. Consistency Model

Strong consistency required for:

```text
ledger posting
payment allocation
invoice totals
bank reconciliation
idempotency
balance-affecting operations
```

Eventual consistency acceptable for:

```text
dashboards
analytics
anomaly models
NCA state propagation
search indexes
notification delivery
cache
```

---

# 43. Reconciliation

## 43.1 `finance.reconciliation_runs`

```text
id
tenant_id
account_id
period_start
period_end
statement_opening_minor
statement_closing_minor
ledger_opening_minor
ledger_closing_minor
difference_minor
status
created_at
completed_at nullable
```

## 43.2 `finance.reconciliation_items`

```text
id
tenant_id
run_id
transaction_id nullable
statement_line_ref nullable
match_score
status
reason nullable
```

Reconciliation gaps should become:

```text
risk signal
Evidence Bus record
NCA anomaly stimulus
```

---

# 44. Bank/External Connector Model

## 44.1 `finance.external_connections`

```text
id
tenant_id
provider
connection_type
status
secret_ref
last_sync_at nullable
sync_cursor nullable
created_at
updated_at
```

Do not store raw access tokens directly in normal application rows.

Use a secret manager/KMS reference.

## 44.2 `finance.external_accounts`

```text
id
tenant_id
connection_id
provider_account_ref
local_account_id
currency_code
status
last_synced_at nullable
```

---

# 45. Security and Privacy

Minimum requirements:

- encrypt network traffic,
- encryption at rest,
- strict tenant authorization,
- secret manager for credentials,
- redact tokens from logs,
- audit consequential actions,
- minimize sensitive data retention,
- define document retention policies,
- protect exports,
- support account deletion/anonymization workflows where legally required,
- separate agent permissions from human permissions.

Financial agents must not bypass Approval Gate for consequential external actions.

---

# 46. Backup and Disaster Recovery

PostgreSQL:

```text
continuous WAL archiving/PITR
scheduled full backups
restore drills
replicas do not replace backups
```

ClickHouse:

```text
replication for availability
backup critical analytical metadata and long-lived facts
rebuildable facts may be rehydrated from Kafka/object storage when designed that way
```

MinIO/S3:

```text
versioning
replication when required
retention/object-lock for selected audit evidence
```

Redis:

```text
treat cache as rebuildable
persist only when a chosen Redis workload requires it
```

---

# 47. Retention Strategy

Example classes:

```text
financial ledger          long-term / legal policy
invoices and bills        long-term / legal policy
audit evidence            policy-defined
raw import staging        short-term after verified ingestion
Redis cache               minutes/hours
hot NCA state             short-lived + persisted snapshot
ClickHouse raw events     tiered retention
aggregates                longer retention
```

Retention must be configurable per jurisdiction and customer policy.

---

# 48. Observability

Metrics:

```text
PostgreSQL write latency
ledger post latency
transactions/sec
outbox backlog
Kafka consumer lag
ClickHouse insert latency
ClickHouse query latency
Redis hit rate
invoice posting failures
payment allocation failures
reconciliation gaps
anomaly model latency
forecast latency
NCA tick latency
agent action error rate
idempotency duplicate rate
```

SLO examples should be benchmark-driven, not guessed.

---

# 49. Failure Modes

## 49.1 PostgreSQL succeeds, Kafka unavailable

Correct behavior:

```text
financial transaction remains committed
outbox remains unpublished
publisher retries later
```

## 49.2 ClickHouse unavailable

Correct behavior:

```text
financial writes continue
analytics becomes stale
backlog replays later
```

## 49.3 Redis unavailable

Correct behavior:

```text
fall back to PostgreSQL/ClickHouse where feasible
reduced performance
no financial truth loss
```

## 49.4 Duplicate webhook/payment retry

Correct behavior:

```text
idempotency key blocks duplicate financial posting
```

## 49.5 Agent repeats tool call

Correct behavior:

```text
same idempotency key -> same result/no duplicate posting
```

## 49.6 Ledger imbalance

Correct behavior:

```text
reject transaction
rollback PostgreSQL transaction
emit error evidence
never partially post
```

---

# 50. Recommended API Surface

## Personal

```text
POST /finance/income
POST /finance/expense
GET  /finance/transactions
GET  /finance/summary/monthly
GET  /finance/cashflow
GET  /finance/net-worth
GET  /finance/budgets
POST /finance/budgets
GET  /finance/goals
POST /finance/goals
GET  /finance/anomalies
POST /finance/forecast
```

## SME

```text
POST /sme/invoices
GET  /sme/invoices
POST /sme/bills
GET  /sme/bills
POST /sme/payments
GET  /sme/ar
GET  /sme/ap
GET  /sme/reports/profit-loss
GET  /sme/reports/cashflow
GET  /sme/reports/balance-summary
GET  /sme/analytics/customer-profitability
GET  /sme/analytics/product-profitability
GET  /sme/risks/liquidity
GET  /sme/risks/late-payments
POST /sme/forecast/cashflow
```

---

# 51. Recommended Agent Tool Risk Levels

```text
safe
  finance_list_transactions
  finance_get_monthly_summary
  finance_get_cashflow
  finance_get_budget_status
  finance_get_savings_rate
  finance_get_net_worth
  finance_detect_unusual_spending
  finance_forecast_cashflow
  sme_get_profit_loss
  sme_get_cashflow
  sme_get_balance_summary
  sme_get_accounts_receivable
  sme_get_accounts_payable
  sme_get_customer_profitability
  sme_get_product_profitability
  sme_get_cost_breakdown
  sme_detect_cash_shortage
  sme_detect_late_payment
  sme_detect_expense_anomaly

write
  finance_create_budget
  finance_set_financial_goal
  local draft invoice

external
  add/post financial record
  issue invoice externally
  send invoice
  record externally sourced payment after validation

dangerous
  destructive reconciliation override
  mass reversal
  bulk delete attempt
  high-impact accounting mutation
```

Posted ledger deletion should not exist as a normal tool.

---

# 52. Recommended Query Routing

```text
Recent detail < moderate rows
    -> PostgreSQL

Dashboard / aggregate / many months
    -> ClickHouse

Hot repeated summary
    -> Redis

Documents/raw imports
    -> MinIO/S3

Durable async propagation
    -> Kafka
```

The application decides routing; the LLM should not choose a database blindly for every request.

---

# 53. Implementation Roadmap

## Phase 1 — Correct Financial Core

Implement:

```text
tenants
accounts
categories
counterparties
transactions
journal_entries
journal_lines
idempotency
outbox
audit
personal finance tools
```

Definition of done:

```text
balanced ledger enforced
posted entries immutable
idempotency tested
reversal tested
tenant isolation tested
CI passes
```

## Phase 2 — SME Core

Implement:

```text
customers
vendors
products
invoices
invoice lines
bills
bill lines
payments
allocations
AR/AP projections
SME reports
```

## Phase 3 — Scale Infrastructure

Implement:

```text
Kafka outbox publisher
ClickHouse facts
Redis cache
MinIO documents
materialized aggregates
```

## Phase 4 — Intelligence

Implement:

```text
anomalies
cash shortage risk
late payment risk
customer concentration
cash-flow forecast
Evidence Bus integration
```

## Phase 5 — NCA/Cognition

Implement:

```text
finance cell stimuli
liquidity cells
budget pressure cells
receivable/payable cells
risk diffusion
attention wake conditions
Global Workspace integration
```

## Phase 6 — Multi-Shard

Only after evidence shows a single PostgreSQL cluster is insufficient.

Implement:

```text
tenant directory
shard routing
tenant migration
rebalancing
large-tenant dedicated shards
global analytics through ClickHouse
```

---

# 54. Definition of Done

The finance data layer is not production-ready until:

- all financial writes are idempotent,
- every posted entry balances,
- posted ledger entries cannot be silently edited,
- reversals are supported,
- tenant isolation is tested,
- critical operations are audited,
- dashboards do not overload OLTP,
- imports are replayable,
- Kafka/analytics outages do not lose financial truth,
- backup restoration is tested,
- sensitive data is not leaked to logs,
- AI agents cannot bypass business invariants,
- NCA state cannot mutate accounting truth,
- large-volume benchmarks pass defined SLOs,
- failure recovery is documented and tested.

---

# 55. Final Recommended Architecture

```text
                         CherryAgent Finance
                                  |
                 +----------------+----------------+
                 |                                 |
                 v                                 v
       Personal Finance Agent              SME Finance Agent
                 |                                 |
                 +----------------+----------------+
                                  |
                                  v
                        Finance Domain Services
                                  |
                       Strong business invariants
                                  |
                                  v
                           PostgreSQL OLTP
                    Source of Truth + Ledger + Outbox
                                  |
             +--------------------+--------------------+
             |                    |                    |
             v                    v                    v
          Kafka                 Redis               MinIO/S3
       Event Backbone         Hot State          Docs/Data Lake
             |                                         |
             +--------------------+--------------------+
                                  |
                                  v
                            ClickHouse OLAP
                    BigData / Analytics / Features
                                  |
                    +-------------+-------------+
                    |                           |
                    v                           v
            Financial Intelligence          NCA Adaptive State
                    |                           |
                    +-------------+-------------+
                                  v
                        Consciousness-Inspired
                         Cognitive Coordination
                                  |
                                  v
                         Cherry Orchestrator
                                  |
                                  v
                     Critic -> Verifier -> Action
```

The most important boundary is:

> **PostgreSQL ledger determines financial truth. ClickHouse accelerates analysis. Redis accelerates hot state. Kafka distributes events. MinIO stores large immutable objects. NCA and AI observe, predict, prioritize, and recommend—but they do not bypass ledger invariants.**
