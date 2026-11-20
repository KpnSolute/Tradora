export const LIVE_EXECUTION_DISABLED_MESSAGE =
  "Live execution is off for this account: the gateway is in dry-run. Turn on live mode (and connect a live broker account) to send real orders.";

export const EXECUTION_DRY_RUN_NOTICE =
  "Broker-bound rules run in dry-run: the intended order is validated and logged, but nothing is sent to the broker.";

export const EXECUTION_KILL_SWITCH_MESSAGE =
  "The execution kill switch is engaged, so no order intent is accepted (paper included).";

/**
 * Guard used inside every broker adapter. The execution gateway is the only
 * caller, and it only reaches an adapter for an account whose stored mode is
 * `live` — so an adapter must never place an order on a paper account, and
 * nothing can route around the gateway's kill switch, caps and audit trail.
 */
export function assertLiveBrokerAccount(source: string, mode: string): void {
  if (mode !== "live") {
    throw new Error(
      `${source}: refusing to send an order for a ${mode} account. Live orders require a live-connected account.`,
    );
  }
}
