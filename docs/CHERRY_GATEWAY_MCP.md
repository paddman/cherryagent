# Cherry Gateway, Nodes, Sessions, and MCP

CherryAgent now has an OpenClaw-style execution foundation. The Gateway owns Chat ID sessions, approvals, audit records, paired-node identity, task dispatch, and MCP clients. A Cherry Node is a small outbound-polling daemon on the target machine. It executes only the capabilities it advertises and runs with the operating-system permissions of its daemon user.

```text
Chat ID
  -> persistent conversation + node binding
  -> CherryAgent tool call
  -> ApprovalGate + audit + Execution Trail
       -> node_* -> Gateway task queue -> paired Cherry Node -> result
       -> mcp_*  -> MCP client -> registered MCP server -> result
```

This is the first production-shaped MVP, not complete OpenClaw parity. The current node transport uses authenticated polling rather than WebSocket streaming. Shell execution is bounded but intentionally powerful and remains `dangerous`; the operator must approve it.

## Pair a machine

Create a one-time pairing code as an authenticated admin:

```bash
curl -sS -X POST "$CHERRY_GATEWAY_URL/nodes/pairing-codes" \
  -H "Authorization: Bearer $CHERRY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"production-01","ttlMinutes":10}'
```

On the target machine, check out CherryAgent and start the node once with the returned code:

```bash
CHERRY_GATEWAY_URL=https://cherry.example.com \
CHERRY_NODE_PAIRING_CODE='cherry-...' \
CHERRY_NODE_NAME='production-01' \
CHERRY_NODE_WORKSPACE=/srv/apps \
npm run node:agent
```

The node saves its token to `~/.cherry-node/profile.json` with mode `0600`; the Gateway saves only a SHA-256 token hash. Subsequent starts do not need the pairing code. Run the process under a dedicated, least-privileged OS account. Set `CHERRY_NODE_ALLOW_SYSTEM_PATHS=true` only when remote file tools must access paths outside the configured workspace.

List nodes and bind a chat explicitly when more than one node exists:

```bash
curl -sS "$CHERRY_GATEWAY_URL/nodes" -H "Authorization: Bearer $CHERRY_AUTH_TOKEN"

curl -sS -X POST "$CHERRY_GATEWAY_URL/nodes/bind" \
  -H "Authorization: Bearer $CHERRY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chatId":"f438e66b-38db-41c4-b1cb-137ec299f263","nodeId":"..."}'
```

If a tenant has exactly one paired node, the first `node_*` action auto-binds that Chat ID.

## Node capabilities

- `node_system_info`: remote identity and OS evidence (`safe`)
- `node_process_list`: process snapshot (`safe`)
- `node_read_file`: workspace-restricted UTF-8 read (`safe`)
- `node_write_file`: workspace-restricted write (`dangerous`)
- `node_exec`: shell command as daemon OS user (`dangerous`)

Every completed node call includes node identity and task ID in the normal agent trace. Online state proves connectivity only; a completed task result proves execution.

## Register MCP servers

Cherry supports MCP stdio and Streamable HTTP through the official TypeScript SDK. Register servers through the admin API. Do not send secret values. `envFrom` and `headersFrom` map a target variable/header to the name of a Gateway process environment variable.

Stdio example:

```bash
curl -sS -X POST "$CHERRY_GATEWAY_URL/mcp/servers" \
  -H "Authorization: Bearer $CHERRY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"filesystem",
    "transport":"stdio",
    "command":"npx",
    "args":["-y","@modelcontextprotocol/server-filesystem","/srv/shared"],
    "risk":"external"
  }'
```

Streamable HTTP example with an environment-backed Authorization header:

```bash
curl -sS -X POST "$CHERRY_GATEWAY_URL/mcp/servers" \
  -H "Authorization: Bearer $CHERRY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"company-tools",
    "transport":"streamable-http",
    "url":"https://mcp.example.com/mcp",
    "headersFrom":{"Authorization":"COMPANY_MCP_AUTHORIZATION"},
    "risk":"external",
    "toolRisks":{"read_status":"safe","delete_job":"dangerous"}
  }'
```

Discovered tools are dynamically registered as `mcp_<server>_<id>_<tool>`. MCP annotations can lower a closed-world read-only tool to `safe` or raise a destructive tool to `dangerous`; explicit `toolRisks` overrides take precedence.

## Persistent Chat ID sessions and skills

Each Chat ID keeps bounded, secret-redacted user/assistant history in `.cherry/chat-sessions.json`. Requests sharing a Chat ID execute serially, preventing overlapping turns from corrupting context. The same ID is also the node binding key and audit session ID.

Cherry discovers workflow skills from `skills/*/SKILL.md`. Matching skill instructions are injected only for relevant requests. `cherry-node-operator` teaches Cherry to continue from connectivity into execution and verification.

Relevant configuration:

```env
CHERRY_CHAT_SESSION_FILE=.cherry/chat-sessions.json
CHERRY_NODE_FILE=.cherry/nodes.json
CHERRY_NODE_TASK_TIMEOUT_MS=60000
CHERRY_MCP_SERVER_FILE=.cherry/mcp-servers.json
CHERRY_SKILLS_DIRECTORY=skills
```
