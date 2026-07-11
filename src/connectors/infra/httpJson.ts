import { request as httpRequest, type RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";

export type JsonHttpRequest = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
};

export type JsonHttpResponse<T = unknown> = {
  status: number;
  headers: Record<string, string | string[]>;
  data: T;
};

function normalizedHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function parseBody(raw: string): unknown {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function jsonHttpRequest<T = unknown>(url: URL, input: JsonHttpRequest = {}): Promise<JsonHttpResponse<T>> {
  const method = input.method ?? "GET";
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? 20_000);
  const headers: Record<string, string> = { accept: "application/json", ...(input.headers ?? {}) };
  if (input.body !== undefined && headers["content-length"] === undefined) {
    headers["content-length"] = String(Buffer.byteLength(input.body));
  }

  return await new Promise<JsonHttpResponse<T>>((resolve, reject) => {
    const onResponse = (response: import("node:http").IncomingMessage): void => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode ?? 0;
        const parsed = parseBody(raw);
        if (status < 200 || status >= 300) {
          const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
          reject(new Error(`HTTP ${status} ${method} ${url.pathname}${url.search}: ${detail.slice(0, 1_500)}`));
          return;
        }
        resolve({
          status,
          headers: normalizedHeaders(response.headers),
          data: parsed as T,
        });
      });
    };

    const common: HttpRequestOptions = {
      method,
      headers,
      timeout: timeoutMs,
    };

    const request = url.protocol === "https:"
      ? httpsRequest(url, { ...common, rejectUnauthorized: input.rejectUnauthorized ?? true } as HttpsRequestOptions, onResponse)
      : httpRequest(url, common, onResponse);

    request.on("timeout", () => request.destroy(new Error(`Request timeout after ${timeoutMs} ms: ${url.toString()}`)));
    request.on("error", reject);
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}
