import { logger } from "./logger";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

export class StrategyEngineError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 502,
  ) {
    super(message);
    this.name = "StrategyEngineError";
  }
}

interface StrategyEngineRequestInit {
  method?: "GET" | "POST";
  body?: unknown;
}

async function requestStrategyEngine<T>(
  path: string,
  init: StrategyEngineRequestInit = {},
): Promise<T> {
  const token = process.env.STRATEGY_ENGINE_API_ACCESS_TOKEN;
  if (!token) {
    throw new StrategyEngineError("Strategy engine is not configured", 503);
  }

  const baseUrl = process.env.STRATEGY_ENGINE_BASE_URL ?? DEFAULT_BASE_URL;
  const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    logger.warn({ err: error, path }, "Strategy engine request failed");
    throw new StrategyEngineError("Strategy engine is unavailable");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    logger.warn(
      { path, statusCode: response.status, detail },
      "Strategy engine returned an error",
    );
    throw new StrategyEngineError(
      `Strategy engine request failed with status ${response.status}`,
      response.status === 401 ? 503 : response.status,
    );
  }

  return response.json() as Promise<T>;
}

export interface StrategyEngineHealth {
  status: string;
  mode: string;
}

export interface StrategySummary {
  name: string;
  version: string;
}

export function getStrategyEngineHealth(): Promise<StrategyEngineHealth> {
  return requestStrategyEngine<StrategyEngineHealth>("/health");
}

export function getStrategies(): Promise<{ strategies: StrategySummary[] }> {
  return requestStrategyEngine<{ strategies: StrategySummary[] }>(
    "/strategies",
  );
}

/** OHLCV bar forwarded to the engine in the exact shape it expects. */
export interface AnalystBar {
  symbol: string;
  asset_class: "stocks" | "crypto";
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Raw engine payload (snake_case) — mapped into the DB row by the route. */
export interface AnalystIntent {
  intent_id: string;
  symbol: string;
  asset_class: string;
  side: "buy" | "sell";
  quantity: number;
  order_type: string;
  reference_price: number;
  stop_loss: number;
  take_profit: number;
  confidence: number;
  thesis: string;
  strategy_name: string;
  strategy_version: string;
  mode: string;
  generated_at: string;
  indicators: Record<string, number>;
}

export interface AnalystResponse {
  intent: AnalystIntent | null;
  note: string;
  strategy: { name: string; version: string };
}

/**
 * Ask the analyst for a proposal. `mode` is pinned to "paper": the engine has no
 * order-submission endpoint, and V1 only permits analysis, dry_run and paper.
 */
export function generateTradeIntent(payload: {
  symbol: string;
  asset_class: "stocks" | "crypto";
  bars: AnalystBar[];
  mode: "paper";
  equity: number;
}): Promise<AnalystResponse> {
  return requestStrategyEngine<AnalystResponse>("/api/v1/analyst/intents", {
    method: "POST",
    body: payload,
  });
}
