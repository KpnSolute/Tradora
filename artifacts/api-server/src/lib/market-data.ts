import { logger } from "./logger.ts";

// Real market data via Kraken public API (no key required, no geo-blocking)
const KRAKEN_BASE = "https://api.kraken.com/0/public";

export interface MarketMeta {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  /** Kraken WS v2 name, e.g. "BTC/USD". */
  wsSymbol: string;
  /** Kraken pair name accepted by OHLC and Ticker, e.g. "XBTUSD". */
  ohlcPair: string;
}

/** Default watchlist / trending set. The full catalog comes from Kraken. */
export const SUPPORTED_MARKETS: MarketMeta[] = [
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

const DEFAULT_BY_SYMBOL = new Map(SUPPORTED_MARKETS.map(m => [m.symbol, m]));

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

// ─── Pair catalog (token discovery) ───────────────────────────────────────────

const CATALOG_TTL_MS = 30 * 60_000;
let pairCatalog: Map<string, MarketMeta> | null = null;
let pairCatalogAt = 0;
let catalogInFlight: Promise<Map<string, MarketMeta> | null> | null = null;

/** Kraken asset codes → the ticker symbol people actually recognise. */
const ASSET_ALIASES: Record<string, string> = {
  XXBT: "BTC", XBT: "BTC", XETH: "ETH", XDG: "DOGE", XXRP: "XRP", XLTC: "LTC",
  XZEC: "ZEC", XXLM: "XLM", XXMR: "XMR", XETC: "ETC", XMLN: "MLN", XREP: "REP",
  ZUSD: "USD", ZUSDT: "USDT", ZEUR: "EUR", ZGBP: "GBP", ZJPY: "JPY", ZCAD: "CAD",
  ZAUD: "AUD", ZCHF: "CHF",
};

function displayAsset(code: string): string {
  if (ASSET_ALIASES[code]) return ASSET_ALIASES[code];
  // Kraken prefixes some 3-letter legacy codes with X (XBT, XRP, XLTC…), and a
  // handful of 4-letter ones (XXBT). Anything else is already the ticker.
  const stripped = code.length === 4 && code.startsWith("X") ? code.slice(1) : code;
  return ASSET_ALIASES[stripped] ?? stripped;
}

/** Keep a 1:1 mapping between a Kraken listing and an app symbol. */
function toMeta(key: string, raw: any, quote: string): MarketMeta | null {
  const base = displayAsset(String(raw?.base ?? ""));
  const wsname = String(raw?.wsname ?? "");
  if (!base || !wsname) return null;
  const altname = String(raw?.altname ?? key);
  return {
    symbol: `${base}-USDT`,
    name: base,
    exchange: "Kraken",
    type: "crypto",
    wsSymbol: wsname,
    ohlcPair: altname,
  };
}

async function loadCatalog(): Promise<Map<string, MarketMeta> | null> {
  try {
    const res = await fetch(`${KRAKEN_BASE}/AssetPairs`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Kraken asset-pair catalog request failed");
      return null;
    }
    const json = await res.json() as { error?: string[]; result?: Record<string, any> };
    if (json.error?.length || !json.result) {
      logger.warn({ error: json.error }, "Kraken asset-pair catalog rejected the request");
      return null;
    }

    const catalog = new Map<string, MarketMeta>();
    const quotes = new Map<string, string>();

    for (const [key, raw] of Object.entries(json.result)) {
      if (raw?.status && raw.status !== "online") continue;
      const quote = displayAsset(String(raw?.quote ?? ""));
      if (quote !== "USD" && quote !== "USDT") continue;
      // USDT listings are the app's naming convention, but a USD book is the
      // one the websocket publishes — prefer it when both exist.
      const existingQuote = quotes.get(key);
      if (existingQuote === "USD") continue;

      const meta = toMeta(key, raw, quote);
      if (!meta) continue;
      if (catalog.has(meta.symbol) && quotes.get(meta.symbol) === "USD") continue;

      catalog.set(meta.symbol, meta);
      quotes.set(meta.symbol, quote);
    }

    logger.info({ pairs: catalog.size }, "Kraken asset-pair catalog loaded");
    pairCatalog = catalog;
    pairCatalogAt = Date.now();
    return catalog;
  } catch (err) {
    logger.warn({ err }, "Kraken asset-pair catalog fetch failed");
    return null;
  }
}

async function ensureCatalog(): Promise<Map<string, MarketMeta> | null> {
  if (pairCatalog && Date.now() - pairCatalogAt < CATALOG_TTL_MS) return pairCatalog;
  if (catalogInFlight) return catalogInFlight;
  catalogInFlight = loadCatalog().finally(() => { catalogInFlight = null; });
  return catalogInFlight;
}

/** Resolve one app symbol to a Kraken listing (defaults first, then the catalog). */
export async function resolveMarket(symbol: string): Promise<MarketMeta | null> {
  const wanted = String(symbol ?? "").trim().toUpperCase();
  if (!wanted) return null;
  const known = DEFAULT_BY_SYMBOL.get(wanted);
  if (known) return known;
  const catalog = await ensureCatalog();
  return catalog?.get(wanted) ?? null;
}

/** Convert Kraken WS symbol (BTC/USD) to our symbol (BTC-USDT). */
export function fromKrakenWsSymbol(ws: string): string | undefined {
  const direct = SUPPORTED_MARKETS.find(m => m.wsSymbol === ws);
  if (direct) return direct.symbol;
  if (!pairCatalog) return undefined;
  for (const meta of pairCatalog.values()) {
    if (meta.wsSymbol === ws) return meta.symbol;
  }
  return undefined;
}

export interface MarketSummary {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  price: number | null;
  changePct24h: number | null;
  volume24h: number | null;
}

function summarize(meta: MarketMeta): MarketSummary {
  const ticker = tickerCache.get(meta.symbol);
  return {
    symbol: meta.symbol,
    name: meta.name,
    exchange: meta.exchange,
    type: meta.type,
    price: ticker?.price ?? null,
    changePct24h: ticker?.changePct24h ?? null,
    volume24h: ticker?.volume24h ?? null,
  };
}

/** Every tradable token Kraken lists against USD/USDT, plus the defaults. */
export async function listMarkets(): Promise<MarketSummary[]> {
  const catalog = await ensureCatalog();
  const merged = new Map<string, MarketMeta>(DEFAULT_BY_SYMBOL);
  for (const meta of catalog?.values() ?? []) {
    if (!merged.has(meta.symbol)) merged.set(meta.symbol, meta);
  }
  return [...merged.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)).map(summarize);
}

/**
 * Token discovery: search the catalog by ticker or asset name, price the
 * matches from Kraken and return them ready to display or trade.
 */
export async function searchMarkets(query: string, limit = 25): Promise<MarketSummary[]> {
  const catalog = await ensureCatalog();
  const merged = new Map<string, MarketMeta>(DEFAULT_BY_SYMBOL);
  for (const meta of catalog?.values() ?? []) {
    if (!merged.has(meta.symbol)) merged.set(meta.symbol, meta);
  }

  const needle = String(query ?? "").trim().toUpperCase();
  const all = [...merged.values()];
  const matches = needle
    ? all.filter(m => m.symbol.includes(needle) || m.name.toUpperCase().includes(needle))
    : SUPPORTED_MARKETS;

  const ranked = matches
    .sort((a, b) => {
      const aStart = a.symbol.startsWith(needle) ? 0 : 1;
      const bStart = b.symbol.startsWith(needle) ? 0 : 1;
      if (aStart !== bStart) return aStart - bStart;
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, Math.min(Math.max(limit, 1), 100));

  // Only price what is being returned — one batch request, not one per token.
  const stale = ranked.filter(meta => {
    const ticker = tickerCache.get(meta.symbol);
    return !ticker || Date.now() - Date.parse(ticker.updatedAt) > STALE_AFTER_MS;
  });
  if (stale.length > 0) await applyBatch(stale, new Date().toISOString());

  return ranked.map(summarize);
}

// ─── REST snapshot ────────────────────────────────────────────────────────────

/** A ticker older than this is no longer "live" and gets refetched from REST. */
const STALE_AFTER_MS = 15_000;

let restInFlight: Promise<boolean> | null = null;

function newestTickerAge(now = Date.now()): number {
  let newest = 0;
  for (const ticker of tickerCache.values()) {
    const at = Date.parse(ticker.updatedAt);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest === 0 ? Number.POSITIVE_INFINITY : now - newest;
}

/** True when the default watchlist cannot be trusted as a live quote. */
export function tickersAreStale(now = Date.now()): boolean {
  if (SUPPORTED_MARKETS.some(m => !tickerCache.has(m.symbol))) return true;
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

function pickKrakenRow(result: KrakenTickerResult, market: MarketMeta): KrakenTickerRow | null {
  const wanted = market.symbol.split("-")[0];
  const key = Object.keys(result).find(candidate => krakenKeyBase(candidate) === wanted);
  return key ? result[key] : null;
}

/**
 * The Ticker endpoint rejects a few OHLC-only names (XLTCUSD), so ask with the
 * plain asset code there even though OHLC needs the legacy name.
 */
function tickerPair(market: MarketMeta): string {
  return market.ohlcPair.replace(/^X(?=[A-Z]{3}USD$)/, "");
}

/** Write one exchange row into the shared cache. False when the row is unusable. */
function applyKrakenRow(market: MarketMeta, row: KrakenTickerRow, updatedAt: string): boolean {
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
 * Price a set of markets from one REST snapshot. Tries a single batched request
 * first and retries pair by pair, because one unknown pair makes Kraken reject
 * the whole batch.
 */
async function applyBatch(markets: MarketMeta[], updatedAt: string): Promise<number> {
  const priced = new Set<string>();
  let applied = 0;

  const batchPairs = [...new Set(markets.map(tickerPair))];
  const batch = await fetchKrakenTickers(batchPairs.join(","));
  if (batch) {
    for (const market of markets) {
      const row = pickKrakenRow(batch, market);
      if (row && applyKrakenRow(market, row, updatedAt)) {
        priced.add(market.symbol);
        applied += 1;
      }
    }
  }

  for (const market of markets) {
    if (priced.has(market.symbol)) continue;
    for (const pair of new Set([tickerPair(market), market.ohlcPair])) {
      const result = await fetchKrakenTickers(pair);
      const row = result ? pickKrakenRow(result, market) : null;
      if (row && applyKrakenRow(market, row, updatedAt)) {
        applied += 1;
        break;
      }
    }
  }

  return applied;
}

/**
 * Refresh the default watchlist from Kraken's REST ticker endpoint. Concurrent
 * callers share one request.
 */
export function refreshTickersFromRest(): Promise<boolean> {
  if (restInFlight) return restInFlight;

  const task = (async (): Promise<boolean> => {
    try {
      const updatedAt = new Date().toISOString();
      const applied = await applyBatch(SUPPORTED_MARKETS, updatedAt);
      if (applied > 0) {
        logger.info({ applied, requested: SUPPORTED_MARKETS.length }, "Kraken REST ticker snapshot refreshed");
      }
      return applied > 0;
    } catch (err) {
      logger.warn({ err }, "Kraken REST ticker snapshot failed");
      return false;
    } finally {
      restInFlight = null;
    }
  })();

  restInFlight = task;
  return task;
}

/** Refetch a single market that is not part of the default watchlist. */
async function refreshMarketFromRest(meta: MarketMeta): Promise<void> {
  try {
    await applyBatch([meta], new Date().toISOString());
  } catch (err) {
    logger.warn({ err, symbol: meta.symbol }, "Kraken REST ticker refresh failed for symbol");
  }
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

function isFresh(symbol: string, now = Date.now()): boolean {
  const ticker = tickerCache.get(symbol);
  if (!ticker) return false;
  const at = Date.parse(ticker.updatedAt);
  return Number.isFinite(at) && now - at <= STALE_AFTER_MS;
}

export async function getTickers(): Promise<Map<string, TickerData>> {
  if (tickersAreStale()) await refreshTickersFromRest();
  return tickerCache;
}

export async function getTicker(symbol: string): Promise<TickerData | null> {
  const meta = await resolveMarket(symbol);
  if (!meta) return null;

  if (!isFresh(meta.symbol)) {
    if (DEFAULT_BY_SYMBOL.has(meta.symbol)) await refreshTickersFromRest();
    else await refreshMarketFromRest(meta);
  }
  return tickerCache.get(meta.symbol) ?? null;
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
  const market = await resolveMarket(symbol);
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
