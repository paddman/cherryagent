# CherryAgent authentication

CherryAgent's HTTP API uses local-first session authentication by default. Users and sessions are stored in:

```env
CHERRY_AUTH_FILE=.cherry/auth.json
```

Passwords are hashed with `scrypt`. Session tokens are opaque bearer tokens; only their SHA-256 hashes are stored on disk. The auth state file is written with restrictive permissions and the `.cherry/` directory is ignored by git.

## First run

Set an administrator account before starting the server:

```env
CHERRY_AUTH_ENABLED=true
CHERRY_AUTH_ADMIN_EMAIL=padd@cherrydeskx.com
CHERRY_AUTH_ADMIN_NAME=Cherry Admin
CHERRY_AUTH_ADMIN_PASSWORD=replace-with-a-unique-password-at-least-12-characters
CHERRY_AUTH_SESSION_TTL_MINUTES=480
```

On the first boot, CherryAgent creates the admin user in `CHERRY_AUTH_FILE`. The bootstrap password is only read when the auth file has no enabled users. Changing the environment variable later does not silently overwrite an existing account.

For an intentionally isolated local development process, authentication can be disabled:

```env
CHERRY_AUTH_ENABLED=false
```

Do not use that setting when the API is reachable by another machine.

## API usage

Login returns an opaque session token. Send it on protected API calls:

```bash
TOKEN=$(curl -sS http://localhost:8787/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"padd@cherrydeskx.com","password":"replace-with-a-unique-password-at-least-12-characters"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))')

curl http://localhost:8787/auth/me -H "Authorization: Bearer $TOKEN"
curl http://localhost:8787/planner/dashboard -H "Authorization: Bearer $TOKEN"
```

Available auth endpoints:

- `POST /auth/login` — authenticate an email and password.
- `GET /auth/me` — inspect the current session and user.
- `POST /auth/logout` — revoke the current session.
- `GET /workspace/context` — return the authenticated organization/tenant context.
- `GET /organizations` — list organizations (admin only).
- `POST /organizations` and `POST /organizations/:id/members` — provision pilot tenants and members (admin only).

`GET /health` remains public for monitoring. Channel webhooks remain public at the HTTP layer because the channel adapter performs its own signature verification. The application API, chat, planner, Engineer Loop, tools, and approvals require authentication.

## Roles

- `admin` — full access within the control plane and can manage approvals in the current tenant.
- `user` — authenticated workspace access and can manage approvals created by that user.
- `viewer` — read-only access.

The first account is an `admin`. Users, planner state, Office Inbox, Engineer loops, Agentic runs, memory, usage credits, and approvals are scoped by `tenantId` in the current single-node pilot. PostgreSQL/RLS and Redis-backed coordination are still required before multi-node production; see [`ENTERPRISE_WORKFORCE.md`](ENTERPRISE_WORKFORCE.md).
