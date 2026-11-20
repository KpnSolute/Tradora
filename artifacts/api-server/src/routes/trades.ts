import { Router, type IRouter } from "express";
import { db, tradesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { CreateTradeBody } from "@workspace/api-zod";
import { getTicker } from "../lib/market-data";
import { submitOrderIntent } from "../lib/execution-gateway";

const router: IRouter = Router();

function requireAuth(req: any, res: any): boolean {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  return true;
}

function serializeTrade(t: any) {
  return {
    id: t.id,
    userId: t.userId,
    symbol: t.symbol,
    side: t.side,
    quantity: parseFloat(t.quantity),
    price: parseFloat(t.price),
    total: t.total != null ? parseFloat(t.total) : null,
    status: t.status,
    mode: t.mode,
    notes: t.notes ?? null,
    createdAt: t.createdAt,
    filledAt: t.filledAt ?? null,
  };
}

router.get("/trades", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId!;

  const trades = await db.select().from(tradesTable).where(eq(tradesTable.userId, userId));
  res.json(trades.map(serializeTrade));
});

router.post("/trades", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId!;

  const parsed = CreateTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { symbol, side, quantity, price: userPrice, notes } = parsed.data;

  // Use the provided limit price or the live quote. A simulated fill is never
  // booked at a price we do not actually have.
  const price = userPrice ?? (await getTicker(symbol))?.price ?? 0;
  if (!Number.isFinite(price) || price <= 0) {
    res.status(422).json({
      error: "No live price for this market right now, so the fill cannot be priced. Try again in a moment.",
      code: "unpriced",
    });
    return;
  }

  // Local paper fills still go through the execution gateway, so the kill switch
  // and the audit trail cover every order intent — this one included.
  const decision = submitOrderIntent({
    source: "rest:trades",
    userId,
    broker: "paper",
    accountMode: "paper",
    localFill: true,
    symbol,
    side,
    type: userPrice ? "limit" : "market",
    qty: quantity,
    limitPrice: userPrice ?? undefined,
    referencePrice: price,
  });

  if (decision.outcome === "blocked") {
    res.status(decision.httpStatus).json({
      error: decision.message,
      code: decision.code,
      auditId: decision.audit?.id ?? null,
    });
    return;
  }

  const total = quantity * price;
  const now = new Date();

  const [trade] = await db.insert(tradesTable).values({
    userId,
    symbol,
    side,
    quantity: String(quantity),
    price: String(price),
    total: String(total),
    status: "filled",
    mode: "paper",
    notes: notes ?? null,
    filledAt: now,
  }).returning();

  res.status(201).json({ ...serializeTrade(trade), auditId: decision.audit.id });
});

router.get("/trades/:id", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [trade] = await db.select().from(tradesTable).where(
    and(eq(tradesTable.id, id), eq(tradesTable.userId, userId))
  );
  if (!trade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  res.json(serializeTrade(trade));
});

export default router;
