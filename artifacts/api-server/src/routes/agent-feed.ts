/**
 * Agent Feed routes — human-in-the-loop trade intents.
 *
 * GET  /agent-feed                → list the user's intents, newest first
 * POST /agent-feed/generate       → ask the strategy-engine analyst for a proposal
 * POST /agent-feed/:id/approve    → simulate the intent as a paper trade
 * POST /agent-feed/:id/reject     → record the rejection, simulate nothing
 *
 * Paper only by construction: approvals write into the local `trades` table with
 * `mode = "paper"` and never reach a broker client, the order-quarantine guard,
 * or the strategy engine's order path. The engine itself only returns a thesis
 * and risk levels — it has no order-submission endpoint.
 */
import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, tradeIntentsTable, tradesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { fetchCandles, getTicker, resolveMarket } from "../lib/market-data";
import {
  generateTradeIntent,
  StrategyEngineError,
} from "../lib/strategy-engine";

const router: IRouter = Router();

/** Matches the paper balance the portfolio view starts from. */
const PAPER_STARTING_BALANCE = 10_000;
const INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_THESIS_IN_NOTES = 220;

/**
 * Bar intervals the analyst may run on. Short intraday windows give the 21-period
 * EMA and ATR too little history inside Kraken's 120-candle response to mean
 * anything, so the feed stops at 15m.
 */
const ANALYST_TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
type AnalystTimeframe = (typeof ANALYST_TIMEFRAMES)[number];
const DEFAULT_TIMEFRAME: AnalystTimeframe = "1h";

class AgentFeedError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "AgentFeedError";
  }
}

function requireAuth(req: any, res: any): boolean {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  return true;
}

function sendRouteError(res: any, error: unknown): void {
  if (error instanceof AgentFeedError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  if (error instanceof StrategyEngineError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  logger.error({ err: error }, "Agent Feed request failed");
  res.status(500).json({ error: "Agent Feed request failed" });
}

function serializeIntent(intent: any) {
  return {
    id: intent.id,
    userId: intent.userId,
    symbol: intent.symbol,
    side: intent.side,
    quantity: parseFloat(intent.quantity),
    orderType: intent.orderType,
    referencePrice: parseFloat(intent.referencePrice),
    stopLoss: parseFloat(intent.stopLoss),
    takeProfit: parseFloat(intent.takeProfit),
    confidence: parseFloat(intent.confidence),
    thesis: intent.thesis,
    strategyName: intent.strategyName,
    timeframe: intent.timeframe,
    status: intent.status,
    mode: intent.mode,
    decisionNote: intent.decisionNote ?? null,
    decidedAt: intent.decidedAt ?? null,
    tradeId: intent.tradeId ?? null,
    expiresAt: intent.expiresAt ?? null,
    createdAt: intent.createdAt,
  };
}

/**
 * Cash available in the paper book. Unrealised P&L is deliberately ignored so
 * position sizing never depends on a mark that can jump between requests.
 */
async function getPaperEquity(userId: number): Promise<number> {
  const trades = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.userId, userId), eq(tradesTable.mode, "paper")));

  let cash = PAPER_STARTING_BALANCE;
  for (const trade of trades) {
    if (trade.status !== "filled") continue;
    const notional = parseFloat(trade.quantity) * parseFloat(trade.price);
    cash += trade.side === "buy" ? -notional : notional;
  }
  return Math.max(cash, 100);
}

async function loadIntent(userId: number, rawId: string) {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id)) {
    throw new AgentFeedError("Invalid intent id", 400);
  }
  const [intent] = await db
    .select()
    .from(tradeIntentsTable)
    .where(
      and(eq(tradeIntentsTable.id, id), eq(tradeIntentsTable.userId, userId)),
    );
  if (!intent) {
    throw new AgentFeedError("Trade intent not found", 404);
  }
  return intent;
}

// GET /agent-feed
router.get("/agent-feed", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;

  const intents = await db
    .select()
    .from(tradeIntentsTable)
    .where(eq(tradeIntentsTable.userId, req.session.userId!))
    .orderBy(desc(tradeIntentsTable.createdAt))
    .limit(100);

  res.json(intents.map(serializeIntent));
});

// POST /agent-feed/generate
router.post("/agent-feed/generate", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId!;

  const symbol = String(req.body?.symbol ?? "").trim().toUpperCase();
  // Any token Kraken lists can be analysed, not just the default pairs.
  const market = await resolveMarket(symbol);
  if (!market) {
    res.status(400).json({ error: `unknown or untradable symbol: ${symbol}` });
    return;
  }

  const rawTimeframe = req.body?.timeframe;
  const timeframe = (
    typeof rawTimeframe === "string" && rawTimeframe.trim() !== ""
      ? rawTimeframe.trim()
      : DEFAULT_TIMEFRAME
  ) as AnalystTimeframe;
  if (!ANALYST_TIMEFRAMES.includes(timeframe)) {
    res.status(400).json({
      error: `timeframe must be one of: ${ANALYST_TIMEFRAMES.join(", ")}`,
    });
    return;
  }

  let candles: Awaited<ReturnType<typeof fetchCandles>>;
  try {
    candles = await fetchCandles(symbol, timeframe, 120);
  } catch (error) {
    logger.warn(
      { err: error, symbol, timeframe },
      "Agent Feed market data fetch failed",
    );
    res
      .status(502)
      .json({ error: `Market data unavailable for ${symbol} (${timeframe})` });
    return;
  }

  if (candles.length === 0) {
    res.status(502).json({ error: `No candles returned for ${symbol}` });
    return;
  }

  const equity = await getPaperEquity(userId);
  let analysis;
  try {
    analysis = await generateTradeIntent({
      symbol,
      asset_class: "crypto",
      mode: "paper",
      timeframe,
      equity,
      bars: candles.map((candle) => ({
        symbol,
        asset_class: "crypto" as const,
        timestamp: new Date(candle.time * 1000).toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      })),
    });
  } catch (error) {
    sendRouteError(res, error);
    return;
  }

  if (!analysis.intent) {
    res.json({ intent: null, note: analysis.note });
    return;
  }

  const proposal = analysis.intent;
  const [row] = await db
    .insert(tradeIntentsTable)
    .values({
      userId,
      symbol,
      side: proposal.side,
      quantity: String(proposal.quantity),
      orderType: proposal.order_type,
      referencePrice: String(proposal.reference_price),
      stopLoss: String(proposal.stop_loss),
      takeProfit: String(proposal.take_profit),
      confidence: String(proposal.confidence),
      thesis: proposal.thesis,
      strategyName: proposal.strategy_name,
      timeframe,
      status: "pending",
      mode: "paper",
      expiresAt: new Date(Date.now() + INTENT_TTL_MS),
    })
    .returning();

  logger.info(
    { intentId: row.id, symbol: row.symbol, side: row.side, timeframe },
    "Agent Feed intent created",
  );

  res.status(201).json({ intent: serializeIntent(row), note: analysis.note });
});

// POST /agent-feed/:id/approve
router.post("/agent-feed/:id/approve", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId!;
  const intentId = Number.parseInt(String(req.params.id), 10);
  if (!Number.isFinite(intentId)) {
    res.status(400).json({ error: "Invalid intent id" });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [intent] = await tx
        .select()
        .from(tradeIntentsTable)
        .where(
          and(
            eq(tradeIntentsTable.id, intentId),
            eq(tradeIntentsTable.userId, userId),
          ),
        );

      if (!intent) throw new AgentFeedError("Trade intent not found", 404);
      if (intent.status !== "pending") {
        throw new AgentFeedError(
          `Trade intent is already ${intent.status}`,
          409,
        );
      }
      if (intent.expiresAt && intent.expiresAt.getTime() < Date.now()) {
        throw new AgentFeedError(
          "Trade intent has expired; generate a fresh proposal",
          409,
        );
      }

      const now = new Date();
      const quantity = parseFloat(intent.quantity);
      const ticker = await getTicker(intent.symbol);
      const referencePrice = parseFloat(intent.referencePrice);
      const fillPrice =
        ticker && Number.isFinite(ticker.price) && ticker.price > 0
          ? ticker.price
          : referencePrice;
      const total = quantity * fillPrice;

      const [trade] = await tx
        .insert(tradesTable)
        .values({
          userId,
          symbol: intent.symbol,
          side: intent.side,
          quantity: String(quantity),
          price: String(fillPrice),
          total: String(total),
          status: "filled",
          mode: "paper",
          notes: `Agent Feed intent #${intent.id} — ${intent.thesis.slice(0, MAX_THESIS_IN_NOTES)}`,
          filledAt: now,
        })
        .returning();

      const [updated] = await tx
        .update(tradeIntentsTable)
        .set({ status: "approved", decidedAt: now, tradeId: trade.id })
        .where(
          and(
            eq(tradeIntentsTable.id, intent.id),
            eq(tradeIntentsTable.userId, userId),
            eq(tradeIntentsTable.status, "pending"),
          ),
        )
        .returning();

      if (!updated) {
        throw new AgentFeedError("Trade intent was already decided", 409);
      }

      logger.info(
        {
          intentId: updated.id,
          tradeId: trade.id,
          symbol: trade.symbol,
          side: trade.side,
          price: fillPrice,
        },
        "Agent Feed intent approved into paper trading",
      );

      return serializeIntent(updated);
    });

    res.json(result);
  } catch (error) {
    sendRouteError(res, error);
  }
});

// POST /agent-feed/:id/reject
router.post("/agent-feed/:id/reject", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId!;

  try {
    const intent = await loadIntent(userId, String(req.params.id));
    if (intent.status !== "pending") {
      res
        .status(409)
        .json({ error: `Trade intent is already ${intent.status}` });
      return;
    }

    const rawReason = req.body?.reason;
    if (rawReason !== undefined && typeof rawReason !== "string") {
      res.status(400).json({ error: "reason must be a string" });
      return;
    }
    const reason =
      typeof rawReason === "string" && rawReason.trim() !== ""
        ? rawReason.trim().slice(0, 500)
        : null;

    const [updated] = await db
      .update(tradeIntentsTable)
      .set({ status: "rejected", decidedAt: new Date(), decisionNote: reason })
      .where(
        and(
          eq(tradeIntentsTable.id, intent.id),
          eq(tradeIntentsTable.userId, userId),
          eq(tradeIntentsTable.status, "pending"),
        ),
      )
      .returning();

    if (!updated) {
      res.status(409).json({ error: "Trade intent was already decided" });
      return;
    }

    res.json(serializeIntent(updated));
  } catch (error) {
    sendRouteError(res, error);
  }
});

export default router;
