import { logger } from "./logger";
import { assertOrderPlacementQuarantined } from "./order-quarantine";

const PAPER_BASE = "https://paper-api.alpaca.markets";
const LIVE_BASE = "https://api.alpaca.markets";

export interface AlpacaAccount {
  id: string;
  status: string;
  currency: string;
  equity: string;
  cash: string;
  buying_power: string;
  portfolio_value: string;
  daytrade_count: number;
  pattern_day_trader: boolean;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  exchange: string;
  asset_class: string;
  avg_entry_price: string;
  qty: string;
  qty_available: string;
  side: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  unrealized_intraday_pl: string;
  unrealized_intraday_plpc: string;
  current_price: string;
  lastday_price: string;
  change_today: string;
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  created_at: string;
  updated_at: string;
  submitted_at: string;
  filled_at: string | null;
  expired_at: string | null;
  canceled_at: string | null;
  asset_id: string;
  symbol: string;
  asset_class: string;
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  order_class: string;
  order_type: string;
  type: string;
  side: string;
  time_in_force: string;
  limit_price: string | null;
  stop_price: string | null;
  status: string;
  extended_hours: boolean;
}

export interface AlpacaOrderInput {
  symbol: string;         // e.g. "BTC/USD"
  qty?: string;           // quantity in asset units
  notional?: string;      // dollar amount instead of qty
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  time_in_force: "gtc" | "ioc" | "day";
  limit_price?: string;
  stop_price?: string;
}

export class AlpacaClient {
  private baseUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    public readonly mode: "paper" | "live",
  ) {
    this.baseUrl = mode === "paper" ? PAPER_BASE : LIVE_BASE;
  }

  private get headers() {
    return {
      "APCA-API-KEY-ID": this.apiKey,
      "APCA-API-SECRET-KEY": this.apiSecret,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: { ...this.headers, ...(options.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`Alpaca ${res.status}: ${body}`);
    }
    // 204 No Content
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  async getAccount(): Promise<AlpacaAccount> {
    return this.request<AlpacaAccount>("/v2/account");
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    return this.request<AlpacaPosition[]>("/v2/positions");
  }

  async getOrders(limit = 50): Promise<AlpacaOrder[]> {
    return this.request<AlpacaOrder[]>(`/v2/orders?status=all&limit=${limit}&direction=desc`);
  }

  async placeOrder(order: AlpacaOrderInput): Promise<AlpacaOrder> {
    void order;
    assertOrderPlacementQuarantined("AlpacaClient.placeOrder");
  }

  async cancelOrder(orderId: string): Promise<void> {
    return this.request<void>(`/v2/orders/${orderId}`, { method: "DELETE" });
  }
}

/** Validate Alpaca credentials by attempting a real account fetch. Returns the account on success. */
export async function validateAlpacaKeys(
  apiKey: string,
  apiSecret: string,
  mode: "paper" | "live",
): Promise<AlpacaAccount> {
  const client = new AlpacaClient(apiKey, apiSecret, mode);
  const account = await client.getAccount();
  logger.info({ mode, status: account.status }, "Alpaca credentials validated");
  return account;
}

/** Convert our symbol format (BTC-USDT) to Alpaca format (BTC/USD). */
export function toAlpacaSymbol(symbol: string): string {
  // BTC-USDT -> BTC/USD  (Alpaca trades vs USD)
  return symbol.replace("-USDT", "/USD").replace("-USDC", "/USD");
}

/** Convert Alpaca symbol format (BTC/USD or BTCUSD) to our format (BTC-USDT). */
export function fromAlpacaSymbol(symbol: string): string {
  return symbol.replace("/USD", "-USDT").replace("USD", "-USDT");
}
