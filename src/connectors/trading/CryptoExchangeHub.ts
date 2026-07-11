import { createHmac } from "node:crypto";
import { jsonHttpRequest } from "../infra/httpJson.js";

export type CryptoExchangeName = "binance" | "mexc" | "bitkub" | "xt";
export type SpotOrderSide = "BUY" | "SELL";
export type SpotOrderType = "LIMIT" | "MARKET";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type SpotOrderInput = {
  exchange: CryptoExchangeName;
  symbol: string;
  side: SpotOrderSide;
  type: SpotOrderType;
  quantity?: number;
  quoteQuantity?: number;
  price?: number;
  clientOrderId?: string;
};

export type OrderStatusInput = {
  exchange: CryptoExchangeName;
  symbol: string;
  orderId: string;
};

export type ExchangeCredentials = {
  apiKey?: string;
  apiSecret?: string;
};

export type CryptoExchangeHubOptions = {
  timeoutMs: number;
  binance: ExchangeCredentials;
  mexc: ExchangeCredentials;
  bitkub: ExchangeCredentials;
  xt: { appKey?: string; secretKey?: string };
};

interface ExchangeClient {
  isConfigured(): boolean;
  ticker(symbol: string): Promise<unknown>;
  candles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  placeOrder(input: SpotOrderInput): Promise<unknown>;
  getOrder(input: OrderStatusInput): Promise<unknown>;
}

function hmacSha256(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function requiredCredentials(name: string, apiKey?: string, apiSecret?: string): { apiKey: string; apiSecret: string } {
  if (!apiKey || !apiSecret) throw new Error(`${name} trading credentials are not configured`);
  return { apiKey, apiSecret };
}

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitPair(raw: string): { base: string; quote: string } {
  const cleaned = raw.trim().toUpperCase();
  const separated = cleaned.split(/[\/_-]/).filter(Boolean);
  if (separated.length === 2 && separated[0] && separated[1]) {
    return { base: separated[0], quote: separated[1] };
  }
  const quotes = ["USDT", "USDC", "FDUSD", "BUSD", "THB", "USD", "BTC", "ETH", "EUR"];
  for (const quote of quotes) {
    if (cleaned.endsWith(quote) && cleaned.length > quote.length) {
      return { base: cleaned.slice(0, -quote.length), quote };
    }
  }
  throw new Error(`Cannot infer trading pair from symbol: ${raw}. Use BASE/QUOTE format.`);
}

export function normalizeCryptoSymbol(exchange: CryptoExchangeName, raw: string): string {
  const { base, quote } = splitPair(raw);
  if (exchange === "binance" || exchange === "mexc") return `${base}${quote}`;
  return `${base}_${quote}`;
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
}

class BinanceLikeClient implements ExchangeClient {
  constructor(
    private readonly name: "Binance" | "MEXC",
    private readonly baseUrl: string,
    private readonly apiKeyHeader: string,
    private readonly credentials: ExchangeCredentials,
    private readonly timeoutMs: number,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.credentials.apiKey && this.credentials.apiSecret);
  }

  async ticker(symbol: string): Promise<unknown> {
    const normalized = normalizeCryptoSymbol(this.name === "Binance" ? "binance" : "mexc", symbol);
    const url = new URL(`${this.baseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(normalized)}`);
    return (await jsonHttpRequest(url, { timeoutMs: this.timeoutMs })).data;
  }

  async candles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const normalized = normalizeCryptoSymbol(this.name === "Binance" ? "binance" : "mexc", symbol);
    const url = new URL(`${this.baseUrl}/api/v3/klines?symbol=${encodeURIComponent(normalized)}&interval=${encodeURIComponent(interval)}&limit=${Math.min(1000, Math.max(1, limit))}`);
    const payload = (await jsonHttpRequest<unknown[]>(url, { timeoutMs: this.timeoutMs })).data;
    if (!Array.isArray(payload)) throw new Error(`${this.name} kline response was not an array`);
    return payload.map((row) => {
      if (!Array.isArray(row)) throw new Error(`${this.name} returned an invalid kline row`);
      return {
        time: finite(row[0]),
        open: finite(row[1]),
        high: finite(row[2]),
        low: finite(row[3]),
        close: finite(row[4]),
        volume: finite(row[5]),
      };
    });
  }

  private signedUrl(path: string, params: Record<string, string | number | undefined>): { url: URL; apiKey: string } {
    const { apiKey, apiSecret } = requiredCredentials(this.name, this.credentials.apiKey, this.credentials.apiSecret);
    const query = qs({ ...params, timestamp: Date.now(), recvWindow: 10_000 });
    const signature = hmacSha256(apiSecret, query);
    return { url: new URL(`${this.baseUrl}${path}?${query}&signature=${signature}`), apiKey };
  }

  async placeOrder(input: SpotOrderInput): Promise<unknown> {
    const symbol = normalizeCryptoSymbol(this.name === "Binance" ? "binance" : "mexc", input.symbol);
    if (input.type === "LIMIT" && (input.quantity === undefined || input.price === undefined)) {
      throw new Error("LIMIT order requires quantity and price");
    }
    if (input.type === "MARKET" && input.quantity === undefined && input.quoteQuantity === undefined) {
      throw new Error("MARKET order requires quantity or quoteQuantity");
    }
    const { url, apiKey } = this.signedUrl("/api/v3/order", {
      symbol,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      quoteOrderQty: input.quoteQuantity,
      price: input.price,
      timeInForce: input.type === "LIMIT" ? "GTC" : undefined,
      newClientOrderId: input.clientOrderId,
    });
    return (await jsonHttpRequest(url, {
      method: "POST",
      headers: { [this.apiKeyHeader]: apiKey },
      timeoutMs: this.timeoutMs,
    })).data;
  }

  async getOrder(input: OrderStatusInput): Promise<unknown> {
    const symbol = normalizeCryptoSymbol(this.name === "Binance" ? "binance" : "mexc", input.symbol);
    const { url, apiKey } = this.signedUrl("/api/v3/order", { symbol, orderId: input.orderId });
    return (await jsonHttpRequest(url, {
      headers: { [this.apiKeyHeader]: apiKey },
      timeoutMs: this.timeoutMs,
    })).data;
  }
}

class BitkubClient implements ExchangeClient {
  private readonly baseUrl = "https://api.bitkub.com";

  constructor(private readonly credentials: ExchangeCredentials, private readonly timeoutMs: number) {}

  isConfigured(): boolean {
    return Boolean(this.credentials.apiKey && this.credentials.apiSecret);
  }

  async ticker(symbol: string): Promise<unknown> {
    const normalized = normalizeCryptoSymbol("bitkub", symbol);
    const url = new URL(`${this.baseUrl}/api/v3/market/ticker?sym=${encodeURIComponent(normalized)}`);
    return (await jsonHttpRequest(url, { timeoutMs: this.timeoutMs })).data;
  }

  async candles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const normalized = normalizeCryptoSymbol("bitkub", symbol);
    const resolutions: Record<string, string> = {
      "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "1D",
    };
    const resolution = resolutions[interval] ?? interval;
    const now = Math.floor(Date.now() / 1000);
    const secondsPerBar = interval.endsWith("m") ? finite(interval.slice(0, -1), 1) * 60
      : interval.endsWith("h") ? finite(interval.slice(0, -1), 1) * 3600
        : 86400;
    const from = now - Math.max(1, limit) * secondsPerBar * 2;
    const url = new URL(`${this.baseUrl}/tradingview/history?symbol=${encodeURIComponent(normalized)}&resolution=${encodeURIComponent(resolution)}&from=${from}&to=${now}`);
    const payload = (await jsonHttpRequest<Record<string, unknown>>(url, { timeoutMs: this.timeoutMs })).data;
    const times = Array.isArray(payload.t) ? payload.t : [];
    const opens = Array.isArray(payload.o) ? payload.o : [];
    const highs = Array.isArray(payload.h) ? payload.h : [];
    const lows = Array.isArray(payload.l) ? payload.l : [];
    const closes = Array.isArray(payload.c) ? payload.c : [];
    const volumes = Array.isArray(payload.v) ? payload.v : [];
    return times.slice(-limit).map((time, indexFromSlice) => {
      const sourceIndex = times.length - Math.min(limit, times.length) + indexFromSlice;
      return {
        time: finite(time) * 1000,
        open: finite(opens[sourceIndex]),
        high: finite(highs[sourceIndex]),
        low: finite(lows[sourceIndex]),
        close: finite(closes[sourceIndex]),
        volume: finite(volumes[sourceIndex]),
      };
    });
  }

  private authHeaders(method: "GET" | "POST", path: string, query = "", body = ""): Record<string, string> {
    const { apiKey, apiSecret } = requiredCredentials("Bitkub", this.credentials.apiKey, this.credentials.apiSecret);
    const timestamp = String(Date.now());
    const suffix = query ? `?${query}` : "";
    const message = `${timestamp} ${method}${path}${suffix}${body}`;
    return {
      "content-type": "application/json",
      "x-btk-apikey": apiKey,
      "x-btk-timestamp": timestamp,
      "x-btk-sign": hmacSha256(apiSecret, message),
    };
  }

  async placeOrder(input: SpotOrderInput): Promise<unknown> {
    const symbol = normalizeCryptoSymbol("bitkub", input.symbol).toLowerCase();
    if (input.type === "LIMIT" && input.price === undefined) throw new Error("Bitkub LIMIT order requires price");
    const amount = input.side === "BUY"
      ? input.quoteQuantity ?? input.quantity
      : input.quantity;
    if (amount === undefined) throw new Error("Bitkub order requires an amount");
    const path = input.side === "BUY" ? "/api/v3/market/place-bid" : "/api/v3/market/place-ask";
    const payload: Record<string, unknown> = {
      sym: symbol,
      amt: amount,
      rat: input.price ?? 0,
      typ: input.type.toLowerCase(),
      ...(input.clientOrderId ? { client_id: input.clientOrderId } : {}),
    };
    const body = JSON.stringify(payload);
    return (await jsonHttpRequest(new URL(`${this.baseUrl}${path}`), {
      method: "POST",
      headers: this.authHeaders("POST", path, "", body),
      body,
      timeoutMs: this.timeoutMs,
    })).data;
  }

  private async getOrderForSide(symbol: string, orderId: string, side: "buy" | "sell"): Promise<unknown> {
    const path = "/api/v3/market/order-info";
    const query = qs({ sym: symbol, id: orderId, sd: side });
    return (await jsonHttpRequest(new URL(`${this.baseUrl}${path}?${query}`), {
      headers: this.authHeaders("GET", path, query),
      timeoutMs: this.timeoutMs,
    })).data;
  }

  async getOrder(input: OrderStatusInput): Promise<unknown> {
    const symbol = normalizeCryptoSymbol("bitkub", input.symbol).toLowerCase();
    const errors: string[] = [];
    for (const side of ["buy", "sell"] as const) {
      try {
        const result = await this.getOrderForSide(symbol, input.orderId, side);
        return { side, result };
      } catch (error) {
        errors.push(`${side}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Bitkub order ${input.orderId} was not found for buy or sell side: ${errors.join(" | ")}`);
  }
}

class XtClient implements ExchangeClient {
  private readonly baseUrl = "https://sapi.xt.com";

  constructor(
    private readonly credentials: { appKey?: string; secretKey?: string },
    private readonly timeoutMs: number,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.credentials.appKey && this.credentials.secretKey);
  }

  async ticker(symbol: string): Promise<unknown> {
    const normalized = normalizeCryptoSymbol("xt", symbol);
    const url = new URL(`${this.baseUrl}/v4/public/ticker/price?symbol=${encodeURIComponent(normalized)}`);
    return (await jsonHttpRequest(url, { timeoutMs: this.timeoutMs })).data;
  }

  async candles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const normalized = normalizeCryptoSymbol("xt", symbol);
    const url = new URL(`${this.baseUrl}/v4/public/kline?symbol=${encodeURIComponent(normalized)}&interval=${encodeURIComponent(interval)}&limit=${Math.min(1000, Math.max(1, limit))}`);
    const payload = (await jsonHttpRequest<Record<string, unknown>>(url, { timeoutMs: this.timeoutMs })).data;
    const rows = Array.isArray(payload.result) ? payload.result : [];
    return rows.map((row) => {
      const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
      return {
        time: finite(item.t),
        open: finite(item.o),
        high: finite(item.h),
        low: finite(item.l),
        close: finite(item.c),
        volume: finite(item.q ?? item.v),
      };
    });
  }

  private signedHeaders(method: string, path: string, query = "", body = ""): Record<string, string> {
    const appKey = this.credentials.appKey;
    const secretKey = this.credentials.secretKey;
    if (!appKey || !secretKey) throw new Error("XT trading credentials are not configured");
    const timestamp = String(Date.now());
    const recvWindow = "5000";
    const baseHeaders = {
      "validate-algorithms": "HmacSHA256",
      "validate-appkey": appKey,
      "validate-recvwindow": recvWindow,
      "validate-timestamp": timestamp,
    };
    const headerPart = Object.entries(baseHeaders)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    const parts = [`#${method.toUpperCase()}`, `#${path}`];
    if (query) parts.push(`#${query}`);
    if (body) parts.push(`#${body}`);
    const signature = hmacSha256(secretKey, `${headerPart}${parts.join("")}`);
    return { ...baseHeaders, "validate-signature": signature, "content-type": "application/json" };
  }

  async placeOrder(input: SpotOrderInput): Promise<unknown> {
    const symbol = normalizeCryptoSymbol("xt", input.symbol);
    if (input.type === "LIMIT" && (input.quantity === undefined || input.price === undefined)) {
      throw new Error("XT LIMIT order requires quantity and price");
    }
    if (input.type === "MARKET" && input.quantity === undefined && input.quoteQuantity === undefined) {
      throw new Error("XT MARKET order requires quantity or quoteQuantity");
    }
    const path = "/v4/order";
    const payload: Record<string, unknown> = {
      symbol,
      side: input.side,
      type: input.type,
      timeInForce: "GTC",
      bizType: "SPOT",
      ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
      ...(input.quoteQuantity !== undefined ? { quoteQty: input.quoteQuantity } : {}),
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.clientOrderId ? { clientOrderId: input.clientOrderId } : {}),
    };
    const body = JSON.stringify(payload);
    return (await jsonHttpRequest(new URL(`${this.baseUrl}${path}`), {
      method: "POST",
      headers: this.signedHeaders("POST", path, "", body),
      body,
      timeoutMs: this.timeoutMs,
    })).data;
  }

  async getOrder(input: OrderStatusInput): Promise<unknown> {
    const path = `/v4/order/${encodeURIComponent(input.orderId)}`;
    return (await jsonHttpRequest(new URL(`${this.baseUrl}${path}`), {
      headers: this.signedHeaders("GET", path),
      timeoutMs: this.timeoutMs,
    })).data;
  }
}

export class CryptoExchangeHub {
  private readonly clients: Record<CryptoExchangeName, ExchangeClient>;

  constructor(options: CryptoExchangeHubOptions) {
    this.clients = {
      binance: new BinanceLikeClient("Binance", "https://api.binance.com", "x-mbx-apikey", options.binance, options.timeoutMs),
      mexc: new BinanceLikeClient("MEXC", "https://api.mexc.com", "x-mexc-apikey", options.mexc, options.timeoutMs),
      bitkub: new BitkubClient(options.bitkub, options.timeoutMs),
      xt: new XtClient(options.xt, options.timeoutMs),
    };
  }

  configured(): Record<CryptoExchangeName, boolean> {
    return {
      binance: this.clients.binance.isConfigured(),
      mexc: this.clients.mexc.isConfigured(),
      bitkub: this.clients.bitkub.isConfigured(),
      xt: this.clients.xt.isConfigured(),
    };
  }

  ticker(exchange: CryptoExchangeName, symbol: string): Promise<unknown> {
    return this.clients[exchange].ticker(symbol);
  }

  candles(exchange: CryptoExchangeName, symbol: string, interval: string, limit: number): Promise<Candle[]> {
    return this.clients[exchange].candles(symbol, interval, limit);
  }

  placeOrder(input: SpotOrderInput): Promise<unknown> {
    return this.clients[input.exchange].placeOrder(input);
  }

  getOrder(input: OrderStatusInput): Promise<unknown> {
    return this.clients[input.exchange].getOrder(input);
  }
}
