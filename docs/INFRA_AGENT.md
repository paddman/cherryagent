# CherryAgent Cloud / IDC / Infra Operations Agent

CherryAgent includes an infrastructure control plane for Proxmox VE and VMware vSphere/vCenter. The design goal is not to make the model merely answer infrastructure questions. The agent should inspect real inventory, use bounded Engineer Loops for non-trivial operations, execute through risk-aware tools, verify observable state, and only then report success.

## Operating loop

```text
User / Alert / Schedule / Incident
              |
              v
        Engineer Loop
              |
   Plan -> Execute -> Observe
              |
   Diagnose -> Patch -> Test
              |
         Verify -> Learn
              |
       Correctness Loop
              |
       Verified final answer
              |
       Automatic Runbook
```

For infrastructure work, Cherry should:

1. Inspect the configured control planes.
2. Read current inventory and health state before choosing a target.
3. Start an Engineer Loop for non-trivial incidents or changes.
4. Prefer read-only diagnostics first.
5. Use approval-protected state-changing tools only when needed.
6. Capture asynchronous task identifiers and inspect their status/logs.
7. Re-read final VM, host, storage, network, or task state after the change.
8. Record verification evidence before claiming success.
9. Save a reusable Runbook after a verified incident fix.

## Proxmox VE tool pack

### Read-only

- `proxmox_get_version`
- `proxmox_get_cluster_status`
- `proxmox_list_nodes`
- `proxmox_get_node_status`
- `proxmox_list_vms`
- `proxmox_list_storage`
- `proxmox_list_network`
- `proxmox_get_task_status`
- `proxmox_get_task_log`

### State-changing

- `proxmox_start_vm` — external
- `proxmox_shutdown_vm` — external
- `proxmox_reboot_vm` — external
- `proxmox_create_snapshot` — external
- `proxmox_migrate_vm` — external
- `proxmox_stop_vm` — dangerous

The Proxmox connector uses API-token authentication and preserves the returned asynchronous task identifier so the agent can verify status and task logs.

## VMware vSphere / vCenter tool pack

### Read-only

- `vsphere_list_vms`
- `vsphere_get_vm`
- `vsphere_list_hosts`
- `vsphere_list_clusters`
- `vsphere_list_datastores`
- `vsphere_list_networks`

### State-changing

- `vsphere_power_on_vm` — external
- `vsphere_suspend_vm` — external
- `vsphere_power_off_vm` — dangerous
- `vsphere_reset_vm` — dangerous

The connector creates and refreshes a vCenter API session and uses vSphere inventory identifiers rather than guessing human-readable names.

## Risk policy

```text
safe       -> read-only diagnostics and inventory
write      -> local planner/memory/runbook state
external   -> changes a remote VM or infrastructure state
dangerous  -> hard power off, hard reset, destructive or high-impact action
```

Recommended default:

```env
CHERRY_AUTO_APPROVE=safe,write
```

This means remote infrastructure changes enter the Approval Inbox before execution.

## Configuration

```env
CHERRY_INFRA_TIMEOUT_MS=20000

CHERRY_PROXMOX_BASE_URL=https://pve.example.internal:8006
CHERRY_PROXMOX_TOKEN_ID=user@pam!cherry
CHERRY_PROXMOX_TOKEN_SECRET=
CHERRY_PROXMOX_VERIFY_TLS=true

CHERRY_VSPHERE_BASE_URL=https://vcenter.example.internal
CHERRY_VSPHERE_USERNAME=
CHERRY_VSPHERE_PASSWORD=
CHERRY_VSPHERE_VERIFY_TLS=true
```

Keep TLS verification enabled in production. For internal labs using private or self-signed certificates, install the appropriate CA whenever possible rather than disabling verification globally.

## Example: Proxmox VM incident

```text
User: VM 220 on dc98 is down. Find the cause and recover it safely.
```

Expected tool pattern:

```text
engineer_start_loop
        |
proxmox_list_vms
        |
proxmox_get_node_status
        |
engineer_record_phase(observe)
        |
engineer_record_phase(diagnose)
        |
proxmox_start_vm
        |
Approval Inbox
        |
proxmox_get_task_status
        |
proxmox_get_task_log
        |
proxmox_list_vms
        |
engineer_record_phase(verify, evidence)
        |
engineer_complete_loop
        |
Correctness Loop
        |
Verified answer + Runbook
```

## Example: vSphere host / datastore investigation

```text
User: Find why VMs in the production cluster are slow.
```

The agent should begin read-only:

```text
vsphere_list_clusters
vsphere_list_hosts
vsphere_list_datastores
vsphere_list_vms
```

It should correlate inventory and observed state, avoid disruptive actions unless justified, and never mark a root cause as confirmed without supporting evidence.

## Current scope

Implemented now:

- Proxmox VE cluster/node/VM/storage/network inventory
- Proxmox VM lifecycle actions
- Proxmox snapshot and migration actions
- Proxmox asynchronous task status and logs
- vCenter VM/host/cluster/datastore/network inventory
- vSphere VM power operations
- Engineer Loop integration through tool calling
- Approval Gate risk enforcement
- Correctness Loop verification before final answer
- Runbook learning after verified engineering success

Recommended next infrastructure packs:

1. SSH execution with command allowlists and per-host policy
2. Docker and systemd diagnostics
3. Kubernetes
4. HTTP/DNS/TLS/network diagnostics
5. SNMP/Redfish/iLO/iDRAC hardware health
6. VMware alarms, events, performance counters, vMotion and snapshots
7. Proxmox Ceph, backup, replication, HA and SDN
8. Prometheus/Grafana/Zabbix/LibreNMS monitoring
9. Cisco ACI/Nexus, MikroTik and firewall connectors
10. Multi-site topology and dependency graph
