export const ORDER_PLACEMENT_QUARANTINE_MESSAGE =
  "Live order placement is quarantined: the execution gateway runs in dry-run only.";

export const EXECUTION_DRY_RUN_NOTICE =
  "Broker-bound rules run in dry-run: the intended order is validated and logged, but nothing is sent to the broker.";

export const EXECUTION_KILL_SWITCH_MESSAGE =
  "The execution kill switch is engaged, so no order intent is accepted (paper included).";

export function assertOrderPlacementQuarantined(source: string): never {
  throw new Error(`${ORDER_PLACEMENT_QUARANTINE_MESSAGE} Source: ${source}.`);
}
