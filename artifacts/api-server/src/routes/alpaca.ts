/**
 * Alpaca integration routes — all require an authenticated user with an active Alpaca account.
 *
 * GET  /alpaca/account    → real Alpaca account info (equity, buying power, cash)
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
import { ORDER_PLACEMENT_QUARANTINE_MESSAGE } from "../lib/order-quarantine";

const router: IRouter = Router();

function rejectOrderPlacement(res: any, userId: number): boolean {
  logger.warn({ userId }, ORDER_PLACEMENT_QUARANTINE_MESSAGE);
  res.status(503).json({ error: ORDER_PLACEMENT_QUARANTINE_MESSAGE });
  return true;
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

// POST /alpaca/orders — place an order
router.post("/alpaca/orders", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  if (rejectOrderPlacement(res, req.session.userId!)) return;
  const client = await getAlpacaClient(req.session.userId!, res);
  if (!client) return;

  const { symbol, qty, notional, side, type = "market", time_in_force = "gtc", limit_price, stop_price } = req.body;

  if (!symbol || !side) {
    res.status(400).json({ error: "symbol and side are required" });
    return;
  }
  if (!qty && !notional) {
    res.status(400).json({ error: "Either qty or notional is required" });
    return;
  }

  // Convert our symbol format (BTC-USDT) to Alpaca format (BTC/USD)
  const alpacaSymbol = symbol.includes("/") ? symbol : toAlpacaSymbol(symbol);

  try {
    const order = await client.placeOrder({
      symbol:        alpacaSymbol,
      qty:           qty ? String(qty) : undefined,
      notional:      notional ? String(notional) : undefined,
      side,
      type,
      time_in_force,
      limit_price:   limit_price ? String(limit_price) : undefined,
      stop_price:    stop_price ? String(stop_price) : undefined,
    });

    logger.info({ symbol: alpacaSymbol, side, qty, notional, orderId: order.id }, "Alpaca order placed");
    res.status(201).json({
      id:           order.id,
      symbol:       order.symbol,
      side:         order.side,
      type:         order.type,
      qty:          parseFloat(order.qty),
      status:       order.status,
      submittedAt:  order.submitted_at,
    });
  } catch (err: any) {
    logger.warn({ err }, "Alpaca placeOrder error");
    res.status(400).json({ error: `Order failed: ${err?.message}` });
  }
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
