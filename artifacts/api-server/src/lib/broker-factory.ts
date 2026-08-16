/**
 * Factory — given a DB trading account row, return the right broker client.
 * Exposes a common BrokerClient interface for order routing.
 */
import { AlpacaClient } from "./alpaca";
import { CoinbaseClient } from "./coinbase";
import { BinanceClient, toBinanceSymbol } from "./binance";
import { KrakenPrivateClient } from "./kraken-private";
import { BybitClient, toBybitSymbol } from "./bybit";
import { assertOrderPlacementQuarantined } from "./order-quarantine";

export interface BrokerOrderInput {
  symbol: string;    // our format: BTC-USDT
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: number;
  limitPrice?: number;
}

export interface BrokerOrderResult {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  qty: number;
  status: string;
  submittedAt: string;
}

export interface BrokerAccount {
  equity: number;
  cash: number;
  buyingPower: number;
  portfolioValue: number;
  currency: string;
  mode: string;
}

export interface BrokerPosition {
  symbol: string;
  side: "long" | "short";
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
}

export interface BrokerOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  qty: number;
  filledQty: number;
  filledAvgPrice: number | null;
  status: string;
  limitPrice: number | null;
  submittedAt: string;
  filledAt: string | null;
}

interface AccountRow {
  exchange: string;
  apiKey: string;
  apiSecret: string;
  mode: string;
}

export function getBrokerClient(row: AccountRow) {
  const mode = (row.mode === "live" ? "live" : "paper") as "paper" | "live";
  switch (row.exchange) {
    case "alpaca":
      return new AlpacaAdapter(row.apiKey, row.apiSecret, mode);
    case "coinbase":
      return new CoinbaseAdapter(row.apiKey, row.apiSecret, mode);
    case "binance":
      return new BinanceAdapter(row.apiKey, row.apiSecret, mode);
    case "kraken":
      return new KrakenAdapter(row.apiKey, row.apiSecret, mode);
    case "bybit":
      return new BybitAdapter(row.apiKey, row.apiSecret, mode);
    default:
      throw new Error(`Unknown exchange: ${row.exchange}`);
  }
}

// ── Adapters ──────────────────────────────────────────────────────────────────

class AlpacaAdapter {
  private client: AlpacaClient;
  constructor(apiKey: string, apiSecret: string, public readonly mode: "paper" | "live") {
    this.client = new AlpacaClient(apiKey, apiSecret, mode);
  }
  async getAccount(): Promise<BrokerAccount> {
    const a = await this.client.getAccount();
    return { equity: parseFloat(a.equity), cash: parseFloat(a.cash), buyingPower: parseFloat(a.buying_power), portfolioValue: parseFloat(a.portfolio_value), currency: a.currency, mode: this.mode };
  }
  async getPositions(): Promise<BrokerPosition[]> {
    const ps = await this.client.getPositions();
    return ps.map(p => ({ symbol: p.symbol, side: p.side as "long" | "short", qty: parseFloat(p.qty), avgEntryPrice: parseFloat(p.avg_entry_price), currentPrice: parseFloat(p.current_price), marketValue: parseFloat(p.market_value), unrealizedPl: parseFloat(p.unrealized_pl), unrealizedPlPct: parseFloat(p.unrealized_plpc) * 100 }));
  }
  async getOrders(limit = 50): Promise<BrokerOrder[]> {
    const os = await this.client.getOrders(limit);
    return os.map(o => ({ id: o.id, symbol: o.symbol, side: o.side as "buy" | "sell", type: o.type, qty: parseFloat(o.qty), filledQty: parseFloat(o.filled_qty), filledAvgPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : null, status: o.status, limitPrice: o.limit_price ? parseFloat(o.limit_price) : null, submittedAt: o.submitted_at, filledAt: o.filled_at ?? null }));
  }
  async placeOrder(input: BrokerOrderInput): Promise<BrokerOrderResult> {
    void input;
    assertOrderPlacementQuarantined("AlpacaAdapter.placeOrder");
  }
  async cancelOrder(orderId: string): Promise<void> { await this.client.cancelOrder(orderId); }
}

class CoinbaseAdapter {
  private client: CoinbaseClient;
  constructor(apiKey: string, apiSecret: string, public readonly mode: "paper" | "live") {
    this.client = new CoinbaseClient(apiKey, apiSecret, mode);
  }
  async getAccount(): Promise<BrokerAccount> { const a = await this.client.getAccount(); return { ...a, mode: this.mode }; }
  async getPositions(): Promise<BrokerPosition[]> { return this.client.getPositions(); }
  async getOrders(limit = 50): Promise<BrokerOrder[]> { return this.client.getOrders(limit); }
  async placeOrder(input: BrokerOrderInput): Promise<BrokerOrderResult> { void input; assertOrderPlacementQuarantined("CoinbaseAdapter.placeOrder"); }
  async cancelOrder(orderId: string): Promise<void> { await this.client.cancelOrder(orderId); }
}

class BinanceAdapter {
  private client: BinanceClient;
  constructor(apiKey: string, apiSecret: string, public readonly mode: "paper" | "live") {
    this.client = new BinanceClient(apiKey, apiSecret, mode);
  }
  async getAccount(): Promise<BrokerAccount> { const a = await this.client.getAccount(); return { ...a, mode: this.mode }; }
  async getPositions(): Promise<BrokerPosition[]> { return this.client.getPositions(); }
  async getOrders(limit = 50): Promise<BrokerOrder[]> { return this.client.getOrders(limit); }
  async placeOrder(input: BrokerOrderInput): Promise<BrokerOrderResult> { void input; assertOrderPlacementQuarantined("BinanceAdapter.placeOrder"); }
  async cancelOrder(orderId: string): Promise<void> { await this.client.cancelOrder(orderId); }
}

class KrakenAdapter {
  private client: KrakenPrivateClient;
  constructor(apiKey: string, apiSecret: string, public readonly mode: "paper" | "live") {
    this.client = new KrakenPrivateClient(apiKey, apiSecret, mode);
  }
  async getAccount(): Promise<BrokerAccount> { const a = await this.client.getAccount(); return { ...a, mode: this.mode }; }
  async getPositions(): Promise<BrokerPosition[]> { return this.client.getPositions(); }
  async getOrders(limit = 50): Promise<BrokerOrder[]> { return this.client.getOrders(limit); }
  async placeOrder(input: BrokerOrderInput): Promise<BrokerOrderResult> { void input; assertOrderPlacementQuarantined("KrakenAdapter.placeOrder"); }
  async cancelOrder(orderId: string): Promise<void> { await this.client.cancelOrder(orderId); }
}

class BybitAdapter {
  private client: BybitClient;
  constructor(apiKey: string, apiSecret: string, public readonly mode: "paper" | "live") {
    this.client = new BybitClient(apiKey, apiSecret, mode);
  }
  async getAccount(): Promise<BrokerAccount> { const a = await this.client.getAccount(); return { ...a, mode: this.mode }; }
  async getPositions(): Promise<BrokerPosition[]> { return this.client.getPositions(); }
  async getOrders(limit = 50): Promise<BrokerOrder[]> { return this.client.getOrders(limit); }
  async placeOrder(input: BrokerOrderInput): Promise<BrokerOrderResult> { void input; assertOrderPlacementQuarantined("BybitAdapter.placeOrder"); }
  async cancelOrder(orderId: string): Promise<void> { await this.client.cancelOrder(orderId); }
}
