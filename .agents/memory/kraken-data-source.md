---
name: Kraken data source
description: Market data source decision — why Kraken, how it's structured, symbol format
---

## Decision: Kraken Public API (no key required)

NEXUS uses Kraken as its sole market data source after CoinGecko (429 rate limits) and Binance (451 geo-block) failed.

**Why Kraken:**
- Public REST + WebSocket v2, zero auth required
- Not geo-blocked in Replit's environment
- Real OHLCV candles via `/0/public/OHLC`
- Real-time ticks via `wss://ws.kraken.com/v2` (ticker channel)

**Symbol format in NEXUS:**
- Frontend + DB uses `BTC-USDT` format (dash-separated)
- Kraken REST uses `XBTUSD`, `ETHUSD`, etc. (internal names mapped in `market-data.ts`)
- Kraken WS v2 publishes `BTC/USD` format — mapped back to `BTC-USDT` in `lib/websocket.ts`
- Alpaca uses `BTC/USD` format — `lib/alpaca.ts` converts from `BTC-USDT`

**13 active pairs:** BTC, ETH, SOL, XRP, ADA, DOGE, AVAX, LINK, DOT, UNI, LTC, ATOM, FIL
(BNB and MATIC dropped — unreliable on Kraken)

**DOGE ohlcPair:** Uses Kraken internal name `XDGUSD` — verify if it ever returns no data.

**Ticker vs OHLC pair names differ — this bites.** `/0/public/OHLC` and `/0/public/Ticker`
do not accept the same names: OHLC needs `XLTCUSD`, while Ticker rejects it with
`EQuery:Unknown asset pair` and needs `LTCUSD`. Worse, one bad pair fails the whole
multi-pair Ticker request. `refreshTickersFromRest()` therefore asks Ticker with
`tickerPair()` (leading `X` stripped for 3-letter bases) and retries pair by pair if
the batch is rejected.

**Ticker response keys are Kraken codes, not the pair you asked for:** `XBTUSD`→`XXBTZUSD`,
`ETHUSD`→`XETHZUSD`, `XRPUSD`→`XXRPZUSD`, `LTCUSD`→`XLTCZUSD`, `DOGEUSD`→`XDGUSD`.
Rows are matched with `krakenKeyBase()` (strip the `ZUSD`/`USD` quote, drop a leading `X`,
map `XBT`→`BTC` and `XDG`→`DOGE`) — suffix matching against the requested pair does not work.

**No fake prices:** the cache is never seeded with placeholder values. If neither the WS
nor the REST snapshot has produced a quote, `getTicker()` returns `null` and the order
paths refuse the fill instead of booking it at an invented price.

**How to apply:**
- Any new market addition must map its Kraken internal symbol name in `lib/market-data.ts`
- Default symbol in market page is `BTC-USDT` (not `BTC/USD`)
