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

async function requestStrategyEngine<T>(path: string): Promise<T> {
  const token = process.env.STRATEGY_ENGINE_API_ACCESS_TOKEN;
  if (!token) {
    throw new StrategyEngineError("Strategy engine is not configured", 503);
  }

  const baseUrl = process.env.STRATEGY_ENGINE_BASE_URL ?? DEFAULT_BASE_URL;
  const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
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
