import { jsonHttpRequest } from "../infra/httpJson.js";

export type VsphereClientOptions = {
  baseUrl: string;
  username: string;
  password: string;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
};

export type VspherePowerAction = "start" | "stop" | "reset" | "suspend";

export class VsphereClient {
  private readonly baseUrl: string;
  private readonly rejectUnauthorized: boolean;
  private readonly timeoutMs: number;
  private sessionId: string | undefined;

  constructor(private readonly options: VsphereClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.rejectUnauthorized = options.rejectUnauthorized ?? true;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 20_000);
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.options.username && this.options.password);
  }

  private async createSession(): Promise<string> {
    if (!this.isConfigured()) throw new Error("vSphere connector is not configured");
    const url = new URL(`${this.baseUrl}/api/session`);
    const basic = Buffer.from(`${this.options.username}:${this.options.password}`).toString("base64");
    const response = await jsonHttpRequest<unknown>(url, {
      method: "POST",
      headers: { authorization: `Basic ${basic}` },
      rejectUnauthorized: this.rejectUnauthorized,
      timeoutMs: this.timeoutMs,
    });
    if (typeof response.data !== "string" || !response.data.trim()) {
      throw new Error("vSphere session endpoint did not return a session identifier");
    }
    this.sessionId = response.data.trim();
    return this.sessionId;
  }

  private async request<T>(path: string, input: { method?: string; body?: unknown; retryAuth?: boolean } = {}): Promise<T> {
    const session = this.sessionId ?? await this.createSession();
    const url = new URL(`${this.baseUrl}${path}`);
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    try {
      const response = await jsonHttpRequest<T>(url, {
        method: input.method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          "vmware-api-session-id": session,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body } : {}),
        rejectUnauthorized: this.rejectUnauthorized,
        timeoutMs: this.timeoutMs,
      });
      return response.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((input.retryAuth ?? true) && (message.includes("HTTP 401") || message.includes("HTTP 403"))) {
        this.sessionId = undefined;
        return await this.request<T>(path, { ...input, retryAuth: false });
      }
      throw error;
    }
  }

  async listVms(): Promise<unknown> {
    return await this.request("/api/vcenter/vm");
  }

  async getVm(vmId: string): Promise<unknown> {
    return await this.request(`/api/vcenter/vm/${encodeURIComponent(vmId)}`);
  }

  async listHosts(): Promise<unknown> {
    return await this.request("/api/vcenter/host");
  }

  async listClusters(): Promise<unknown> {
    return await this.request("/api/vcenter/cluster");
  }

  async listDatastores(): Promise<unknown> {
    return await this.request("/api/vcenter/datastore");
  }

  async listNetworks(): Promise<unknown> {
    return await this.request("/api/vcenter/network");
  }

  async powerAction(vmId: string, action: VspherePowerAction): Promise<unknown> {
    return await this.request(`/api/vcenter/vm/${encodeURIComponent(vmId)}/power?action=${encodeURIComponent(action)}`, {
      method: "POST",
    });
  }
}
