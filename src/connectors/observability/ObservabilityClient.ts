import { jsonHttpRequest } from "../infra/httpJson.js";

export type ObservabilityClientOptions = {
  prometheusBaseUrl?: string;
  prometheusBearerToken?: string;
  grafanaBaseUrl?: string;
  grafanaApiToken?: string;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
};

type PrometheusEnvelope<T> = {
  status: "success" | "error";
  data?: T;
  errorType?: string;
  error?: string;
};

export type ObservabilityStatus = {
  prometheus: {
    configured: boolean;
    baseUrl: string | null;
  };
  grafana: {
    configured: boolean;
    baseUrl: string | null;
  };
  verifyTls: boolean;
  timeoutMs: number;
};

function normalizedBaseUrl(value?: string): string {
  return value?.trim().replace(/\/$/, "") ?? "";
}

export class ObservabilityClient {
  private readonly prometheusBaseUrl: string;
  private readonly grafanaBaseUrl: string;
  private readonly rejectUnauthorized: boolean;
  private readonly timeoutMs: number;

  constructor(private readonly options: ObservabilityClientOptions) {
    this.prometheusBaseUrl = normalizedBaseUrl(options.prometheusBaseUrl);
    this.grafanaBaseUrl = normalizedBaseUrl(options.grafanaBaseUrl);
    this.rejectUnauthorized = options.rejectUnauthorized ?? true;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 20_000);
  }

  prometheusConfigured(): boolean {
    return Boolean(this.prometheusBaseUrl);
  }

  grafanaConfigured(): boolean {
    return Boolean(this.grafanaBaseUrl);
  }

  status(): ObservabilityStatus {
    return {
      prometheus: {
        configured: this.prometheusConfigured(),
        baseUrl: this.prometheusBaseUrl || null,
      },
      grafana: {
        configured: this.grafanaConfigured(),
        baseUrl: this.grafanaBaseUrl || null,
      },
      verifyTls: this.rejectUnauthorized,
      timeoutMs: this.timeoutMs,
    };
  }

  private prometheusHeaders(): Record<string, string> {
    return this.options.prometheusBearerToken
      ? { authorization: `Bearer ${this.options.prometheusBearerToken}` }
      : {};
  }

  private grafanaHeaders(): Record<string, string> {
    return this.options.grafanaApiToken
      ? { authorization: `Bearer ${this.options.grafanaApiToken}` }
      : {};
  }

  private async prometheusRequest<T>(path: string, params: URLSearchParams = new URLSearchParams()): Promise<T> {
    if (!this.prometheusConfigured()) throw new Error("Prometheus connector is not configured");
    const url = new URL(`${this.prometheusBaseUrl}${path}`);
    params.forEach((value, key) => url.searchParams.append(key, value));

    const response = await jsonHttpRequest<PrometheusEnvelope<T>>(url, {
      headers: this.prometheusHeaders(),
      rejectUnauthorized: this.rejectUnauthorized,
      timeoutMs: this.timeoutMs,
    });

    const envelope = response.data;
    if (!envelope || typeof envelope !== "object" || envelope.status !== "success" || envelope.data === undefined) {
      const detail = envelope?.error
        ? `${envelope.errorType ?? "prometheus_error"}: ${envelope.error}`
        : `Unexpected Prometheus response for ${path}`;
      throw new Error(detail);
    }
    return envelope.data;
  }

  private async grafanaRequest<T>(path: string, params: URLSearchParams = new URLSearchParams()): Promise<T> {
    if (!this.grafanaConfigured()) throw new Error("Grafana connector is not configured");
    const url = new URL(`${this.grafanaBaseUrl}${path}`);
    params.forEach((value, key) => url.searchParams.append(key, value));

    const response = await jsonHttpRequest<T>(url, {
      headers: this.grafanaHeaders(),
      rejectUnauthorized: this.rejectUnauthorized,
      timeoutMs: this.timeoutMs,
    });
    return response.data;
  }

  async prometheusQuery(query: string, time?: string | number): Promise<unknown> {
    const params = new URLSearchParams({ query });
    if (time !== undefined) params.set("time", String(time));
    return await this.prometheusRequest("/api/v1/query", params);
  }

  async prometheusQueryRange(input: {
    query: string;
    start: string | number;
    end: string | number;
    step: string | number;
  }): Promise<unknown> {
    const params = new URLSearchParams({
      query: input.query,
      start: String(input.start),
      end: String(input.end),
      step: String(input.step),
    });
    return await this.prometheusRequest("/api/v1/query_range", params);
  }

  async prometheusAlerts(): Promise<unknown> {
    return await this.prometheusRequest("/api/v1/alerts");
  }

  async grafanaHealth(): Promise<unknown> {
    return await this.grafanaRequest("/api/health");
  }

  async grafanaSearch(input: {
    query?: string | undefined;
    tag?: string | undefined;
    type?: "dash-db" | "dash-folder" | undefined;
  } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (input.query) params.set("query", input.query);
    if (input.tag) params.append("tag", input.tag);
    if (input.type) params.set("type", input.type);
    return await this.grafanaRequest("/api/search", params);
  }

  async grafanaAnnotations(input: {
    from?: number | undefined;
    to?: number | undefined;
    tags?: string[] | undefined;
    limit?: number | undefined;
  } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (input.from !== undefined) params.set("from", String(input.from));
    if (input.to !== undefined) params.set("to", String(input.to));
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    for (const tag of input.tags ?? []) params.append("tags", tag);
    return await this.grafanaRequest("/api/annotations", params);
  }
}
