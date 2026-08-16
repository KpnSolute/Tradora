/**
 * Generic broker routes — works for any connected exchange (alpaca, coinbase, binance, kraken, bybit).
 *
 * GET  /broker-accounts/:exchange/info       → account equity/cash
 * GET  /broker-accounts/:exchange/positions  → open positions
 * GET  /broker-accounts/:exchange/orders     → recent orders
 * POST /broker-accounts/:exchange/orders     → place order (live mode only)
 * DELETE /broker-accounts/:exchange/orders/:orderId → cancel order
 */
import { Router, type IRouter } from "express";
import { db, tradingAccountsTable, tradesTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getBrokerClient } from "../lib/broker-factory";
import { getTicker } from "../lib/market-data";
import { logger } from "../lib/logger";
import { ORDER_PLACEMENT_QUARANTINE_MESSAGE } from "../lib/order-quarantine";

const router: IRouter = Router();

function rejectOrderPlacement(res: any, userId: number, exchange: string): boolean {
  logger.warn({ userId, exchange }, ORDER_PLACEMENT_QUARANTINE_MESSAGE);
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

async function getAccount(userId: number, exchange: string, res: any) {
  const rows = await db
    .select()
    .from(tradingAccountsTable)
    .where(
      and(
        eq(tradingAccountsTable.userId, userId),
        eq(tradingAccountsTable.exchange, exchange),
        eq(tradingAccountsTable.status, "active"),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    res.status(404).json({ error: `No active ${exchange} account connected.` });
    return null;
  }
  return rows[0];
}

// GET /broker-accounts/:exchange/info
router.get("/broker-accounts/:exchange/info", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const row = await getAccount(req.session.userId!, req.params.exchange, res);
  if (!row) return;

  // For paper mode: return simulated balance (sum from paper trades)
  if (row.mode === "paper") {
    res.json({
      equity: row.balance ? parseFloat(row.balance) : 0,
      cash: row.balance ? parseFloat(row.balance) : 0,
      buyingPower: row.balance ? parseFloat(row.balance) : 0,
      portfolioValue: row.balance ? parseFloat(row.balance) : 0,
      currency: "USD",
      mode: "paper",
      exchange: row.exchange,
    });
    return;
  }

  try {
    const client = getBrokerClient(row);
    const account = await client.getAccount();
    res.json({ ...account, exchange: row.exchange });
  } catch (err: any) {
    logger.warn({ err, exchange: req.params.exchange }, "Broker getAccount error");
    res.status(502).json({ error: `${req.params.exchange} error: ${err?.message}` });
  }
});

// GET /broker-accounts/:exchange/positions
router.get("/broker-accounts/:exchange/positions", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const row = await getAccount(req.session.userId!, req.params.exchange, res);
  if (!row) return;

  // Paper: return positions from local trades DB
  if (row.mode === "paper") {
    const trades = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.userId, req.session.userId!), eq(tradesTable.mode, "paper")));
    // Aggregate by symbol
    const map = new Map<string, { qty: number; cost: number; side: string }>();
    for (const t of trades) {
      const qty = parseFloat(t.quantity);
      const price = parseFloat(t.price);
      const cur = map.get(t.symbol) ?? { qty: 0, cost: 0, side: "long" };
      if (t.side === "buy") {
        cur.qty += qty;
        cur.cost += qty * price;
      } else {
        cur.qty -= qty;
        cur.cost -= qty * price;
      }
      map.set(t.symbol, cur);
    }
    const positions = [];
    for (const [symbol, pos] of map) {
      if (pos.qty <= 0) continue;
      const ticker = await getTicker(symbol).catch(() => null);
      const currentPrice = ticker?.price ?? 0;
      const avgEntry = pos.cost / pos.qty;
      const marketValue = pos.qty * currentPrice;
      const pnl = marketValue - pos.cost;
      positions.push({ symbol, side: "long", qty: pos.qty, avgEntryPrice: avgEntry, currentPrice, marketValue, unrealizedPl: pnl, unrealizedPlPct: pos.cost > 0 ? (pnl / pos.cost) * 100 : 0 });
    }
    res.json(positions);
    return;
  }

  try {
    const client = getBrokerClient(row);
    const positions = await client.getPositions();
    res.json(positions);
  } catch (err: any) {
    logger.warn({ err, exchange: req.params.exchange }, "Broker getPositions error");
    res.status(502).json({ error: `${req.params.exchange} error: ${err?.message}` });
  }
});

// GET /broker-accounts/:exchange/orders
router.get("/broker-accounts/:exchange/orders", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const row = await getAccount(req.session.userId!, req.params.exchange, res);
  if (!row) return;

  // Paper: return from local trades table
  if (row.mode === "paper") {
    const trades = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.userId, req.session.userId!), eq(tradesTable.mode, "paper")));
    res.json(trades.map(t => ({
      id: String(t.id),
      symbol: t.symbol,
      side: t.side,
      type: "market",
      qty: parseFloat(t.quantity),
      filledQty: parseFloat(t.quantity),
      filledAvgPrice: parseFloat(t.price),
      status: t.status,
      limitPrice: null,
      submittedAt: t.createdAt.toISOString(),
      filledAt: t.filledAt?.toISOString() ?? null,
    })));
    return;
  }

  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const client = getBrokerClient(row);
    const orders = await client.getOrders(limit);
    res.json(orders);
  } catch (err: any) {
    logger.warn({ err, exchange: req.params.exchange }, "Broker getOrders error");
    res.status(502).json({ error: `${req.params.exchange} error: ${err?.message}` });
  }
});

// POST /broker-accounts/:exchange/orders
router.post("/broker-accounts/:exchange/orders", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  if (rejectOrderPlacement(res, req.session.userId!, req.params.exchange)) return;
  const row = await getAccount(req.session.userId!, req.params.exchange, res);
  if (!row) return;

  const { symbol, side, type = "market", qty, limitPrice } = req.body;
  if (!symbol || !side || !qty) {
    res.status(400).json({ error: "symbol, side, and qty are required" });
    return;
  }

  // Paper mode: insert into local trades DB
  if (row.mode === "paper") {
    const ticker = await getTicker(symbol).catch(() => null);
    const price = limitPrice ?? ticker?.price ?? 0;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
    const [trade] = await db.insert(tradesTable).values({
      userId: req.session.userId!,
      symbol,
      side,
      quantity: String(qty),
      price: String(price),
      total: String(qty * price),
      status: "filled",
      mode: "paper",
      filledAt: new Date(),
    }).returning();
    logger.info({ exchange: row.exchange, symbol, side, qty, mode: "paper" }, "Paper order placed via broker");
    res.status(201).json({
      id: String(trade.id),
      symbol: trade.symbol,
      side: trade.side,
      type,
      qty,
      filledQty: qty,
      filledAvgPrice: price,
      status: "filled",
      limitPrice: limitPrice ?? null,
      submittedAt: trade.createdAt.toISOString(),
      filledAt: trade.filledAt?.toISOString() ?? null,
    });
    return;
  }

  try {
    const client = getBrokerClient(row);
    const order = await client.placeOrder({ symbol, side, type, qty: parseFloat(qty), limitPrice });
    logger.info({ exchange: row.exchange, symbol, side, qty, orderId: order.id }, "Live order placed");
    res.status(201).json(order);
  } catch (err: any) {
    logger.warn({ err, exchange: req.params.exchange }, "Broker placeOrder error");
    res.status(400).json({ error: `Order failed: ${err?.message}` });
  }
});

// DELETE /broker-accounts/:exchange/orders/:orderId
router.delete("/broker-accounts/:exchange/orders/:orderId", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const row = await getAccount(req.session.userId!, req.params.exchange, res);
  if (!row) return;

  if (row.mode === "paper") {
    res.status(400).json({ error: "Cannot cancel paper trades" });
    return;
  }

  try {
    const client = getBrokerClient(row);
    await client.cancelOrder(req.params.orderId);
    res.sendStatus(204);
  } catch (err: any) {
    logger.warn({ err, exchange: req.params.exchange }, "Broker cancelOrder error");
    res.status(400).json({ error: `Cancel failed: ${err?.message}` });
  }
});

export default router;
