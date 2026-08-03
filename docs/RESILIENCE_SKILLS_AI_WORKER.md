# Resilient Runtime, Procedural Skills, and Python AI Worker

This document describes the CherryAgent runtime upgrades added for production reliability and reusable learning.

## 1. LLM profile and model failover

The runtime now uses `ResilientLlmProvider` everywhere the old single OpenAI-compatible provider was used:

- Cherry agent loop
- Correctness verifier
- Multi-agent orchestrator
- Cognitive engine
- Report Studio narrative generation

A fallback applies only to the current completion request. The configured profile order remains unchanged for the next request.

### Single-profile compatibility

Existing settings continue to work and become the `primary` profile:

```env
CHERRY_LLM_BASE_URL=http://127.0.0.1:8000/v1
CHERRY_LLM_API_KEY=local
CHERRY_LLM_MODEL=qwen3.6-27b
CHERRY_LLM_TIMEOUT_MS=60000
```

### Multiple profiles

Set one JSON array on a single line:

```env
CHERRY_LLM_PROFILES_JSON=[{"id":"local-qwen","baseUrl":"http://127.0.0.1:8000/v1","apiKey":"local","model":"qwen3.6-27b","timeoutMs":60000},{"id":"backup-qwen","baseUrl":"http://ai02:8000/v1","apiKey":"local","model":"qwen3.5-35b-a3b","timeoutMs":60000}]
```

Profiles are attempted in order. Failover is allowed for:

- authentication and billing failures
- rate limits and provider overload
- transport/network failure
- timeout
- HTTP 5xx server failure

Invalid requests such as a bad tool schema or malformed payload are surfaced immediately. Retrying those against five models would merely fail five times with greater confidence.

Transient cooldowns are bounded:

1. first failure: 30 seconds
2. second failure: 60 seconds
3. later failures: 5 minutes

Authentication failures disable a profile for 5 minutes. Billing failures disable it for 30 minutes. External abort signals never rotate profiles.

Run `system_doctor` to inspect profile availability and the latest failover evidence.

## 2. Procedural skills

Skills are tenant-scoped `SKILL.md` files under:

```env
CHERRY_SKILLS_ROOT=.cherry/skills
```

Default layout:

```text
.cherry/skills/
└── org-default/
    └── operations/
        └── recover-stale-lock-service/
            └── SKILL.md
```

Tools:

- `skill_list`
- `skill_search`
- `skill_read`
- `skill_create`
- `skill_update`
- `skill_promote_runbook`

### Trusted learning path

The preferred path is:

```text
Engineer Loop
  → verified success evidence
  → generated runbook
  → skill_promote_runbook
  → verified SKILL.md with provenance
```

A free-form skill created from explicit user instructions is marked `verified: false`. A promoted runbook is marked `verified: true` and records both the Engineer Loop and Runbook IDs.

### Write safety

- names and categories are lowercase-hyphenated
- paths cannot escape the configured skill root
- writes through symlink parents are refused
- files use atomic replacement
- updates require the exact revision returned by `skill_read`
- update cannot forge source, verification status, or runbook provenance
- no autonomous delete tool is exposed
- inline shell expansion inside `SKILL.md` is intentionally unsupported

## 3. External channel pairing

External channel messages now pass through a persistent ingress policy before they reach the model.

```env
CHERRY_CHANNEL_ACCESS_FILE=.cherry/channel-access.json
CHERRY_CHANNEL_DEFAULT_POLICY=pairing
CHERRY_CHANNEL_ALLOW_FROM=
CHERRY_CHANNEL_PAIRING_TTL_MINUTES=10
```

Policies:

| Policy | Behavior |
|---|---|
| `pairing` | Known senders are allowed; unknown senders receive a temporary pairing code |
| `allowlist` | Only configured senders are accepted; no pairing code is issued |
| `open` | Every sender is accepted; use only on a trusted private surface |
| `disabled` | All inbound messages are blocked |

Seed trusted sender IDs with a comma-separated list:

```env
CHERRY_CHANNEL_ALLOW_FROM=U1234567890,U0987654321
```

Administration tools:

- `channel_access_status`
- `channel_access_approve`
- `channel_access_revoke`
- `channel_access_set_policy`

Approval, revocation, and policy changes are `dangerous` tools and therefore enter the Approval Inbox under the recommended `CHERRY_AUTO_APPROVE=safe,write` policy.

## 4. System doctor

`system_doctor` is read-only and checks:

- network exposure and API authentication
- unsafe automatic approval of `external` or `dangerous` tools
- external channel pairing/open policy
- LLM profile cooldown and availability
- workspace and skill storage access
- POSIX permissions on `.env` and authentication state
- optional Python AI worker health

A report contains `pass`, `warn`, and `fail` checks with evidence and remediation.

## 5. Python AI worker

The Python worker is stateless. TypeScript remains the owner of authentication, tenants, approvals, audit, planning, and final completion decisions.

Start locally:

```bash
cd services/cherry-ai-worker
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -e ".[dev]"
uvicorn app.main:app --host 127.0.0.1 --port 8790
```

Or build the container:

```bash
docker build -t cherry-ai-worker services/cherry-ai-worker
docker run --rm -p 127.0.0.1:8790:8790 cherry-ai-worker
```

Enable the TypeScript connector:

```env
CHERRY_AI_WORKER_ENABLED=true
CHERRY_AI_WORKER_BASE_URL=http://127.0.0.1:8790
CHERRY_AI_WORKER_TIMEOUT_MS=60000
```

Capabilities:

- `GET /health`
- `POST /v1/chunk`
- `POST /v1/rerank`
- `POST /v1/embeddings`

The initial reranker is deterministic token and character n-gram scoring. It works without a GPU and provides a stable fallback. A learned cross-encoder can replace it behind the same API later.

Embedding requests proxy to an OpenAI-compatible embedding endpoint configured inside the worker:

```env
CHERRY_AI_EMBEDDING_BASE_URL=http://127.0.0.1:8001/v1
CHERRY_AI_EMBEDDING_API_KEY=local
CHERRY_AI_EMBEDDING_MODEL=qwen3-embedding-8b
CHERRY_AI_EMBEDDING_TIMEOUT_SECONDS=60
```

Text-bearing AI worker tools are marked `external` because the worker URL may point outside the local machine. This keeps sensitive documents behind explicit approval unless deployment policy deliberately changes.

## 6. Verification

TypeScript:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Python:

```bash
cd services/cherry-ai-worker
python -m pip install -e ".[dev]"
python -m pytest
```

Run operational diagnostics after deployment:

```text
Ask Cherry: Run system_doctor and report every warning with remediation.
```
