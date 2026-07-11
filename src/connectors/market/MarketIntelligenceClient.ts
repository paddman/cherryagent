import { jsonHttpRequest } from "../infra/httpJson.js";
import type { Candle } from "../trading/CryptoExchangeHub.js";

export type StockMarket = "thai" | "global";

export type MarketAnalysis = {
  points: number;
  lastPrice: number;
  return1: number | null;
  return5: number | null;
  return20: number | null;
  sma20: number | null;
  sma50: number | null;
  ema20: number | null;
  rsi14: number | null;
  realizedVolatility20: number | null;
  recentHigh20: number | null;
  recentLow20: number | null;
  maxDrawdown: number | null;
  trend: "bullish" | "bearish" | "mixed" | "insufficient_data";
  signals: string[];
  riskFlags: string[];
};

export type MarketIntelligenceOptions = {
  timeoutMs: number;
  newsLanguage?: string;
  newsCountry?: string;
};

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableFinite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentReturn(current: number, previous: number | undefined): number | null {
  if (previous === undefined || previous === 0) return null;
  return ((current / previous) - 1) * 100;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const seed = average(values.slice(0, period));
  if (seed === null) return null;
  const multiplier = 2 / (period + 1);
  let output = seed;
  for (const value of values.slice(period)) output = (value - output) * multiplier + output;
  return output;
}

function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]!);
  const recent = changes.slice(-period);
  const gains = recent.map((value) => Math.max(0, value));
  const losses = recent.map((value) => Math.max(0, -value));
  const avgGain = average(gains) ?? 0;
  const avgLoss = average(losses) ?? 0;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function standardDeviation(values: number[]): number | null {
  const mean = average(values);
  if (mean === null || values.length < 2) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function maxDrawdown(values: number[]): number | null {
  if (!values.length) return null;
  let peak = values[0]!;
  let worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.min(worst, (value / peak) - 1);
  }
  return worst * 100;
}

export function analyzeCandles(candles: Candle[]): MarketAnalysis {
  const clean = candles.filter((item) => Number.isFinite(item.close) && item.close > 0);
  const closes = clean.map((item) => item.close);
  const lastPrice = closes.at(-1) ?? 0;
  if (!closes.length) {
    return {
      points: 0,
      lastPrice: 0,
      return1: null,
      return5: null,
      return20: null,
      sma20: null,
      sma50: null,
      ema20: null,
      rsi14: null,
      realizedVolatility20: null,
      recentHigh20: null,
      recentLow20: null,
      maxDrawdown: null,
      trend: "insufficient_data",
      signals: [],
      riskFlags: ["No valid candles were available."],
    };
  }

  const sma20 = average(closes.slice(-20));
  const sma50 = closes.length >= 50 ? average(closes.slice(-50)) : null;
  const ema20 = ema(closes, 20);
  const rsi14 = rsi(closes, 14);
  const returns = closes.slice(1).map((value, index) => Math.log(value / closes[index]!));
  const recentReturns = returns.slice(-20);
  const dailyVol = standardDeviation(recentReturns);
  const volatility = dailyVol === null ? null : dailyVol * Math.sqrt(365) * 100;
  const recent20 = closes.slice(-20);
  const recentHigh20 = recent20.length ? Math.max(...recent20) : null;
  const recentLow20 = recent20.length ? Math.min(...recent20) : null;
  const return1 = percentReturn(lastPrice, closes.at(-2));
  const return5 = percentReturn(lastPrice, closes.at(-6));
  const return20 = percentReturn(lastPrice, closes.at(-21));
  const drawdown = maxDrawdown(closes.slice(-100));

  const signals: string[] = [];
  const riskFlags: string[] = [];
  let bull = 0;
  let bear = 0;

  if (sma20 !== null) {
    if (lastPrice > sma20) {
      bull += 1;
      signals.push("Price is above SMA20.");
    } else {
      bear += 1;
      signals.push("Price is below SMA20.");
    }
  }
  if (sma20 !== null && sma50 !== null) {
    if (sma20 > sma50) {
      bull += 1;
      signals.push("SMA20 is above SMA50.");
    } else {
      bear += 1;
      signals.push("SMA20 is below SMA50.");
    }
  }
  if (rsi14 !== null) {
    if (rsi14 >= 70) riskFlags.push(`RSI14 is overbought at ${rsi14.toFixed(1)}.`);
    else if (rsi14 <= 30) riskFlags.push(`RSI14 is oversold at ${rsi14.toFixed(1)}.`);
    else signals.push(`RSI14 is neutral at ${rsi14.toFixed(1)}.`);
  }
  if (volatility !== null && volatility > 100) riskFlags.push(`Annualized realized volatility is very high at ${volatility.toFixed(1)}%.`);
  if (drawdown !== null && drawdown < -20) riskFlags.push(`Recent maximum drawdown is ${drawdown.toFixed(1)}%.`);

  const trend = closes.length < 20
    ? "insufficient_data"
    : bull > bear
      ? "bullish"
      : bear > bull
        ? "bearish"
        : "mixed";

  return {
    points: closes.length,
    lastPrice,
    return1,
    return5,
    return20,
    sma20,
    sma50,
    ema20,
    rsi14,
    realizedVolatility20: volatility,
    recentHigh20,
    recentLow20,
    maxDrawdown: drawdown,
    trend,
    signals,
    riskFlags,
  };
}

function normalizeStockSymbol(symbol: string, market: StockMarket): string {
  const cleaned = symbol.trim().toUpperCase();
  if (!cleaned) throw new Error("Stock symbol is required");
  if (market === "thai" && !cleaned.includes(".")) return `${cleaned}.BK`;
  return cleaned;
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function xmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ? decodeEntities(match[1].trim()) : "";
}

function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function yahooChartToCandles(payload: unknown): Candle[] {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const chart = root.chart && typeof root.chart === "object" ? root.chart as Record<string, unknown> : {};
  const result = Array.isArray(chart.result) ? chart.result[0] : undefined;
  const resultObj = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const timestamps = Array.isArray(resultObj.timestamp) ? resultObj.timestamp : [];
  const indicators = resultObj.indicators && typeof resultObj.indicators === "object"
    ? resultObj.indicators as Record<string, unknown>
    : {};
  const quotes = Array.isArray(indicators.quote) ? indicators.quote[0] : undefined;
  const quote = quotes && typeof quotes === "object" ? quotes as Record<string, unknown> : {};
  const opens = Array.isArray(quote.open) ? quote.open : [];
  const highs = Array.isArray(quote.high) ? quote.high : [];
  const lows = Array.isArray(quote.low) ? quote.low : [];
  const closes = Array.isArray(quote.close) ? quote.close : [];
  const volumes = Array.isArray(quote.volume) ? quote.volume : [];
  return timestamps.map((time, index) => ({
    time: finite(time) * 1000,
    open: finite(opens[index]),
    high: finite(highs[index]),
    low: finite(lows[index]),
    close: finite(closes[index]),
    volume: finite(volumes[index]),
  })).filter((item) => item.close > 0);
}

export class MarketIntelligenceClient {
  private readonly timeoutMs: number;
  private readonly newsLanguage: string;
  private readonly newsCountry: string;

  constructor(options: MarketIntelligenceOptions) {
    this.timeoutMs = Math.max(1_000, options.timeoutMs);
    this.newsLanguage = options.newsLanguage ?? "th";
    this.newsCountry = options.newsCountry ?? "TH";
  }

  async stockQuote(symbol: string, market: StockMarket): Promise<unknown> {
    const normalized = normalizeStockSymbol(symbol, market);
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}?range=5d&interval=1d&includePrePost=false`);
    const payload = (await jsonHttpRequest<Record<string, unknown>>(url, { timeoutMs: this.timeoutMs })).data;
    const chart = payload.chart && typeof payload.chart === "object" ? payload.chart as Record<string, unknown> : {};
    const result = Array.isArray(chart.result) ? chart.result[0] : undefined;
    const item = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const meta = item.meta && typeof item.meta === "object" ? item.meta as Record<string, unknown> : {};
    const candles = yahooChartToCandles(payload);
    const latest = candles.at(-1);
    const previous = candles.at(-2);
    return {
      symbol: normalized,
      market,
      exchange: meta.exchangeName ?? meta.fullExchangeName ?? null,
      currency: meta.currency ?? null,
      timezone: meta.exchangeTimezoneName ?? null,
      price: nullableFinite(meta.regularMarketPrice) ?? latest?.close ?? null,
      previousClose: nullableFinite(meta.chartPreviousClose) ?? previous?.close ?? null,
      changePercent: latest && previous ? percentReturn(latest.close, previous.close) : null,
      marketState: meta.marketState ?? null,
      timestamp: latest?.time ?? null,
      source: "Yahoo Finance-compatible chart endpoint",
    };
  }

  async stockCandles(symbol: string, market: StockMarket, range = "6mo", interval = "1d"): Promise<Candle[]> {
    const normalized = normalizeStockSymbol(symbol, market);
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`);
    const payload = (await jsonHttpRequest(url, { timeoutMs: this.timeoutMs })).data;
    return yahooChartToCandles(payload);
  }

  async financials(symbol: string, market: StockMarket, years = 5): Promise<unknown> {
    const normalized = normalizeStockSymbol(symbol, market);
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - Math.max(1, years + 1) * 366 * 24 * 60 * 60;
    const types = [
      "annualTotalRevenue",
      "annualGrossProfit",
      "annualOperatingIncome",
      "annualNetIncome",
      "annualDilutedEPS",
      "annualTotalAssets",
      "annualTotalDebt",
      "annualStockholdersEquity",
      "annualOperatingCashFlow",
      "annualFreeCashFlow",
    ].join(",");
    const url = new URL(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(normalized)}?symbol=${encodeURIComponent(normalized)}&type=${types}&period1=${period1}&period2=${period2}`);
    const payload = (await jsonHttpRequest<Record<string, unknown>>(url, { timeoutMs: this.timeoutMs })).data;
    const timeseries = payload.timeseries && typeof payload.timeseries === "object"
      ? payload.timeseries as Record<string, unknown>
      : {};
    const result = Array.isArray(timeseries.result) ? timeseries.result : [];
    return {
      symbol: normalized,
      market,
      years,
      statements: result,
      source: "Yahoo Finance-compatible fundamentals timeseries endpoint",
    };
  }

  async news(query: string, limit = 10): Promise<Array<{ title: string; link: string; publishedAt: string; source: string; description: string }>> {
    const q = query.trim();
    if (!q) throw new Error("News query is required");
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", q);
    url.searchParams.set("hl", this.newsLanguage);
    url.searchParams.set("gl", this.newsCountry);
    url.searchParams.set("ceid", `${this.newsCountry}:${this.newsLanguage}`);
    const payload = (await jsonHttpRequest<string>(url, {
      headers: { accept: "application/rss+xml, application/xml, text/xml" },
      timeoutMs: this.timeoutMs,
    })).data;
    if (typeof payload !== "string") throw new Error("News RSS response was not text");
    const items = payload.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
    return items.slice(0, Math.min(50, Math.max(1, limit))).map((item) => ({
      title: stripHtml(xmlTag(item, "title")),
      link: xmlTag(item, "link"),
      publishedAt: xmlTag(item, "pubDate"),
      source: stripHtml(xmlTag(item, "source")),
      description: stripHtml(xmlTag(item, "description")),
    }));
  }

  async stockResearchPack(input: {
    symbol: string;
    market: StockMarket;
    newsLimit?: number;
    years?: number;
  }): Promise<unknown> {
    const normalized = normalizeStockSymbol(input.symbol, input.market);
    const [quote, candles, financials, news] = await Promise.all([
      this.stockQuote(input.symbol, input.market),
      this.stockCandles(input.symbol, input.market, "1y", "1d"),
      this.financials(input.symbol, input.market, input.years ?? 5).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
      this.news(`${normalized} หุ้น OR stock`, input.newsLimit ?? 10),
    ]);
    return {
      symbol: normalized,
      market: input.market,
      quote,
      technicalAnalysis: analyzeCandles(candles),
      candles: candles.slice(-120),
      financials,
      news,
      generatedAt: new Date().toISOString(),
      note: "This is structured research data, not a guarantee of future performance or investment advice.",
    };
  }
}
