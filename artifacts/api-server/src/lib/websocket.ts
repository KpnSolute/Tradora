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
  refreshTickersFromRest,
  startTickerWatchdog,
} from "./market-data";
import type { TickerData } from "./market-data";
import { db, automationsTable, tradesTable, tradingAccountsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getTicker, resolveMarket, streamRequestSymbols } from "./market-data";
import { executeOrderIntent, submitOrderIntent } from "./execution-gateway";
import { getBrokerClient } from "./broker-factory";

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
  let dryRun = false;
  let intentMessage: string | undefined;
  let liveOrder: { id: string; status: string } | null = null;

  // Mark triggered immediately
  await db
    .update(automationsTable)
    .set({ status: "triggered", firedAt: new Date() })
    .where(eq(automationsTable.id, rule.id));

  try {
    const qty = parseFloat(rule.quantity);
    const limitPrice = rule.limitPrice ? parseFloat(rule.limitPrice) : undefined;

    if (rule.broker === "paper") {
      // Paper fills are simulated locally, but they still pass the gateway so the
      // kill switch stops them and the fill lands in the audit trail.
      const decision = submitOrderIntent({
        source: "automation:paper",
        userId: rule.userId,
        broker: "paper",
        accountMode: "paper",
        localFill: true,
        symbol: rule.symbol,
        side: rule.side,
        type: rule.orderType === "limit" ? "limit" : "market",
        qty,
        limitPrice,
        referencePrice: currentPrice,
      });
      if (decision.outcome !== "paper_local") throw new Error(decision.message);

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
      // Broker-bound rules go through the execution gateway: the intended order is
      // validated, notional-capped and written to the audit trail. Live execution is
      // still quarantined, so dry_run is the only outcome that gets this far.
      const accountRows = await db
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

      if (accountRows.length === 0) throw new Error("No active " + rule.broker + " account");

      const accountRow = accountRows[0];
      const decision = await executeOrderIntent(
        {
          source: "automation",
          userId: rule.userId,
          broker: rule.broker,
          accountMode: accountRow.mode === "live" ? "live" : "paper",
          localFill: false,
          symbol: rule.symbol,
          side: rule.side,
          type: rule.orderType === "limit" ? "limit" : "market",
          qty,
          limitPrice,
          referencePrice: currentPrice,
        },
        intent =>
          getBrokerClient(accountRow).placeOrder({
            symbol: intent.symbol,
            side: intent.side,
            type: intent.type,
            qty: intent.qty,
            limitPrice: intent.limitPrice,
          }),
      );

      if (decision.outcome === "blocked") throw new Error(decision.message);
      if (decision.outcome === "dry_run") {
        dryRun = true;
        intentMessage = decision.message;
      }
      if (decision.outcome === "live") {
        const placed = decision.broker as any;
        liveOrder = { id: String(placed?.id ?? ""), status: String(placed?.status ?? "submitted") };
        intentMessage = decision.message;
      }
    }

    await db
      .update(automationsTable)
      .set({ status: "completed" })
      .where(eq(automationsTable.id, rule.id));

    logger.info(
      { ruleId: rule.id, broker: rule.broker, side: rule.side, qty: rule.quantity, dryRun, liveOrder },
      "Automation completed",
    );

    broadcastToUser(rule.userId, {
      type: "automation_fired",
      ruleId: rule.id,
      symbol: rule.symbol,
      side: rule.side,
      quantity: rule.quantity,
      broker: rule.broker,
      triggerPrice: rule.triggerPrice,
      currentPrice,
      dryRun,
      liveOrder,
      intentMessage,
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

// ─── Kraken subscriptions ─────────────────────────────────────────────────────

// The default pairs are always streamed; discovered tokens are added on demand so
// a token you find also ticks live and its automations can trigger.
let krakenStream: WebSocket | null = null;
const streamedPairs = new Set<string>();

async function ensureStreamed(symbols: string[]): Promise<void> {
  const wanted: string[] = [];
  for (const symbol of symbols) {
    const meta = await resolveMarket(symbol);
    if (!meta || streamedPairs.has(meta.wsSymbol)) continue;
    streamedPairs.add(meta.wsSymbol);
    wanted.push(meta.wsSymbol);
  }
  if (wanted.length === 0) return;

  if (krakenStream?.readyState === WebSocket.OPEN) {
    krakenStream.send(JSON.stringify({
      method: "subscribe",
      params: { channel: "ticker", symbol: wanted },
    }));
    logger.info({ pairs: wanted }, "Subscribed to additional Kraken tickers");
  } else {
    // Not connected: forget them so the next connect subscribes to everything again.
    for (const pair of wanted) streamedPairs.delete(pair);
  }
}

// Sweep rule symbols that may not be in the stream (a rule can watch any listed
// token), so an automation still fires on a token nobody is subscribed to.
async function sweepAutomations(): Promise<void> {
  try {
    const rules = await db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.status, "active"));
    const symbols = [...new Set(rules.map(rule => rule.symbol))];
    if (symbols.length === 0) return;

    await ensureStreamed(symbols);
    for (const symbol of symbols) {
      const ticker = await getTicker(symbol);
      if (ticker) await evaluateAutomations(symbol, ticker.price);
    }
  } catch (err) {
    logger.warn({ err }, "Automation sweep error");
  }
}

function startAutomationSweep(intervalMs = 20_000): void {
  setInterval(() => { sweepAutomations().catch(() => {}); }, intervalMs);
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
    krakenStream = ws;
    streamedPairs.clear();
    const symbols = [...new Set([
      ...SUPPORTED_MARKETS.map(m => m.symbol),
      ...streamRequestSymbols(),
    ])];
    ensureStreamed(symbols).catch(err => logger.warn({ err }, "Kraken subscribe failed"));
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
    krakenStream = null;
    streamedPairs.clear();
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
    updatedAt:    ticker.updatedAt,
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
        updatedAt: ticker.updatedAt,
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
  // Price the cache from Kraken REST before anything can be served, so a cold
  // start answers with a real quote instead of a placeholder. The watchdog then
  // refetches whenever the stream goes quiet, so prices never sit frozen.
  void refreshTickersFromRest();
  startTickerWatchdog();
  startAutomationSweep();
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
          // A discovered token needs a live stream too, not just a REST snapshot.
          ensureStreamed([...client.symbols]).catch(() => {});
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
