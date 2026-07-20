---
name: cherry-node-operator
description: Operate paired Cherry Nodes and MCP tools to complete remote machine, server, process, file, shell, integration, เชื่อมต่อเครื่อง, เซิร์ฟเวอร์, และงาน MCP requests. Use for login-like remote work, continuing a task on another host, binding a Chat ID to a node, or calling external MCP capabilities.
---

# Cherry Node Operator

Complete the requested work through the execution surface; do not stop after checking connection state.

## Paired node workflow

1. Call `node_get_binding` for the current Chat ID. If no binding exists, call `node_list`.
2. If exactly one node exists, continue because Gateway auto-binds it. If several exist, bind the intended one with `node_bind_chat`.
3. Call the narrowest operation: `node_system_info`, `node_process_list`, `node_read_file`, `node_write_file`, or `node_exec`.
4. If approval is required, report the approval ID and exact pending operation. Continue execution after approval instead of restarting discovery.
5. Verify the requested outcome with a read-only node operation and report node name, task ID, output evidence, and final status.

Never claim a node action succeeded from online state alone. Pairing and online status prove connectivity; only a completed task proves execution.

## MCP workflow

1. Call `mcp_list_servers` when the available integration is unclear.
2. Select a dynamic `mcp_<server>_<id>_<tool>` by its description and call it directly.
3. Respect its registered risk and approval requirement.
4. Treat an MCP error result as failure; correct safe arguments or report the exact external blocker.

Never ask for MCP tokens in chat. MCP config maps header and environment names to process environment variables.

## SSH fallback

Use `linux_*` only when the target is an SSH profile rather than a paired Cherry Node. For an SSH action request, call `linux_login` and continue into the requested Linux operation in the same run.
