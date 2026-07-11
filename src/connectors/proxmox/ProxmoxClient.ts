import { jsonHttpRequest } from "../infra/httpJson.js";

export type ProxmoxClientOptions = {
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
};

type ProxmoxEnvelope<T> = { data: T };
export type ProxmoxVmType = "qemu" | "lxc";
export type ProxmoxVmAction = "start" | "shutdown" | "reboot" | "stop";

export class ProxmoxClient {
  private readonly baseUrl: string;
  private readonly rejectUnauthorized: boolean;
  private readonly timeoutMs: number;

  constructor(private readonly options: ProxmoxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.rejectUnauthorized = options.rejectUnauthorized ?? true;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 20_000);
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.options.tokenId && this.options.tokenSecret);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `PVEAPIToken=${this.options.tokenId}=${this.options.tokenSecret}`,
      ...extra,
    };
  }

  private async request<T>(path: string, input: { method?: string; form?: Record<string, string | number | boolean> } = {}): Promise<T> {
    if (!this.isConfigured()) throw new Error("Proxmox connector is not configured");
    const url = new URL(`${this.baseUrl}/api2/json${path}`);
    let body: string | undefined;
    const headers = this.headers();
    if (input.form) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(input.form)) params.set(key, String(value));
      body = params.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const response = await jsonHttpRequest<ProxmoxEnvelope<T>>(url, {
      method: input.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      ...(body !== undefined ? { body } : {}),
      rejectUnauthorized: this.rejectUnauthorized,
      timeoutMs: this.timeoutMs,
    });
    if (!response.data || typeof response.data !== "object" || !("data" in response.data)) {
      throw new Error(`Unexpected Proxmox API response for ${path}`);
    }
    return response.data.data;
  }

  async version(): Promise<unknown> {
    return await this.request("/version");
  }

  async clusterStatus(): Promise<unknown> {
    return await this.request("/cluster/status");
  }

  async listNodes(): Promise<unknown> {
    return await this.request("/nodes");
  }

  async nodeStatus(node: string): Promise<unknown> {
    return await this.request(`/nodes/${encodeURIComponent(node)}/status`);
  }

  async listVms(): Promise<unknown> {
    return await this.request("/cluster/resources?type=vm");
  }

  async listStorage(node: string): Promise<unknown> {
    return await this.request(`/nodes/${encodeURIComponent(node)}/storage`);
  }

  async listNetwork(node: string): Promise<unknown> {
    return await this.request(`/nodes/${encodeURIComponent(node)}/network`);
  }

  async vmAction(node: string, type: ProxmoxVmType, vmid: number, action: ProxmoxVmAction): Promise<{ taskId: unknown }> {
    const taskId = await this.request(`/nodes/${encodeURIComponent(node)}/${type}/${vmid}/status/${action}`, { method: "POST" });
    return { taskId };
  }

  async createSnapshot(input: {
    node: string;
    type: ProxmoxVmType;
    vmid: number;
    name: string;
    description?: string;
    includeMemory?: boolean;
  }): Promise<{ taskId: unknown }> {
    const taskId = await this.request(`/nodes/${encodeURIComponent(input.node)}/${input.type}/${input.vmid}/snapshot`, {
      method: "POST",
      form: {
        snapname: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.includeMemory !== undefined ? { vmstate: input.includeMemory ? 1 : 0 } : {}),
      },
    });
    return { taskId };
  }

  async migrateVm(input: {
    node: string;
    type: ProxmoxVmType;
    vmid: number;
    target: string;
    online?: boolean;
  }): Promise<{ taskId: unknown }> {
    const taskId = await this.request(`/nodes/${encodeURIComponent(input.node)}/${input.type}/${input.vmid}/migrate`, {
      method: "POST",
      form: {
        target: input.target,
        ...(input.online !== undefined ? { online: input.online ? 1 : 0 } : {}),
      },
    });
    return { taskId };
  }

  async taskStatus(node: string, upid: string): Promise<unknown> {
    return await this.request(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`);
  }

  async taskLog(node: string, upid: string, start = 0, limit = 200): Promise<unknown> {
    return await this.request(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/log?start=${start}&limit=${limit}`);
  }
}
