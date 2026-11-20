// Explicit extension so Node's type stripping can import this module directly
// (same convention as rule-draft.ts and execution-gateway.ts).
import { logger } from "./logger.ts";

// Real market data via Kraken public API (no key required, no geo-blocking)
const KRAKEN_BASE = "https://api.kraken.com/0/public";

export const SUPPORTED_MARKETS = [
  { symbol: "BTC-USDT",  name: "Bitcoin",   exchange: "Kraken", type: "crypto", wsSymbol: "BTC/USD",  ohlcPair: "XBTUSD"  },
  { symbol: "ETH-USDT",  name: "Ethereum",  exchange: "Kraken", type: "crypto", wsSymbol: "ETH/USD",  ohlcPair: "ETHUSD"  },
  { symbol: "SOL-USDT",  name: "Solana",    exchange: "Kraken", type: "crypto", wsSymbol: "SOL/USD",  ohlcPair: "SOLUSD"  },
  { symbol: "XRP-USDT",  name: "XRP",       exchange: "Kraken", type: "crypto", wsSymbol: "XRP/USD",  ohlcPair: "XRPUSD"  },
  { symbol: "ADA-USDT",  name: "Cardano",   exchange: "Kraken", type: "crypto", wsSymbol: "ADA/USD",  ohlcPair: "ADAUSD"  },
  { symbol: "DOGE-USDT", name: "Dogecoin",  exchange: "Kraken", type: "crypto", wsSymbol: "DOGE/USD", ohlcPair: "XDGUSD"  },
  { symbol: "AVAX-USDT", name: "Avalanche", exchange: "Kraken", type: "crypto", wsSymbol: "AVAX/USD", ohlcPair: "AVAXUSD" },
  { symbol: "LINK-USDT", name: "Chainlink", exchange: "Kraken", type: "crypto", wsSymbol: "LINK/USD", ohlcPair: "LINKUSD" },
  { symbol: "DOT-USDT",  name: "Polkadot",  exchange: "Kraken", type: "crypto", wsSymbol: "DOT/USD",  ohlcPair: "DOTUSD"  },
  { symbol: "UNI-USDT",  name: "Uniswap",   exchange: "Kraken", type: "crypto", wsSymbol: "UNI/USD",  ohlcPair: "UNIUSD"  },
  { symbol: "LTC-USDT",  name: "Litecoin",  exchange: "Kraken", type: "crypto", wsSymbol: "LTC/USD",  ohlcPair: "XLTCUSD" },
  { symbol: "ATOM-USDT", name: "Cosmos",    exchange: "Kraken", type: "crypto", wsSymbol: "ATOM/USD", ohlcPair: "ATOMUSD" },
  { symbol: "FIL-USDT",  name: "Filecoin",  exchange: "Kraken", type: "crypto", wsSymbol: "FIL/USD",  ohlcPair: "FILUSD"  },
];

const WS_SYMBOL_TO_OURS = new Map(
  SUPPORTED_MARKETS.map(m => [m.wsSymbol, m.symbol])
);
const SYMBOL_TO_MARKET = new Map(SUPPORTED_MARKETS.map(m => [m.symbol, m]));

export interface TickerData {
  symbol: string;
  price: number;
  change24h: number;
  changePct24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  marketCap: number | null;
  updatedAt: string;
}

// Shared ticker cache — filled by the Kraken WS stream, reconciled against the
// Kraken REST snapshot. It is never filled with invented prices: a price here
// always came from the exchange, and `updatedAt` says how fresh it is.
export const tickerCache: Map<string, TickerData> = new Map();

/** Called by websocket.ts Kraken stream to push live prices into the shared cache. */
export function updateTickerFromStream(data: TickerData): void {
  tickerCache.set(data.symbol, data);
}

/** Convert Kraken WS symbol (BTC/USD) to our symbol (BTC-USDT). */
export function fromKrakenWsSymbol(ws: string): string | undefined {
  return WS_SYMBOL_TO_OURS.get(ws);
}

/** A ticker older than this is no longer "live" and gets refetched from REST. */
const STALE_AFTER_MS = 15_000;

let lastRestFetchAt = 0;
let restInFlight: Promise<boolean> | null = null;

function newestTickerAge(now = Date.now()): number {
  let newest = 0;
  for (const ticker of tickerCache.values()) {
    const at = Date.parse(ticker.updatedAt);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest === 0 ? Number.POSITIVE_INFINITY : now - newest;
}

/** True when the cache cannot be trusted as a live quote. */
export function tickersAreStale(now = Date.now()): boolean {
  if (tickerCache.size < SUPPORTED_MARKETS.length) return true;
  return newestTickerAge(now) > STALE_AFTER_MS;
}

type KrakenTickerRow = {
  c?: string[]; o?: string; h?: string[]; l?: string[]; v?: string[];
};
type KrakenTickerResult = Record<string, KrakenTickerRow>;

async function fetchKrakenTickers(pairs: string): Promise<KrakenTickerResult | null> {
  try {
    const res = await fetch(`${KRAKEN_BASE}/Ticker?pair=${pairs}`, {
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, pairs }, "Kraken REST ticker request failed");
      return null;
    }

    const json = await res.json() as { error?: string[]; result?: KrakenTickerResult };
    if (json.error?.length || !json.result) {
      logger.warn({ error: json.error, pairs }, "Kraken REST ticker rejected the request");
      return null;
    }
    return json.result;
  } catch (err) {
    logger.warn({ err, pairs }, "Kraken REST ticker fetch failed");
    return null;
  }
}

const KRAKEN_BASE_ALIASES: Record<string, string> = { XBT: "BTC", XDG: "DOGE" };

/**
 * Kraken's Ticker reply keys its rows by its own asset codes: XBTUSD comes back
 * as XXBTZUSD, ETHUSD as XETHZUSD, LTCUSD as XLTCZUSD, DOGEUSD as XDGUSD.
 * Normalise the base symbol so a row can be matched to our market list.
 */
function krakenKeyBase(key: string): string {
  let base = key.endsWith("ZUSD") ? key.slice(0, -4) : key.endsWith("USD") ? key.slice(0, -3) : key;
  if (base.length === 4 && base.startsWith("X")) base = base.slice(1);
  return KRAKEN_BASE_ALIASES[base] ?? base;
}

function pickKrakenRow(
  result: KrakenTickerResult,
  market: (typeof SUPPORTED_MARKETS)[number],
): KrakenTickerRow | null {
  const wanted = market.symbol.split("-")[0];
  const key = Object.keys(result).find(candidate => krakenKeyBase(candidate) === wanted);
  return key ? result[key] : null;
}

/**
 * The Ticker endpoint rejects a few OHLC-only names (XLTCUSD), so ask with the
 * plain asset code there even though OHLC needs the legacy name.
 */
function tickerPair(market: (typeof SUPPORTED_MARKETS)[number]): string {
  return market.ohlcPair.replace(/^X(?=[A-Z]{3}USD$)/, "");
}

/** Write one exchange row into the shared cache. False when the row is unusable. */
function applyKrakenRow(
  market: (typeof SUPPORTED_MARKETS)[number],
  row: KrakenTickerRow,
  updatedAt: string,
): boolean {
  const last = Number(row?.c?.[0]);
  if (!Number.isFinite(last) || last <= 0) return false;

  const open = Number(row?.o);
  const change24h = Number.isFinite(open) ? last - open : 0;
  updateTickerFromStream({
    symbol:       market.symbol,
    price:        last,
    change24h:    +change24h.toFixed(8),
    changePct24h: Number.isFinite(open) && open > 0 ? +((change24h / open) * 100).toFixed(4) : 0,
    volume24h:    Number(row?.v?.[1]) || 0,
    high24h:      Number(row?.h?.[1]) || last,
    low24h:       Number(row?.l?.[1]) || last,
    marketCap:    null,
    updatedAt,
  });
  return true;
}

/**
 * Fetch one real snapshot of every supported pair from Kraken's public REST
 * ticker endpoint and write it into the shared cache.
 *
 * This is the safety net behind the WebSocket: after a cold start, or if the
 * stream drops or is blocked, prices still come from the exchange instead of
 * falling back to placeholders. Concurrent callers share one request.
 */
export function refreshTickersFromRest(): Promise<boolean> {
  if (restInFlight) return restInFlight;

  const task = (async (): Promise<boolean> => {
    try {
      const updatedAt = new Date().toISOString();
      const priced = new Set<string>();
      let applied = 0;

      // Fast path: one request covers every pair.
      const batchPairs = [...new Set(SUPPORTED_MARKETS.map(tickerPair))];
      const batch = await fetchKrakenTickers(batchPairs.join(","));
      if (batch) {
        for (const market of SUPPORTED_MARKETS) {
          const row = pickKrakenRow(batch, market);
          if (row && applyKrakenRow(market, row, updatedAt)) {
            priced.add(market.symbol);
            applied += 1;
          }
        }
      }

      // One unknown pair makes Kraken reject the whole batch, so retry whatever is
      // still missing pair by pair instead of losing every quote.
      if (priced.size < SUPPORTED_MARKETS.length) {
        for (const market of SUPPORTED_MARKETS) {
          if (priced.has(market.symbol)) continue;
          for (const pair of new Set([tickerPair(market), market.ohlcPair])) {
            const result = await fetchKrakenTickers(pair);
            const row = result ? pickKrakenRow(result, market) : null;
            if (row && applyKrakenRow(market, row, updatedAt)) {
              priced.add(market.symbol);
              applied += 1;
              break;
            }
          }
        }
      }

      if (applied > 0) {
        lastRestFetchAt = Date.now();
        logger.info({ applied, requested: SUPPORTED_MARKETS.length }, "Kraken REST ticker snapshot refreshed");
      }
      return applied > 0;
    } catch (err) {
      logger.warn({ err }, "Kraken REST ticker fetch failed");
      return false;
    } finally {
      restInFlight = null;
    }
  })();

  restInFlight = task;
  return task;
}

/**
 * Keep the cache honest without a request in flight: if nothing has arrived
 * from the stream for a while, poll the REST snapshot until it recovers.
 */
export function startTickerWatchdog(intervalMs = 15_000): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    if (tickersAreStale()) void refreshTickersFromRest();
  }, intervalMs);
  // Never keep the process (or a test harness) alive for this.
  timer.unref?.();
  return timer;
}

export async function getTickers(): Promise<Map<string, TickerData>> {
  if (tickersAreStale()) await refreshTickersFromRest();
  return tickerCache;
}

export async function getTicker(symbol: string): Promise<TickerData | null> {
  if (tickersAreStale()) await refreshTickersFromRest();
  return tickerCache.get(symbol) ?? null;
}

/**
 * Fetch REAL OHLCV candlestick data from Kraken's public REST API.
 * Kraken has no API key requirement and no geo-blocking for REST.
 *
 * Kraken interval map (minutes): 1m→1, 5m→5, 15m→15, 1h→60, 4h→240, 1d→1440
 * Response format: [time, open, high, low, close, vwap, volume, count]
 */
export async function fetchCandles(
  symbol: string,
  interval: string,
  limit = 120,
): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
  const market = SYMBOL_TO_MARKET.get(symbol);
  if (!market) throw new Error(`Unknown symbol: ${symbol}`);

  const intervalMinutes: Record<string, number> = {
    "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440,
  };
  const intervalMin = intervalMinutes[interval];
  if (!intervalMin) throw new Error(`Unknown interval: ${interval}`);

  // Calculate `since` to fetch enough candles (Kraken returns up to 720)
  const sinceSeconds = Math.floor(Date.now() / 1000) - limit * intervalMin * 60;

  const url = `${KRAKEN_BASE}/OHLC?pair=${market.ohlcPair}&interval=${intervalMin}&since=${sinceSeconds}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Kraken OHLC error: ${res.status}`);

  const json = await res.json() as {
    error: string[];
    result: Record<string, Array<[number, string, string, string, string, string, string, number]>>;
  };
  if (json.error?.length) throw new Error(`Kraken OHLC error: ${json.error.join(", ")}`);

  // The result key is Kraken's internal pair name — grab the first array value
  const pairData = Object.entries(json.result).find(([k]) => k !== "last")?.[1];
  if (!pairData) throw new Error("No OHLC data returned from Kraken");

  // Kraken format: [time, open, high, low, close, vwap, volume, count]
  return pairData.slice(-limit).map(k => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[6]),
  }));
}

// ─── Indicators (computed from the real OHLC series, never randomised) ────────

function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

/** Wilder's RSI. `null` when there are not enough candles to compute it. */
export function relativeStrengthIndex(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD line, signal line and histogram from closes. `null` when too short. */
export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;

  const fastEma = emaSeries(closes, fast);
  const slowEma = emaSeries(closes, slow);
  const line = closes.map((_, i) => fastEma[i] - slowEma[i]);
  const signalLine = emaSeries(line, signalPeriod);

  const macdValue = line[line.length - 1];
  const signalValue = signalLine[signalLine.length - 1];
  return {
    macd: macdValue,
    signal: signalValue,
    histogram: macdValue - signalValue,
  };
}

/** Keep sub-dollar coins readable instead of rounding them to 0.01. */
function roundLevel(value: number): number {
  return Math.abs(value) >= 1 ? +value.toFixed(2) : +value.toPrecision(4);
}

export interface MarketSignals {
  symbol: string;
  signal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  strength: number;
  rsi: number | null;
  macd: number | null;
  trend: "bullish" | "bearish" | "sideways";
  supportLevel: number | null;
  resistanceLevel: number | null;
  updatedAt: string;
}

/**
 * Trading signals derived from the live ticker and the real 1h candle series:
 * RSI(14), MACD(12,26,9), an EMA(26) trend read and support/resistance taken
 * from recent swing lows and highs. Deterministic — the same market state
 * always produces the same readout.
 */
export async function generateSignals(symbol: string): Promise<MarketSignals> {
  const ticker = await getTicker(symbol);
  const candles = await fetchCandles(symbol, "1h", 120).catch(() => []);

  const closes = candles.map(c => c.close);
  const rsiValue = relativeStrengthIndex(closes, 14);
  const macdValue = macd(closes);

  const last = closes.length > 0 ? closes[closes.length - 1] : ticker?.price ?? 0;
  const emaValues = emaSeries(closes, 26);
  const ema26 = emaValues.length > 0 ? emaValues[emaValues.length - 1] : null;
  const changePct = ticker?.changePct24h ?? 0;

  let score = 0;
  if (rsiValue !== null) score += rsiValue >= 55 ? 1 : rsiValue <= 45 ? -1 : 0;
  if (macdValue) score += macdValue.histogram > 0 ? 1 : macdValue.histogram < 0 ? -1 : 0;
  score += changePct >= 1 ? 1 : changePct <= -1 ? -1 : 0;

  const signal: MarketSignals["signal"] =
    score >= 2 ? "strong_buy" :
    score === 1 ? "buy" :
    score === -1 ? "sell" :
    score <= -2 ? "strong_sell" :
    "neutral";

  const trend: MarketSignals["trend"] =
    ema26 !== null && last > ema26 * 1.001 ? "bullish" :
    ema26 !== null && last < ema26 * 0.999 ? "bearish" :
    ema26 === null ? (changePct >= 1 ? "bullish" : changePct <= -1 ? "bearish" : "sideways") :
    "sideways";

  // How far the read leans from neutral, driven by the indicators themselves.
  const momentum = macdValue && last > 0 ? Math.min(35, Math.abs(macdValue.histogram / last) * 1_000) : 0;
  const stretch = rsiValue !== null ? Math.abs(rsiValue - 50) : 0;
  const strength = Math.round(Math.min(95, Math.max(5, 45 + stretch + momentum + Math.abs(changePct) * 2)));

  const recentWindow = candles.slice(-40);
  const supportLevel = recentWindow.length > 0 ? roundLevel(Math.min(...recentWindow.map(c => c.low))) : null;
  const resistanceLevel = recentWindow.length > 0 ? roundLevel(Math.max(...recentWindow.map(c => c.high))) : null;

  return {
    symbol,
    signal,
    strength,
    rsi: rsiValue === null ? null : +rsiValue.toFixed(1),
    macd: macdValue === null ? null : +macdValue.macd.toFixed(4),
    trend,
    supportLevel,
    resistanceLevel,
    updatedAt: new Date().toISOString(),
  };
}
