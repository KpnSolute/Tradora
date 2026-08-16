/**
 * WebSocket server (frontend clients) + Kraken WS v2 client (live market data).
 * Also hosts the automation engine: evaluates price-triggered rules on every tick.
 */
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { ServerResponse } from "http";
import { logger } from "./logger";
import { sessionMiddleware } from "./session";
import {
  SUPPORTED_MARKETS,
  updateTickerFromStream,
  fromKrakenWsSymbol,
  getTickers,
} from "./market-data";
import type { TickerData } from "./market-data";
import { db, automationsTable, tradesTable, tradingAccountsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getBrokerClient } from "./broker-factory";
import { getTicker } from "./market-data";
import { assertOrderPlacementQuarantined } from "./order-quarantine";

// ─── Frontend client subscriptions ───────────────────────────────────────────

interface SubscribedClient {
  ws: WebSocket;
  symbols: Set<string>;
  userId: number | null;
}

const clients: Set<SubscribedClient> = new Set();

// ─── Automation engine ────────────────────────────────────────────────────────

// Prevent double-firing a rule while it's being processed
const firingSet = new Set<number>();

async function evaluateAutomations(symbol: string, price: number): Promise<void> {
  try {
    const rules = await db
      .select()
      .from(automationsTable)
      .where(and(eq(automationsTable.symbol, symbol), eq(automationsTable.status, "active")));

    for (const rule of rules) {
      if (firingSet.has(rule.id)) continue;

      const trigger = parseFloat(rule.triggerPrice);
      const conditionMet =
        (rule.condition === "gte" && price >= trigger) ||
        (rule.condition === "lte" && price <= trigger);

      if (!conditionMet) continue;

      firingSet.add(rule.id);
      logger.info({ ruleId: rule.id, symbol, price, trigger, condition: rule.condition }, "Automation triggered");

      // Fire async — don't block the ticker broadcast
      fireAutomation(rule, price).finally(() => firingSet.delete(rule.id));
    }
  } catch (err) {
    logger.warn({ err }, "Automation evaluation error");
  }
}

async function fireAutomation(rule: any, currentPrice: number): Promise<void> {
  // Mark triggered immediately
  await db
    .update(automationsTable)
    .set({ status: "triggered", firedAt: new Date() })
    .where(eq(automationsTable.id, rule.id));

  try {
    assertOrderPlacementQuarantined("WebSocket automation execution");

    const qty = parseFloat(rule.quantity);
    const limitPrice = rule.limitPrice ? parseFloat(rule.limitPrice) : undefined;

    if (rule.broker === "paper") {
      // Paper: insert into local trades table
      const price = limitPrice ?? currentPrice;
      await db.insert(tradesTable).values({
        userId: rule.userId,
        symbol: rule.symbol,
        side: rule.side,
        quantity: String(qty),
        price: String(price),
        total: String(qty * price),
        status: "filled",
        mode: "paper",
        notes: `Auto: ${rule.condition === "gte" ? "≥" : "≤"} $${parseFloat(rule.triggerPrice).toFixed(2)}`,
        filledAt: new Date(),
      });
    } else {
      // Live: find user's connected broker account and place real order
      const rows = await db
        .select()
        .from(tradingAccountsTable)
        .where(
          and(
            eq(tradingAccountsTable.userId, rule.userId),
            eq(tradingAccountsTable.exchange, rule.broker),
            eq(tradingAccountsTable.status, "active"),
          ),
        )
        .limit(1);

      if (rows.length === 0) throw new Error(`No active ${rule.broker} account`);

      const accountRow = rows[0];
      const client = getBrokerClient(accountRow);
      await client.placeOrder({
        symbol: rule.symbol,
        side: rule.side,
        type: rule.orderType as "market" | "limit",
        qty,
        limitPrice,
      });
    }

    await db
      .update(automationsTable)
      .set({ status: "completed" })
      .where(eq(automationsTable.id, rule.id));

    logger.info({ ruleId: rule.id, broker: rule.broker, side: rule.side, qty: rule.quantity }, "Automation completed");

    broadcastToUser(rule.userId, {
      type: "automation_fired",
      ruleId: rule.id,
      symbol: rule.symbol,
      side: rule.side,
      quantity: rule.quantity,
      broker: rule.broker,
      triggerPrice: rule.triggerPrice,
      currentPrice,
    });
  } catch (err: any) {
    const failureReason: string = err?.message ?? "Unknown error";
    logger.warn({ err, ruleId: rule.id }, "Automation fire failed");
    await db
      .update(automationsTable)
      .set({ status: "failed", failureReason })
      .where(eq(automationsTable.id, rule.id));

    broadcastToUser(rule.userId, {
      type: "automation_failed",
      ruleId: rule.id,
      symbol: rule.symbol,
      side: rule.side,
      quantity: rule.quantity,
      broker: rule.broker,
      triggerPrice: rule.triggerPrice,
      failureReason,
    });
  }
}

// ─── Kraken WebSocket v2 public stream ────────────────────────────────────────

const KRAKEN_WS_URL = "wss://ws.kraken.com/v2";

function connectKrakenStream(): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket(KRAKEN_WS_URL);
  } catch (err) {
    logger.warn({ err }, "Failed to create Kraken WebSocket, retrying in 10s");
    setTimeout(connectKrakenStream, 10_000);
    return;
  }

  ws.on("open", () => {
    logger.info("Kraken WS v2 connected — subscribing to live tickers");
    const symbols = SUPPORTED_MARKETS.map(m => m.wsSymbol);
    ws.send(JSON.stringify({
      method: "subscribe",
      params: { channel: "ticker", symbol: symbols },
    }));
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg.channel || msg.channel !== "ticker" || !msg.data) return;
      if (msg.type !== "snapshot" && msg.type !== "update") return;

      const now = new Date().toISOString();

      for (const d of msg.data as Array<{
        symbol: string; last: number; change: number; change_pct: number;
        high: number; low: number; volume: number; vwap?: number;
      }>) {
        const ourSymbol = fromKrakenWsSymbol(d.symbol);
        if (!ourSymbol) continue;

        const ticker: TickerData = {
          symbol:       ourSymbol,
          price:        d.last,
          change24h:    d.change,
          changePct24h: d.change_pct,
          volume24h:    d.volume,
          high24h:      d.high,
          low24h:       d.low,
          marketCap:    null,
          updatedAt:    now,
        };

        updateTickerFromStream(ticker);
        broadcastTicker(ticker);

        // Automation engine — non-blocking
        evaluateAutomations(ourSymbol, d.last).catch(() => {});
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on("error", (err) => {
    logger.warn({ err }, "Kraken WebSocket error");
  });

  ws.on("close", (code, reason) => {
    logger.info({ code, reason: reason.toString() }, "Kraken WS closed — reconnecting in 5s");
    setTimeout(connectKrakenStream, 5_000);
  });
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

function broadcastToUser(userId: number, payload: object): void {
  if (clients.size === 0) return;
  const msg = JSON.stringify(payload);
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.userId !== userId) continue;
    try { client.ws.send(msg); } catch { /* ignore */ }
  }
}

function broadcastTicker(ticker: TickerData): void {
  if (clients.size === 0) return;
  const payload = JSON.stringify({
    type:         "ticker",
    symbol:       ticker.symbol,
    price:        ticker.price,
    change24h:    ticker.change24h,
    changePct24h: ticker.changePct24h,
    high24h:      ticker.high24h,
    low24h:       ticker.low24h,
    volume24h:    ticker.volume24h,
  });
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (!client.symbols.has(ticker.symbol)) continue;
    try { client.ws.send(payload); } catch { /* ignore */ }
  }
}

async function sendInitialTickers(client: SubscribedClient): Promise<void> {
  const tickers = await getTickers();
  for (const symbol of client.symbols) {
    const ticker = tickers.get(symbol);
    if (!ticker) continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    try {
      client.ws.send(JSON.stringify({
        type: "ticker", symbol: ticker.symbol, price: ticker.price,
        change24h: ticker.change24h, changePct24h: ticker.changePct24h,
        high24h: ticker.high24h, low24h: ticker.low24h, volume24h: ticker.volume24h,
      }));
    } catch { /* ignore */ }
  }
}

// ─── Public: create the server-side WebSocket handler ────────────────────────

/** Run express-session middleware against a plain IncomingMessage so we can read req.session.userId. */
function parseSession(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    // express-session expects (req, res, next); we pass a minimal fake res
    const fakeRes = new ServerResponse(req);
    sessionMiddleware(req as any, fakeRes as any, () => resolve());
  });
}

export function createWebSocketServer(server: import("http").Server): WebSocketServer {
  connectKrakenStream();

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    // Authenticate: derive userId from the session cookie, never from the client payload
    await parseSession(req);
    const sessionUserId: number | null = (req as any).session?.userId ?? null;

    logger.info({ ip: req.socket.remoteAddress, userId: sessionUserId }, "Frontend WS client connected");
    const client: SubscribedClient = { ws, symbols: new Set(), userId: sessionUserId };
    clients.add(client);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "subscribe" && Array.isArray(msg.symbols)) {
          client.symbols = new Set<string>(msg.symbols);
          // userId is already set from the session; ignore any client-provided value
          logger.info({ symbols: [...client.symbols], userId: client.userId }, "Client subscribed");
          sendInitialTickers(client);
        }
        if (msg.type === "unsubscribe" && Array.isArray(msg.symbols)) {
          for (const s of msg.symbols) client.symbols.delete(s);
        }
      } catch (err) {
        logger.warn({ err }, "Invalid WS message from frontend client");
      }
    });

    ws.on("close", () => { clients.delete(client); logger.info("Frontend WS client disconnected"); });
    ws.on("error", (err) => { logger.warn({ err }, "Frontend WS error"); clients.delete(client); });
  });

  return wss;
}
