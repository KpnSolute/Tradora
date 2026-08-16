export const ORDER_PLACEMENT_QUARANTINE_MESSAGE =
  "Order placement is disabled pending the canonical safety gateway.";

export function assertOrderPlacementQuarantined(source: string): never {
  throw new Error(`${ORDER_PLACEMENT_QUARANTINE_MESSAGE} Source: ${source}.`);
}
