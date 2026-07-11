# CherryAgent Trading + Market Intelligence

CherryAgent can act as a multi-market research and execution agent across crypto exchanges, Thai stocks, global stocks, news, financial statements, and technical analysis.

The design separates **read-only research** from **real-money execution**:

```text
Market data / News / Financials / Analysis
                    |
                    v
               safe tools
                    |
                    v
             Research answer
                    |
                    v
        Independent Correctness Loop

Real-money order request
                    |
                    v
          trade_place_spot_order
                    |
                    v
             dangerous risk
                    |
                    v
             Approval Inbox
                    |
                    v
              Exchange API
                    |
                    v
          trade_get_order_status
                    |
                    v
           Verified final status
```

## Supported crypto exchanges

- Binance Spot
- MEXC Spot
- Bitkub
- XT Spot

Public market-data tools work without API credentials. Real trading requires exchange credentials.

## Crypto market tools

- `market_get_crypto_price`
- `market_get_crypto_candles`
- `market_compare_crypto_prices`
- `market_analyze_crypto`
- `market_build_crypto_research_pack`

The analysis layer calculates:

- latest price
- 1 / 5 / 20-period returns
- SMA20
- SMA50
- EMA20
- RSI14
- realized volatility
- recent 20-period high and low
- maximum drawdown
- trend classification
- signals
- explicit risk flags

## Thai and global stock tools

- `market_get_stock_quote`
- `market_get_stock_candles`
- `market_analyze_stock`
- `market_get_financials`
- `market_build_stock_research_pack`

Thai stock symbols automatically receive the `.BK` suffix when `market=thai` and the user supplies a plain symbol such as `PTT`, `ADVANC`, or `KBANK`.

Examples:

```text
PTT + market=thai     -> PTT.BK
ADVANC + market=thai  -> ADVANC.BK
AAPL + market=global  -> AAPL
NVDA + market=global  -> NVDA
```

The current stock market-data adapter uses Yahoo Finance-compatible chart and fundamentals timeseries endpoints. These are useful for broad market coverage but are not a contractual exchange feed and may change or be delayed. Production deployments that require licensed real-time or guaranteed market data should add a licensed provider adapter.

## News

`market_get_news` searches stock, company, macro, and cryptocurrency news through a Google News RSS feed and returns:

- title
- source
- publication time
- description
- link

The model should read multiple articles, distinguish reported facts from interpretation, note publication dates, and avoid treating a single headline as confirmed truth.

## Financial statements

`market_get_financials` requests annual time series when available for:

- total revenue
- gross profit
- operating income
- net income
- diluted EPS
- total assets
- total debt
- stockholders' equity
- operating cash flow
- free cash flow

`market_build_stock_research_pack` combines quote, one-year candles, technical analysis, financial statement time series, and current news in one structured tool result.

The model should analyze growth, margins, leverage, cash generation, valuation context, trend, catalysts, and risks without pretending that missing statement fields are zero.

## Trading tools

### Place a real order

`trade_place_spot_order`

Supported inputs:

- exchange: `binance | mexc | bitkub | xt`
- symbol
- side: `BUY | SELL`
- type: `LIMIT | MARKET`
- quantity
- quoteQuantity
- price
- clientOrderId

Risk level:

```text
dangerous
```

With the recommended default:

```env
CHERRY_AUTO_APPROVE=safe,write
```

real trading orders enter the Approval Inbox and do not execute automatically.

### Verify an order

`trade_get_order_status`

A successful order submission is not proof that the order filled. Cherry must query the order after submission and report the actual exchange state such as new, partially filled, filled, canceled, rejected, or expired when supplied by the exchange.

## Exchange-specific implementation

### Binance

- public ticker and kline endpoints
- HMAC SHA-256 signed Spot order endpoint
- signed order-status query

### MEXC

- public ticker and kline endpoints
- HMAC SHA-256 signed Spot order endpoint
- signed order-status query

### Bitkub

- V3 market ticker
- TradingView-compatible historical candles
- V3 signed place-bid / place-ask
- V3 signed order-info query

### XT

- V4 public ticker
- V4 public kline
- V4 HmacSHA256 request signature
- V4 order submission
- V4 single-order query

## Environment configuration

```env
CHERRY_MARKET_TIMEOUT_MS=20000
CHERRY_MARKET_NEWS_LANGUAGE=th
CHERRY_MARKET_NEWS_COUNTRY=TH

CHERRY_BINANCE_API_KEY=
CHERRY_BINANCE_API_SECRET=

CHERRY_MEXC_API_KEY=
CHERRY_MEXC_API_SECRET=

CHERRY_BITKUB_API_KEY=
CHERRY_BITKUB_API_SECRET=

CHERRY_XT_APP_KEY=
CHERRY_XT_SECRET_KEY=
```

Do not commit real credentials to Git.

## Recommended agent behavior

For a request such as:

```text
วิเคราะห์ BTC ตอนนี้จาก Binance พร้อมข่าวล่าสุด
```

Expected tool pattern:

```text
market_build_crypto_research_pack
        |
        v
latest price + candles + RSI/SMA/volatility + news
        |
        v
model analysis
        |
        v
Correctness Loop
        |
        v
final answer with uncertainty and evidence
```

For a stock request:

```text
วิเคราะห์ PTT ทั้งราคา ข่าว และงบ 5 ปี
```

Expected tool pattern:

```text
market_build_stock_research_pack
        |
        v
quote + 1y candles + technical analysis + 5y financials + news
        |
        v
model compares growth / profitability / debt / cash flow / trend / catalysts / risks
        |
        v
Correctness Loop
```

For a real trade:

```text
ซื้อ BTC/USDT 100 USDT ที่ Binance แบบ market
```

Expected tool pattern:

```text
market_get_crypto_price
        |
        v
sanity check symbol / market state
        |
        v
trade_place_spot_order
        |
        v
Approval Inbox
        |
        v
exchange accepts order
        |
        v
trade_get_order_status
        |
        v
verified fill state
        |
        v
final answer
```

## Important limitations

- Market prices may be delayed depending on the upstream provider or exchange endpoint.
- News feeds can contain duplicate, misleading, or low-quality headlines; the model should corroborate important claims.
- Financial-statement coverage varies by symbol and provider.
- Technical indicators describe past price behavior and do not guarantee future performance.
- Exchange APIs can change symbol rules, rate limits, authentication requirements, and order semantics.
- Real-money orders should stay behind human approval unless the operator deliberately changes risk policy after testing.
