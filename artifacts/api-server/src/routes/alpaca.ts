/**
 * Alpaca integration routes — all require an authenticated user with an active Alpaca account.
 *
 * GET  /alpaca/account    → real Alpaca account info (equity, buying power, cash)
 * GET  /alpaca/portfolio-history → real equity curve (1D…1Y)
 * GET  /alpaca/positions  → real open positions
 * GET  /alpaca/orders     → order history (last 50)
 * POST /alpaca/orders     → place a market/limit order
 * DELETE /alpaca/orders/:orderId → cancel an order
 */
import { Router, type IRouter } from "express";
import { db, tradingAccountsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { AlpacaClient, toAlpacaSymbol } from "../lib/alpaca";
import { logger } from "../lib/logger";
import { submitOrderIntent, type Decision } from "../lib/execution-gateway";

const router: IRouter = Router();

function respondBlocked(res: any, decision: Extract<Decision, { outcome: "blocked" }>): void {
  logger.warn({ userId: decision.audit?.userId, code: decision.code }, decision.message);
  res.status(decision.httpStatus).json({
    error: decision.message,
    code: decision.code,
    auditId: decision.audit?.id ?? null,
  });
}

function requireAuth(req: any, res: any): boolean {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  return true;
}

/** Look up the user's first active Alpaca account and return an AlpacaClient. */
async function getAlpacaClient(userId: number, res: any): Promise<AlpacaClient | null> {
  const rows = await db
    .select()
    .from(tradingAccountsTable)
    .where(
      and(
        eq(tradingAccountsTable.userId, userId),
        eq(tradingAccountsTable.exchange, "alpaca"),
        eq(tradingAccountsTable.status, "active"),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    res.status(404).json({ error: "No active Alpaca account connected. Go to Accounts to add one." });
    return null;
  }

  const row = rows[0];
  return new AlpacaClient(row.apiKey, row.apiSecret, (row.mode ?? "paper") as "paper" | "live");
}

// GET /alpaca/account
router.get("/alpaca/account", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const client = await getAlpacaClient(req.session.userId!, res);
  if (!client) return;

  try {
    const account = await client.getAccount();
    res.json({
      equity:       parseFloat(account.equity),
      cash:         parseFloat(account.cash),
      buyingPower:  parseFloat(account.buying_power),
      portfolioValue: parseFloat(account.portfolio_value),
      currency:     account.currency,
      status:       account.status,
      mode:         client.mode,
      daytradeCount: account.daytrade_count,
      patternDayTrader: account.pattern_day_trader,
    });
  } catch (err: any) {
    logger.warn({ err }, "Alpaca getAccount error");
    res.status(502).json({ error: `Alpaca error: ${err?.message}` });
  }
});

// GET /alpaca/portfolio-history — real equity curve from Alpaca
// Alpaca periods are <n><D|W|M|A> — a year is "1A", not "1Y" — and any period
// longer than 30 days only accepts a 1D timeframe.
const RANGE_TO_ALPACA_PERIOD: Record<string, string> = {
  "1D": "1D",
  "1W": "1W",
  "1M": "1M",
  "3M": "3M",
  "1Y": "1A",
  "ALL": "all",
};

const PERIOD_DEFAULT_TIMEFRAME: Record<string, string> = {
  "1D": "5Min",
  "1W": "15Min",
  "1M": "1D",
  "3M": "1D",
  "1A": "1D",
  "all": "1D",
};

const PERIOD_DAYS: Record<string, number> = {
  "1D": 1, "1W": 7, "1M": 30, "3M": 90, "1A": 365, "all": 3650,
};

const VALID_TIMEFRAMES = new Set(["1Min", "5Min", "15Min", "1H", "1D"]);
const INTRADAY_TIMEFRAMES = new Set(["1Min", "5Min", "15Min", "1H"]);

router.get("/alpaca/portfolio-history", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;

  // Validate the request before touching the broker so bad input never costs a call.
  const range = String(req.query.period ?? "1D").toUpperCase();
  const alpacaPeriod = RANGE_TO_ALPACA_PERIOD[range];
  if (!alpacaPeriod) {
    res.status(400).json({ error: `period must be one of: 1D, 1W, 1M, 3M, 1Y, all` });
    return;
  }

  const requested = typeof req.query.timeframe === "string" ? req.query.timeframe : "";
  if (requested && !VALID_TIMEFRAMES.has(requested)) {
    res.status(400).json({ error: `timeframe must be one of: ${[...VALID_TIMEFRAMES].join(", ")}` });
    return;
  }

  // Alpaca rejects sub-daily timeframes beyond 30 days, so clamp instead of 400-ing.
  let timeframe = requested || PERIOD_DEFAULT_TIMEFRAME[alpacaPeriod];
  if ((PERIOD_DAYS[alpacaPeriod] ?? 0) > 30 && timeframe !== "1D") timeframe = "1D";

  // Crypto accounts want the full 24/7 session rather than core equity hours.
  const intradayReporting = INTRADAY_TIMEFRAMES.has(timeframe) ? "continuous" as const : undefined;

  const client = await getAlpacaClient(req.session.userId!, res);
  if (!client) return;

  try {
    const history = await client.getPortfolioHistory(alpacaPeriod, timeframe, intradayReporting);
    const points = history.timestamp
      .map((ts, i) => ({ t: new Date(ts * 1000).toISOString(), equity: history.equity[i] }))
      .filter((p): p is { t: string; equity: number } => typeof p.equity === "number");

    const last = points.length > 0 ? points[points.length - 1].equity : history.base_value;
    const change = last - history.base_value;

    res.json({
      period: range,
      timeframe: history.timeframe ?? timeframe,
      baseValue: history.base_value,
      change: +change.toFixed(2),
      changePct: history.base_value > 0 ? +((change / history.base_value) * 100).toFixed(2) : 0,
      points,
    });
  } catch (err: any) {
    logger.warn({ err, alpacaPeriod, timeframe }, "Alpaca getPortfolioHistory error");
    res.status(502).json({ error: `Alpaca error: ${err?.message}` });
  }
});

// GET /alpaca/positions
router.get("/alpaca/positions", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const client = await getAlpacaClient(req.session.userId!, res);
  if (!client) return;

  try {
    const positions = await client.getPositions();
    res.json(
      positions.map(p => ({
        symbol:              p.symbol,
        side:                p.side,
        qty:                 parseFloat(p.qty),
        avgEntryPrice:       parseFloat(p.avg_entry_price),
        currentPrice:        parseFloat(p.current_price),
        marketValue:         parseFloat(p.market_value),
        costBasis:           parseFloat(p.cost_basis),
        unrealizedPl:        parseFloat(p.unrealized_pl),
        unrealizedPlPct:     parseFloat(p.unrealized_plpc) * 100,
        changeToday:         parseFloat(p.change_today),
      })),
    );
  } catch (err: any) {
    logger.warn({ err }, "Alpaca getPositions error");
    res.status(502).json({ error: `Alpaca error: ${err?.message}` });
  }
});

// GET /alpaca/orders
router.get("/alpaca/orders", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const client = await getAlpacaClient(req.session.userId!, res);
  if (!client) return;

  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const orders = await client.getOrders(limit);
    res.json(
      orders.map(o => ({
        id:             o.id,
        symbol:         o.symbol,
        side:           o.side,
        type:           o.type,
        qty:            parseFloat(o.qty),
        filledQty:      parseFloat(o.filled_qty),
        filledAvgPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : null,
        status:         o.status,
        timeInForce:    o.time_in_force,
        limitPrice:     o.limit_price ? parseFloat(o.limit_price) : null,
        submittedAt:    o.submitted_at,
        filledAt:       o.filled_at,
        canceledAt:     o.canceled_at,
      })),
    );
  } catch (err: any) {
    logger.warn({ err }, "Alpaca getOrders error");
    res.status(502).json({ error: `Alpaca error: ${err?.message}` });
  }
});

// POST /alpaca/orders — routed through the execution gateway (dry-run, nothing sent)
router.post("/alpaca/orders", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const client = await getAlpacaClient(req.session.userId!, res);
  if (!client) return;

  const { symbol, qty, notional, side, type = "market", limit_price, referencePrice } = req.body;

  if (!symbol || !side) {
    res.status(400).json({ error: "symbol and side are required" });
    return;
  }
  if (!qty && !notional) {
    res.status(400).json({ error: "Either qty or notional is required" });
    return;
  }
  if (type !== "market" && type !== "limit") {
    res.status(400).json({ error: "Only market and limit orders are accepted" });
    return;
  }

  const limitPrice =
    limit_price !== undefined && limit_price !== null && limit_price !== "" ? parseFloat(String(limit_price)) : undefined;
  const reference = Number(referencePrice) > 0 ? Number(referencePrice) : undefined;
  const unitPrice = limitPrice ?? reference;
  // Alpaca accepts a dollar amount instead of a quantity; convert it so the risk check
  // has a size. The gateway refuses the order when it cannot be priced at all.
  const qtyNum = qty ? parseFloat(String(qty)) : unitPrice ? +(Number(notional) / unitPrice).toFixed(8) : NaN;

  const decision = submitOrderIntent({
    source: "rest:alpaca",
    userId: req.session.userId!,
    broker: "alpaca",
    accountMode: client.mode,
    localFill: false,
    symbol,
    side,
    type,
    qty: qtyNum,
    limitPrice,
    notional: notional ? Number(notional) : undefined,
    referencePrice: unitPrice,
  });

  if (decision.outcome === "blocked") {
    respondBlocked(res, decision);
    return;
  }
  if (decision.outcome !== "dry_run") {
    res.status(500).json({ error: "Unexpected execution decision" });
    return;
  }

  logger.info({ auditId: decision.audit.id, symbol, side, notional }, decision.message);
  res.status(202).json({
    status: "dry_run",
    message: decision.message,
    auditId: decision.audit.id,
    intent: decision.audit,
    notional: decision.notional,
  });
});

// DELETE /alpaca/orders/:orderId — cancel an order
router.delete("/alpaca/orders/:orderId", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const client = await getAlpacaClient(req.session.userId!, res);
  if (!client) return;

  const orderId = req.params.orderId as string;
  try {
    await client.cancelOrder(orderId);
    res.sendStatus(204);
  } catch (err: any) {
    logger.warn({ err }, "Alpaca cancelOrder error");
    res.status(400).json({ error: `Cancel failed: ${err?.message}` });
  }
});

export default router;
