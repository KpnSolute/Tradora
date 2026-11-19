/**
 * Shared validation for automation rules ("rule builder" rules).
 *
 * Used by POST/PATCH /automations and by the AI rule-builder endpoint so a draft
 * produced by the model is held to exactly the same contract as a hand-typed rule.
 */

export const VALID_CONDITIONS = ["gte", "lte"] as const;
export const VALID_SIDES = ["buy", "sell"] as const;
export const VALID_ORDER_TYPES = ["market", "limit"] as const;
export const VALID_BROKERS = ["paper", "alpaca", "coinbase", "binance", "kraken", "bybit"] as const;

export type AutomationCondition = (typeof VALID_CONDITIONS)[number];
export type AutomationSide = (typeof VALID_SIDES)[number];
export type AutomationOrderType = (typeof VALID_ORDER_TYPES)[number];
export type AutomationBroker = (typeof VALID_BROKERS)[number];

export interface AutomationRuleInput {
  symbol: string;
  condition: AutomationCondition;
  triggerPrice: number;
  side: AutomationSide;
  quantity: number;
  orderType: AutomationOrderType;
  limitPrice?: number;
  broker: AutomationBroker;
}

export function validateRuleInput(body: any): AutomationRuleInput | { error: string } {
  if (!body?.symbol || typeof body.symbol !== "string" || body.symbol.trim() === "") {
    return { error: "symbol is required" };
  }
  if (!VALID_CONDITIONS.includes(body.condition)) {
    return { error: `condition must be one of: ${VALID_CONDITIONS.join(", ")}` };
  }
  if (!VALID_SIDES.includes(body.side)) {
    return { error: `side must be one of: ${VALID_SIDES.join(", ")}` };
  }

  const triggerPrice = parseFloat(body.triggerPrice);
  if (!isFinite(triggerPrice) || triggerPrice <= 0) {
    return { error: "triggerPrice must be a positive number" };
  }
  const quantity = parseFloat(body.quantity);
  if (!isFinite(quantity) || quantity <= 0) {
    return { error: "quantity must be a positive number" };
  }

  const orderType: AutomationOrderType = VALID_ORDER_TYPES.includes(body.orderType)
    ? body.orderType
    : "market";

  if (orderType === "limit") {
    const lp = parseFloat(body.limitPrice);
    if (!isFinite(lp) || lp <= 0) {
      return { error: "limitPrice is required and must be positive when orderType is 'limit'" };
    }
  }

  const broker: AutomationBroker = VALID_BROKERS.includes(body.broker) ? body.broker : "paper";

  return {
    symbol: body.symbol.trim().toUpperCase(),
    condition: body.condition as AutomationCondition,
    triggerPrice,
    side: body.side as AutomationSide,
    quantity,
    orderType,
    limitPrice: orderType === "limit" ? parseFloat(body.limitPrice) : undefined,
    broker,
  };
}
