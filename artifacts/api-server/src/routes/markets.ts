import { Router, type IRouter } from "express";
import {
  listMarkets,
  searchMarkets,
  resolveMarket,
  getTicker,
  getTickers,
  fetchCandles,
  generateSignals,
} from "../lib/market-data";

const router: IRouter = Router();

router.get("/markets", async (_req, res): Promise<void> => {
  res.json(await listMarkets());
});

// Token discovery — search the Kraken catalog by ticker or asset name.
router.get("/markets/search", async (req, res): Promise<void> => {
  const query = typeof req.query.q === "string" ? req.query.q : "";
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 25;
  res.json(await searchMarkets(query, Number.isFinite(limit) ? limit : 25));
});

router.get("/markets/trending", async (_req, res): Promise<void> => {
  const tickers = await getTickers();
  const sorted = Array.from(tickers.values())
    .sort((a, b) => Math.abs(b.changePct24h) - Math.abs(a.changePct24h))
    .slice(0, 8);
  res.json(sorted);
});

router.get("/markets/:symbol/ticker", async (req, res): Promise<void> => {
  const symbol = Array.isArray(req.params.symbol) ? req.params.symbol[0] : req.params.symbol;
  const ticker = await getTicker(symbol);
  if (!ticker) {
    res.status(404).json({ error: "Market not found" });
    return;
  }
  res.json(ticker);
});

router.get("/markets/:symbol/candles/:interval", async (req, res): Promise<void> => {
  const symbol   = Array.isArray(req.params.symbol)   ? req.params.symbol[0]   : req.params.symbol;
  const interval = Array.isArray(req.params.interval) ? req.params.interval[0] : req.params.interval;

  const validIntervals = ["1m", "5m", "15m", "1h", "4h", "1d"];
  if (!validIntervals.includes(interval)) {
    res.status(400).json({ error: "Invalid interval" });
    return;
  }

  const market = await resolveMarket(symbol);
  if (!market) {
    res.status(404).json({ error: "Market not found" });
    return;
  }

  try {
    const candles = await fetchCandles(symbol, interval, 120);
    res.json(candles);
  } catch (err: any) {
    res.status(502).json({ error: `Failed to fetch candles: ${err?.message ?? "unknown"}` });
  }
});

router.get("/markets/:symbol/signals", async (req, res): Promise<void> => {
  const symbol = Array.isArray(req.params.symbol) ? req.params.symbol[0] : req.params.symbol;
  const market = await resolveMarket(symbol);
  if (!market) {
    res.status(404).json({ error: "Market not found" });
    return;
  }
  // Signals are computed from the live ticker and the real candle series.
  const signals = await generateSignals(symbol);
  res.json(signals);
});

export default router;
