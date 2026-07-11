import type { AgentTool } from "../../core/types.js";
import { MarketIntelligenceClient, analyzeCandles, type StockMarket } from "../../connectors/market/MarketIntelligenceClient.js";
import {
  CryptoExchangeHub,
  normalizeCryptoSymbol,
  type CryptoExchangeName,
  type SpotOrderSide,
  type SpotOrderType,
} from "../../connectors/trading/CryptoExchangeHub.js";

const exchanges: CryptoExchangeName[] = ["binance", "mexc", "bitkub", "xt"];
const stockMarkets: StockMarket[] = ["thai", "global"];
const orderSides: SpotOrderSide[] = ["BUY", "SELL"];
const orderTypes: SpotOrderType[] = ["LIMIT", "MARKET"];

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string argument: ${key}`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a finite number`);
  return parsed;
}

function optionalInteger(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseExchange(value: unknown): CryptoExchangeName {
  if (typeof value !== "string" || !exchanges.includes(value as CryptoExchangeName)) {
    throw new Error(`exchange must be one of: ${exchanges.join(", ")}`);
  }
  return value as CryptoExchangeName;
}

function parseStockMarket(value: unknown): StockMarket {
  if (typeof value !== "string" || !stockMarkets.includes(value as StockMarket)) {
    throw new Error(`market must be one of: ${stockMarkets.join(", ")}`);
  }
  return value as StockMarket;
}

function parseSide(value: unknown): SpotOrderSide {
  if (typeof value !== "string") throw new Error("side is required");
  const normalized = value.toUpperCase();
  if (!orderSides.includes(normalized as SpotOrderSide)) throw new Error("side must be BUY or SELL");
  return normalized as SpotOrderSide;
}

function parseOrderType(value: unknown): SpotOrderType {
  if (typeof value !== "string") throw new Error("type is required");
  const normalized = value.toUpperCase();
  if (!orderTypes.includes(normalized as SpotOrderType)) throw new Error("type must be LIMIT or MARKET");
  return normalized as SpotOrderType;
}

function extractTickerPrice(exchange: CryptoExchangeName, payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  if (exchange === "binance" || exchange === "mexc") {
    const price = Number(root.price);
    return Number.isFinite(price) ? price : null;
  }
  if (exchange === "xt") {
    const first = Array.isArray(root.result) ? root.result[0] : undefined;
    const item = first && typeof first === "object" ? first as Record<string, unknown> : {};
    const price = Number(item.p);
    return Number.isFinite(price) ? price : null;
  }
  const result = Array.isArray(root.result) ? root.result[0] : root.result;
  const item = result && typeof result === "object" ? result as Record<string, unknown> : root;
  const price = Number(item.last ?? item.last_price ?? item.price);
  return Number.isFinite(price) ? price : null;
}

export function createMarketTools(exchangesHub: CryptoExchangeHub, market: MarketIntelligenceClient): AgentTool[] {
  return [
    {
      name: "market_get_crypto_price",
      description: "Get the latest crypto spot price from Binance, MEXC, Bitkub, or XT. Use exchange-native data and never invent a price.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          exchange: { type: "string", enum: exchanges },
          symbol: { type: "string", description: "Trading pair such as BTC/USDT, BTCUSDT, or BTC_THB" },
        },
        required: ["exchange", "symbol"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const exchange = parseExchange(args.exchange);
        const symbol = requiredString(args, "symbol");
        const raw = await exchangesHub.ticker(exchange, symbol);
        return {
          exchange,
          symbol: normalizeCryptoSymbol(exchange, symbol),
          price: extractTickerPrice(exchange, raw),
          raw,
          fetchedAt: new Date().toISOString(),
        };
      },
    },
    {
      name: "market_get_crypto_candles",
      description: "Get crypto OHLCV candles from Binance, MEXC, Bitkub, or XT for technical analysis.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          exchange: { type: "string", enum: exchanges },
          symbol: { type: "string" },
          interval: { type: "string", description: "Examples: 1m, 5m, 15m, 1h, 4h, 1d" },
          limit: { type: "number", minimum: 1, maximum: 1000 },
        },
        required: ["exchange", "symbol", "interval"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const exchange = parseExchange(args.exchange);
        const symbol = requiredString(args, "symbol");
        const interval = requiredString(args, "interval");
        const limit = optionalInteger(args, "limit", 200, 1, 1000);
        return {
          exchange,
          symbol: normalizeCryptoSymbol(exchange, symbol),
          interval,
          candles: await exchangesHub.candles(exchange, symbol, interval, limit),
        };
      },
    },
    {
      name: "market_compare_crypto_prices",
      description: "Compare the latest price of the same crypto pair across Binance, MEXC, Bitkub, and XT. Returns partial results when an exchange does not list the pair.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Common pair such as BTC/USDT. Bitkub may require a THB quote such as BTC/THB." },
          selectedExchanges: { type: "array", items: { type: "string", enum: exchanges } },
        },
        required: ["symbol"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const symbol = requiredString(args, "symbol");
        const selected = Array.isArray(args.selectedExchanges)
          ? args.selectedExchanges.map(parseExchange)
          : exchanges;
        const results = await Promise.all(selected.map(async (exchange) => {
          try {
            const raw = await exchangesHub.ticker(exchange, symbol);
            return {
              exchange,
              symbol: normalizeCryptoSymbol(exchange, symbol),
              price: extractTickerPrice(exchange, raw),
              ok: true,
            };
          } catch (error) {
            return {
              exchange,
              symbol,
              price: null,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }));
        const prices = results.map((item) => item.price).filter((price): price is number => typeof price === "number" && Number.isFinite(price));
        return {
          requestedSymbol: symbol,
          results,
          lowest: prices.length ? Math.min(...prices) : null,
          highest: prices.length ? Math.max(...prices) : null,
          spreadPercent: prices.length > 1 && Math.min(...prices) > 0
            ? ((Math.max(...prices) / Math.min(...prices)) - 1) * 100
            : null,
          fetchedAt: new Date().toISOString(),
        };
      },
    },
    {
      name: "market_analyze_crypto",
      description: "Analyze crypto price action using exchange OHLCV data. Calculates returns, SMA20/SMA50, EMA20, RSI14, realized volatility, drawdown, trend, signals, and risk flags.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          exchange: { type: "string", enum: exchanges },
          symbol: { type: "string" },
          interval: { type: "string" },
          limit: { type: "number", minimum: 50, maximum: 1000 },
        },
        required: ["exchange", "symbol", "interval"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const exchange = parseExchange(args.exchange);
        const symbol = requiredString(args, "symbol");
        const interval = requiredString(args, "interval");
        const limit = optionalInteger(args, "limit", 200, 50, 1000);
        const candles = await exchangesHub.candles(exchange, symbol, interval, limit);
        return {
          exchange,
          symbol: normalizeCryptoSymbol(exchange, symbol),
          interval,
          analysis: analyzeCandles(candles),
          latestCandles: candles.slice(-20),
          fetchedAt: new Date().toISOString(),
        };
      },
    },
    {
      name: "market_get_stock_quote",
      description: "Get the latest available quote for a Thai or global stock. Thai symbols automatically use the .BK market suffix when omitted.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Examples: PTT, ADVANC, AAPL, MSFT, NVDA" },
          market: { type: "string", enum: stockMarkets },
        },
        required: ["symbol", "market"],
        additionalProperties: false,
      },
      execute: async (args) => market.stockQuote(requiredString(args, "symbol"), parseStockMarket(args.market)),
    },
    {
      name: "market_get_stock_candles",
      description: "Get historical OHLCV candles for Thai or global stocks.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          market: { type: "string", enum: stockMarkets },
          range: { type: "string", description: "Examples: 1mo, 3mo, 6mo, 1y, 5y" },
          interval: { type: "string", description: "Examples: 1d, 1h, 5m" },
        },
        required: ["symbol", "market"],
        additionalProperties: false,
      },
      execute: async (args) => market.stockCandles(
        requiredString(args, "symbol"),
        parseStockMarket(args.market),
        optionalString(args, "range") ?? "6mo",
        optionalString(args, "interval") ?? "1d",
      ),
    },
    {
      name: "market_analyze_stock",
      description: "Analyze Thai or global stock price action using OHLCV data and technical indicators. This is research support, not a guaranteed prediction.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          market: { type: "string", enum: stockMarkets },
          range: { type: "string" },
          interval: { type: "string" },
        },
        required: ["symbol", "market"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const symbol = requiredString(args, "symbol");
        const stockMarket = parseStockMarket(args.market);
        const range = optionalString(args, "range") ?? "1y";
        const interval = optionalString(args, "interval") ?? "1d";
        const candles = await market.stockCandles(symbol, stockMarket, range, interval);
        return {
          symbol,
          market: stockMarket,
          range,
          interval,
          analysis: analyzeCandles(candles),
          latestCandles: candles.slice(-20),
          fetchedAt: new Date().toISOString(),
        };
      },
    },
    {
      name: "market_get_news",
      description: "Search current stock, company, macro, or crypto news through a news RSS source and return title, source, timestamp, description, and link.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Examples: PTT earnings, NVDA AI chips, Bitcoin ETF, Ethereum upgrade" },
          limit: { type: "number", minimum: 1, maximum: 50 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args) => market.news(
        requiredString(args, "query"),
        optionalInteger(args, "limit", 10, 1, 50),
      ),
    },
    {
      name: "market_get_financials",
      description: "Get annual financial statement time series for Thai or global stocks, including revenue, profit, EPS, assets, debt, equity, operating cash flow, and free cash flow when available.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          market: { type: "string", enum: stockMarkets },
          years: { type: "number", minimum: 1, maximum: 10 },
        },
        required: ["symbol", "market"],
        additionalProperties: false,
      },
      execute: async (args) => market.financials(
        requiredString(args, "symbol"),
        parseStockMarket(args.market),
        optionalInteger(args, "years", 5, 1, 10),
      ),
    },
    {
      name: "market_build_stock_research_pack",
      description: "Build a structured stock research pack combining quote, 1-year candles, technical analysis, financial statement time series, and current news for a Thai or global stock.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          market: { type: "string", enum: stockMarkets },
          newsLimit: { type: "number", minimum: 1, maximum: 30 },
          years: { type: "number", minimum: 1, maximum: 10 },
        },
        required: ["symbol", "market"],
        additionalProperties: false,
      },
      execute: async (args) => market.stockResearchPack({
        symbol: requiredString(args, "symbol"),
        market: parseStockMarket(args.market),
        newsLimit: optionalInteger(args, "newsLimit", 10, 1, 30),
        years: optionalInteger(args, "years", 5, 1, 10),
      }),
    },
    {
      name: "market_build_crypto_research_pack",
      description: "Build a crypto research pack from one exchange with latest price, OHLCV, technical analysis, and current news. Use this before giving a substantive market view.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          exchange: { type: "string", enum: exchanges },
          symbol: { type: "string" },
          interval: { type: "string" },
          limit: { type: "number", minimum: 50, maximum: 1000 },
          newsLimit: { type: "number", minimum: 1, maximum: 30 },
        },
        required: ["exchange", "symbol"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const exchange = parseExchange(args.exchange);
        const symbol = requiredString(args, "symbol");
        const interval = optionalString(args, "interval") ?? "1h";
        const limit = optionalInteger(args, "limit", 200, 50, 1000);
        const normalized = normalizeCryptoSymbol(exchange, symbol);
        const [ticker, candles, news] = await Promise.all([
          exchangesHub.ticker(exchange, symbol),
          exchangesHub.candles(exchange, symbol, interval, limit),
          market.news(`${symbol} crypto cryptocurrency`, optionalInteger(args, "newsLimit", 10, 1, 30)),
        ]);
        return {
          exchange,
          symbol: normalized,
          price: extractTickerPrice(exchange, ticker),
          ticker,
          interval,
          technicalAnalysis: analyzeCandles(candles),
          latestCandles: candles.slice(-50),
          news,
          generatedAt: new Date().toISOString(),
          note: "Research data only. Future returns are uncertain and trading can result in losses.",
        };
      },
    },
    {
      name: "trade_place_spot_order",
      description: "Place a real spot order on Binance, MEXC, Bitkub, or XT. This moves real money and must require dangerous approval. Never claim completion until trade_get_order_status verifies the resulting order state.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          exchange: { type: "string", enum: exchanges },
          symbol: { type: "string" },
          side: { type: "string", enum: orderSides },
          type: { type: "string", enum: orderTypes },
          quantity: { type: "number", exclusiveMinimum: 0 },
          quoteQuantity: { type: "number", exclusiveMinimum: 0 },
          price: { type: "number", exclusiveMinimum: 0 },
          clientOrderId: { type: "string" },
        },
        required: ["exchange", "symbol", "side", "type"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const quantity = optionalNumber(args, "quantity");
        const quoteQuantity = optionalNumber(args, "quoteQuantity");
        const price = optionalNumber(args, "price");
        const clientOrderId = optionalString(args, "clientOrderId");
        return exchangesHub.placeOrder({
          exchange: parseExchange(args.exchange),
          symbol: requiredString(args, "symbol"),
          side: parseSide(args.side),
          type: parseOrderType(args.type),
          ...(quantity !== undefined ? { quantity } : {}),
          ...(quoteQuantity !== undefined ? { quoteQuantity } : {}),
          ...(price !== undefined ? { price } : {}),
          ...(clientOrderId ? { clientOrderId } : {}),
        });
      },
    },
    {
      name: "trade_get_order_status",
      description: "Query a real spot order after placement and use the returned exchange status as verification evidence before reporting success or fill status.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          exchange: { type: "string", enum: exchanges },
          symbol: { type: "string" },
          orderId: { type: "string" },
        },
        required: ["exchange", "symbol", "orderId"],
        additionalProperties: false,
      },
      execute: async (args) => exchangesHub.getOrder({
        exchange: parseExchange(args.exchange),
        symbol: requiredString(args, "symbol"),
        orderId: requiredString(args, "orderId"),
      }),
    },
  ];
}
