/**
 * Canonical execution safety gateway — the single funnel every order intent
 * passes through (REST broker routes, REST Alpaca routes, REST trades, the
 * automation engine).
 *
 * Order of enforcement:
 *
 *  1. Kill switch. `EXECUTION_KILL_SWITCH=1` (or POST /execution/kill-switch)
 *     refuses every intent, paper fills and live orders included. Default: off.
 *  2. Local paper fills are simulated in-process and are not capped.
 *  3. Broker-bound intents must be priceable, then clear the per-order and
 *     per-user-per-day notional caps.
 *  4. Live vs dry-run. A broker-bound intent is sent to the broker only when the
 *     account is a `live` account AND live mode is on for that user — either the
 *     operator switch (`EXECUTION_MODE=live` / `EXECUTION_LIVE_ENABLED=1`) or the
 *     account owner's runtime opt-in (POST /execution/live-mode). Otherwise it is
 *     a dry run: validated, capped, audited, and nothing is sent.
 *
 * `executeOrderIntent` is the entry point that can actually place an order; it
 * asks this module for the decision and only calls the caller's broker function
 * for a `live` decision. Every other outcome is returned untouched.
 *
 * Dependency-free on purpose (no express, no db, no broker clients) so routes,
 * the websocket engine and the test harness can all import it. The audit trail is
 * an in-memory ring buffer, so no migration is required.
 */
import {
  EXECUTION_KILL_SWITCH_MESSAGE,
  LIVE_EXECUTION_DISABLED_MESSAGE,
} from "./order-quarantine.ts";

export type ExecutionMode = "dry_run" | "live";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";

export interface OrderIntent {
  /** Where the intent came from, for the audit trail. */
  source: string;
  userId: number;
  /** Broker the order would be sent to (`paper` never leaves the process). */
  broker: string;
  /** The connected account's mode, as stored on the trading account row. */
  accountMode: "paper" | "live";
  /** True when the caller settles the order locally as a simulated paper fill. */
  localFill: boolean;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  limitPrice?: number;
  /** Caller-supplied dollar amount (Alpaca `notional` orders). */
  notional?: number;
  /** Last/limit price used to estimate notional for market orders. */
  referencePrice?: number;
}

export type BlockCode =
  | "invalid_order"
  | "kill_switch"
  | "max_notional"
  | "daily_notional"
  | "broker_rejected";

export type AuditOutcome =
  | "paper_local"
  | "dry_run"
  | "live"
  | "live_submitted"
  | "live_failed"
  | "blocked";

export interface AuditEntry {
  id: string;
  at: string;
  userId: number;
  source: string;
  broker: string;
  accountMode: "paper" | "live";
  symbol: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  limitPrice: number | null;
  notional: number | null;
  outcome: AuditOutcome;
  code?: BlockCode;
  message?: string;
  brokerOrderId?: string;
}

export type Decision =
  | { outcome: "paper_local"; audit: AuditEntry; notional: number | null }
  | { outcome: "dry_run"; audit: AuditEntry; notional: number | null; message: string }
  | { outcome: "live"; audit: AuditEntry; notional: number; message: string }
  | {
      outcome: "blocked";
      httpStatus: number;
      code: BlockCode;
      message: string;
      audit: AuditEntry | null;
    };

export type ExecutionResult<T = unknown> =
  | Exclude<Decision, { outcome: "live" }>
  | { outcome: "live"; audit: AuditEntry; notional: number; message: string; broker: T };

const AUDIT_LIMIT = 200;
const auditLog: AuditEntry[] = [];
const dailyNotional = new Map<number, { day: string; total: number }>();

/** `null` = follow the environment; a boolean = runtime override. */
let killSwitchOverride: boolean | null = null;

/** Per-user live opt-in. Absent means off; the environment can force it on. */
const liveOptIn = new Map<number, boolean>();

function envBool(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function executionMode(): ExecutionMode {
  const requested = (process.env.EXECUTION_LIVE_ENABLED ? "live" : process.env.EXECUTION_MODE ?? "")
    .trim()
    .toLowerCase();
  if (requested === "live") return "live";
  if (envBool(process.env.EXECUTION_LIVE_ENABLED)) return "live";
  return "dry_run";
}

/** Operator switch: the environment can enable live regardless of the per-user opt-in. */
export function liveEnabledByEnvironment(): boolean {
  return executionMode() === "live";
}

export function liveModeEnabled(userId: number): boolean {
  if (liveEnabledByEnvironment()) return true;
  return liveOptIn.get(userId) === true;
}

export function setLiveMode(userId: number, enabled: boolean): void {
  liveOptIn.set(userId, enabled);
}

export function killSwitchEngaged(): boolean {
  if (killSwitchOverride !== null) return killSwitchOverride;
  return envBool(process.env.EXECUTION_KILL_SWITCH);
}

function killSwitchSource(): "runtime" | "env" | "default" {
  if (killSwitchOverride !== null) return "runtime";
  return process.env.EXECUTION_KILL_SWITCH ? "env" : "default";
}

export function maxNotionalUsd(): number {
  return numberFromEnv(process.env.EXECUTION_MAX_NOTIONAL_USD, 1000);
}

export function dailyNotionalUsd(): number {
  return numberFromEnv(process.env.EXECUTION_DAILY_NOTIONAL_USD, 5000);
}

export function setKillSwitch(engaged: boolean): void {
  killSwitchOverride = engaged;
}

/** Test hook — clears runtime state without restarting the process. */
export function resetExecutionState(): void {
  killSwitchOverride = null;
  liveOptIn.clear();
  auditLog.length = 0;
  dailyNotional.clear();
}

export function executionStatus(userId: number, now = new Date()) {
  const liveOn = liveModeEnabled(userId);
  return {
    mode: liveOn ? "live" : "dry_run",
    liveEnabled: liveOn,
    liveSource: liveEnabledByEnvironment() ? "env" : liveOn ? "user" : "off",
    killSwitchEngaged: killSwitchEngaged(),
    killSwitchSource: killSwitchSource(),
    maxNotionalUsd: maxNotionalUsd(),
    dailyNotionalUsd: dailyNotionalUsd(),
    dailyNotionalUsedUsd: usedToday(userId, now),
    auditedIntents: auditLog.length,
    liveNotice: LIVE_EXECUTION_DISABLED_MESSAGE,
  };
}

export function recentAudit(userId: number, limit = 50): AuditEntry[] {
  return auditLog
    .filter(entry => entry.userId === userId)
    .slice(-Math.min(Math.max(limit, 1), AUDIT_LIMIT))
    .reverse();
}

function pushAudit(entry: AuditEntry): AuditEntry {
  auditLog.push(entry);
  if (auditLog.length > AUDIT_LIMIT) auditLog.splice(0, auditLog.length - AUDIT_LIMIT);
  return entry;
}

function markAudit(id: string, patch: Partial<AuditEntry>): void {
  const entry = auditLog.find(candidate => candidate.id === id);
  if (entry) Object.assign(entry, patch);
}

function newAuditId(): string {
  return `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function usedToday(userId: number, now = new Date()): number {
  const record = dailyNotional.get(userId);
  return record && record.day === dayKey(now) ? record.total : 0;
}

function addDailyNotional(userId: number, amount: number, now = new Date()): void {
  const today = dayKey(now);
  const record = dailyNotional.get(userId);
  dailyNotional.set(userId, {
    day: today,
    total: (record && record.day === today ? record.total : 0) + amount,
  });
}

function invalid(entry: Omit<AuditEntry, "id" | "at" | "outcome">, message: string): Decision {
  const audit = pushAudit({ ...entry, id: newAuditId(), at: new Date().toISOString(), outcome: "blocked", code: "invalid_order", message });
  return { outcome: "blocked", httpStatus: 400, code: "invalid_order", message, audit };
}

/**
 * Decide what happens to one order intent. Never performs I/O: callers act on
 * the decision (insert a paper fill for `paper_local`, report for `dry_run`,
 * place the order for `live`).
 */
export function submitOrderIntent(intent: OrderIntent, now = new Date()): Decision {
  const base = {
    userId: intent.userId,
    source: intent.source,
    broker: intent.broker,
    accountMode: intent.accountMode,
    symbol: String(intent.symbol ?? "").trim().toUpperCase(),
    side: intent.side,
    type: intent.type,
    qty: Number(intent.qty),
    limitPrice: intent.type === "limit" ? Number(intent.limitPrice) : null,
    notional: null as number | null,
  };

  if (!base.symbol) return invalid(base, "symbol is required");
  if (base.side !== "buy" && base.side !== "sell") return invalid(base, "side must be buy or sell");
  if (base.type !== "market" && base.type !== "limit") return invalid(base, "type must be market or limit");
  if (!Number.isFinite(base.qty) || base.qty <= 0) return invalid(base, "qty must be a positive number");
  if (base.type === "limit" && (!Number.isFinite(base.limitPrice!) || base.limitPrice! <= 0)) {
    return invalid(base, "limitPrice must be a positive number for a limit order");
  }

  const unitPrice =
    base.type === "limit"
      ? base.limitPrice!
      : Number(intent.referencePrice) > 0
        ? Number(intent.referencePrice)
        : null;
  const notional =
    Number(intent.notional) > 0 ? Number(intent.notional) : unitPrice !== null ? +(base.qty * unitPrice).toFixed(2) : null;
  base.notional = notional;

  const audit = (outcome: AuditOutcome, extra: Partial<AuditEntry> = {}): AuditEntry =>
    pushAudit({ ...base, id: newAuditId(), at: now.toISOString(), outcome, ...extra });

  // 1. Kill switch — applies to everything, paper included.
  if (killSwitchEngaged()) {
    return {
      outcome: "blocked",
      httpStatus: 503,
      code: "kill_switch",
      message: EXECUTION_KILL_SWITCH_MESSAGE,
      audit: audit("blocked", { code: "kill_switch", message: EXECUTION_KILL_SWITCH_MESSAGE }),
    };
  }

  // 2. Local paper fills are simulated locally, so they are not capped.
  if (intent.localFill) {
    return { outcome: "paper_local", audit: audit("paper_local"), notional };
  }

  // 3. A broker order we cannot price cannot be risk-checked, so it is refused
  //    rather than waved through — dry run or not.
  if (notional === null) {
    return {
      outcome: "blocked",
      httpStatus: 422,
      code: "invalid_order",
      message: "Cannot price this order, so it cannot be risk-checked. Use a limit price or retry when a quote is available.",
      audit: audit("blocked", {
        code: "invalid_order",
        message: "Cannot price this order; no limit or reference price.",
      }),
    };
  }

  const perOrderCap = maxNotionalUsd();
  if (notional > perOrderCap) {
    const message = `Order notional $${notional.toFixed(2)} exceeds the per-order cap of $${perOrderCap.toFixed(2)}.`;
    return {
      outcome: "blocked",
      httpStatus: 403,
      code: "max_notional",
      message,
      audit: audit("blocked", { code: "max_notional", message }),
    };
  }

  const dailyCap = dailyNotionalUsd();
  const used = usedToday(intent.userId, now);
  if (used + notional > dailyCap) {
    const message = `Order would take today's broker notional to $${(used + notional).toFixed(2)}, above the $${dailyCap.toFixed(2)} daily cap.`;
    return {
      outcome: "blocked",
      httpStatus: 403,
      code: "daily_notional",
      message,
      audit: audit("blocked", { code: "daily_notional", message }),
    };
  }

  addDailyNotional(intent.userId, notional, now);

  // 4. Live only for a live account with live mode on for this user.
  if (intent.accountMode === "live" && liveModeEnabled(intent.userId)) {
    const message = `Live ${base.side} ${base.qty} ${base.symbol} (${base.type}) routed to ${intent.broker}.`;
    return {
      outcome: "live",
      audit: audit("live", { message }),
      notional,
      message,
    };
  }

  const dryRunReason =
    intent.accountMode === "live"
      ? "live mode is off for this account"
      : "this broker account is in paper mode";
  const message = `Dry run (${dryRunReason}): intended ${base.side} ${base.qty} ${base.symbol} (${base.type}) for ${intent.broker} logged, nothing sent.`;
  return { outcome: "dry_run", audit: audit("dry_run", { message }), notional, message };
}

/**
 * The one way to place a broker order. It asks the gateway for a decision and
 * only invokes `place` for a `live` decision, then records what the broker said
 * (or why it refused) back onto the same audit entry.
 */
export async function executeOrderIntent<T>(
  intent: OrderIntent,
  place: (intent: OrderIntent) => Promise<T>,
  now = new Date(),
): Promise<ExecutionResult<T>> {
  const decision = submitOrderIntent(intent, now);
  if (decision.outcome !== "live") return decision;

  try {
    const broker = await place(intent);
    const brokerOrderId =
      broker && typeof broker === "object" && "id" in broker ? String((broker as { id?: unknown }).id ?? "") : "";
    markAudit(decision.audit.id, {
      outcome: "live_submitted",
      message: decision.message,
      ...(brokerOrderId ? { brokerOrderId } : {}),
    });
    return { ...decision, broker };
  } catch (err: any) {
    const message = `Broker rejected the order: ${err?.message ?? "unknown error"}`;
    markAudit(decision.audit.id, { outcome: "live_failed", code: "broker_rejected", message });
    return {
      outcome: "blocked",
      httpStatus: 502,
      code: "broker_rejected",
      message,
      audit: decision.audit,
    };
  }
}
