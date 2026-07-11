import type { AgentTool } from "../../core/types.js";
import type { ProxmoxClient, ProxmoxVmType } from "../../connectors/proxmox/ProxmoxClient.js";
import type { VsphereClient } from "../../connectors/vsphere/VsphereClient.js";

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string argument: ${key}`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredInteger(args: Record<string, unknown>, key: string): number {
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be boolean`);
  return value;
}

function vmType(value: unknown): ProxmoxVmType {
  if (value !== "qemu" && value !== "lxc") throw new Error("type must be qemu or lxc");
  return value;
}

const proxmoxVmTargetSchema = {
  node: { type: "string", description: "Proxmox node name" },
  type: { type: "string", enum: ["qemu", "lxc"] },
  vmid: { type: "number", description: "Numeric VM or container ID" },
} as const;

export function createInfraTools(proxmox: ProxmoxClient, vsphere: VsphereClient): AgentTool[] {
  return [
    {
      name: "infra_get_control_plane_status",
      description: "Check which infrastructure control planes are configured before attempting Proxmox or vSphere operations.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({
        proxmox: { configured: proxmox.isConfigured() },
        vsphere: { configured: vsphere.isConfigured() },
      }),
    },
    {
      name: "proxmox_get_version",
      description: "Read Proxmox VE version information. Use as a lightweight connectivity and API health check.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => proxmox.version(),
    },
    {
      name: "proxmox_get_cluster_status",
      description: "Read Proxmox cluster membership and quorum-related cluster status.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => proxmox.clusterStatus(),
    },
    {
      name: "proxmox_list_nodes",
      description: "List Proxmox nodes with available node-level status fields.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => proxmox.listNodes(),
    },
    {
      name: "proxmox_get_node_status",
      description: "Read CPU, memory, uptime and other status information for one Proxmox node.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { node: { type: "string" } },
        required: ["node"],
        additionalProperties: false,
      },
      execute: async (args) => proxmox.nodeStatus(requiredString(args, "node")),
    },
    {
      name: "proxmox_list_vms",
      description: "List VMs and containers across the Proxmox cluster. Inspect inventory before acting on a VM ID.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => proxmox.listVms(),
    },
    {
      name: "proxmox_list_storage",
      description: "List storage visible to one Proxmox node for capacity and health investigation.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { node: { type: "string" } },
        required: ["node"],
        additionalProperties: false,
      },
      execute: async (args) => proxmox.listStorage(requiredString(args, "node")),
    },
    {
      name: "proxmox_list_network",
      description: "List network interfaces, bridges, bonds and VLAN-related configuration visible through the Proxmox node API.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { node: { type: "string" } },
        required: ["node"],
        additionalProperties: false,
      },
      execute: async (args) => proxmox.listNetwork(requiredString(args, "node")),
    },
    {
      name: "proxmox_get_task_status",
      description: "Read the status of an asynchronous Proxmox task by UPID. Use this to verify VM power, snapshot or migration operations.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { node: { type: "string" }, upid: { type: "string" } },
        required: ["node", "upid"],
        additionalProperties: false,
      },
      execute: async (args) => proxmox.taskStatus(requiredString(args, "node"), requiredString(args, "upid")),
    },
    {
      name: "proxmox_get_task_log",
      description: "Read recent Proxmox asynchronous task log lines for diagnosis and verification.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          node: { type: "string" },
          upid: { type: "string" },
          start: { type: "number" },
          limit: { type: "number" },
        },
        required: ["node", "upid"],
        additionalProperties: false,
      },
      execute: async (args) => proxmox.taskLog(
        requiredString(args, "node"),
        requiredString(args, "upid"),
        typeof args.start === "number" ? args.start : 0,
        typeof args.limit === "number" ? args.limit : 200,
      ),
    },
    {
      name: "proxmox_start_vm",
      description: "Start a Proxmox QEMU VM or LXC container. Verify the returned task and resulting VM state before claiming success.",
      risk: "external",
      parameters: { type: "object", properties: proxmoxVmTargetSchema, required: ["node", "type", "vmid"], additionalProperties: false },
      execute: async (args) => proxmox.vmAction(requiredString(args, "node"), vmType(args.type), requiredInteger(args, "vmid"), "start"),
    },
    {
      name: "proxmox_shutdown_vm",
      description: "Request a graceful shutdown of a Proxmox QEMU VM or LXC container. Verify the task and resulting state.",
      risk: "external",
      parameters: { type: "object", properties: proxmoxVmTargetSchema, required: ["node", "type", "vmid"], additionalProperties: false },
      execute: async (args) => proxmox.vmAction(requiredString(args, "node"), vmType(args.type), requiredInteger(args, "vmid"), "shutdown"),
    },
    {
      name: "proxmox_reboot_vm",
      description: "Request a reboot of a Proxmox QEMU VM or LXC container. Verify the asynchronous task and final running state.",
      risk: "external",
      parameters: { type: "object", properties: proxmoxVmTargetSchema, required: ["node", "type", "vmid"], additionalProperties: false },
      execute: async (args) => proxmox.vmAction(requiredString(args, "node"), vmType(args.type), requiredInteger(args, "vmid"), "reboot"),
    },
    {
      name: "proxmox_stop_vm",
      description: "Force-stop a Proxmox QEMU VM or LXC container. This is disruptive and should only be used when graceful shutdown is unsuitable or has failed.",
      risk: "dangerous",
      parameters: { type: "object", properties: proxmoxVmTargetSchema, required: ["node", "type", "vmid"], additionalProperties: false },
      execute: async (args) => proxmox.vmAction(requiredString(args, "node"), vmType(args.type), requiredInteger(args, "vmid"), "stop"),
    },
    {
      name: "proxmox_create_snapshot",
      description: "Create a Proxmox VM or container snapshot before a risky change. Verify the asynchronous task result.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          ...proxmoxVmTargetSchema,
          name: { type: "string" },
          description: { type: "string" },
          includeMemory: { type: "boolean" },
        },
        required: ["node", "type", "vmid", "name"],
        additionalProperties: false,
      },
      execute: async (args) => proxmox.createSnapshot({
        node: requiredString(args, "node"),
        type: vmType(args.type),
        vmid: requiredInteger(args, "vmid"),
        name: requiredString(args, "name"),
        ...(optionalString(args, "description") ? { description: optionalString(args, "description") } : {}),
        ...(optionalBoolean(args, "includeMemory") !== undefined ? { includeMemory: optionalBoolean(args, "includeMemory") } : {}),
      }),
    },
    {
      name: "proxmox_migrate_vm",
      description: "Migrate a Proxmox VM or container to another cluster node. Inspect source, target, storage and current workload first, then verify the migration task and resulting inventory.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          ...proxmoxVmTargetSchema,
          target: { type: "string" },
          online: { type: "boolean" },
        },
        required: ["node", "type", "vmid", "target"],
        additionalProperties: false,
      },
      execute: async (args) => proxmox.migrateVm({
        node: requiredString(args, "node"),
        type: vmType(args.type),
        vmid: requiredInteger(args, "vmid"),
        target: requiredString(args, "target"),
        ...(optionalBoolean(args, "online") !== undefined ? { online: optionalBoolean(args, "online") } : {}),
      }),
    },
    {
      name: "vsphere_list_vms",
      description: "List virtual machines from vCenter. Inspect inventory and exact VM identifiers before power actions.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => vsphere.listVms(),
    },
    {
      name: "vsphere_get_vm",
      description: "Read detailed vCenter inventory information for one VM identifier.",
      risk: "safe",
      parameters: { type: "object", properties: { vmId: { type: "string" } }, required: ["vmId"], additionalProperties: false },
      execute: async (args) => vsphere.getVm(requiredString(args, "vmId")),
    },
    {
      name: "vsphere_list_hosts",
      description: "List ESXi hosts managed by vCenter for inventory and health investigation.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => vsphere.listHosts(),
    },
    {
      name: "vsphere_list_clusters",
      description: "List vSphere clusters managed by vCenter.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => vsphere.listClusters(),
    },
    {
      name: "vsphere_list_datastores",
      description: "List vSphere datastores for storage inventory and capacity investigation.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => vsphere.listDatastores(),
    },
    {
      name: "vsphere_list_networks",
      description: "List vCenter network inventory available through the vSphere Automation API.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => vsphere.listNetworks(),
    },
    {
      name: "vsphere_power_on_vm",
      description: "Power on a vSphere VM through vCenter. Verify resulting VM state before claiming success.",
      risk: "external",
      parameters: { type: "object", properties: { vmId: { type: "string" } }, required: ["vmId"], additionalProperties: false },
      execute: async (args) => vsphere.powerAction(requiredString(args, "vmId"), "start"),
    },
    {
      name: "vsphere_suspend_vm",
      description: "Suspend a vSphere VM through vCenter. Verify resulting state before claiming success.",
      risk: "external",
      parameters: { type: "object", properties: { vmId: { type: "string" } }, required: ["vmId"], additionalProperties: false },
      execute: async (args) => vsphere.powerAction(requiredString(args, "vmId"), "suspend"),
    },
    {
      name: "vsphere_power_off_vm",
      description: "Hard power off a vSphere VM. This is disruptive and must be protected by dangerous-action approval.",
      risk: "dangerous",
      parameters: { type: "object", properties: { vmId: { type: "string" } }, required: ["vmId"], additionalProperties: false },
      execute: async (args) => vsphere.powerAction(requiredString(args, "vmId"), "stop"),
    },
    {
      name: "vsphere_reset_vm",
      description: "Hard reset a vSphere VM. This is disruptive and must be protected by dangerous-action approval.",
      risk: "dangerous",
      parameters: { type: "object", properties: { vmId: { type: "string" } }, required: ["vmId"], additionalProperties: false },
      execute: async (args) => vsphere.powerAction(requiredString(args, "vmId"), "reset"),
    },
  ];
}
