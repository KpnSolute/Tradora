/**
 * Exchanges whose credentials are a single opaque token (no internal newlines).
 */
const SINGLE_TOKEN_EXCHANGES = new Set(["alpaca", "binance", "kraken", "bybit"]);

/** Labels a dashboard or shell snippet may prepend when a credential is copied. */
const PASTED_LABEL =
  /^(APCA-API-SECRET-KEY|APCA-API-KEY-ID|ALPACA_API_SECRET|ALPACA_SECRET_KEY|ALPACA_API_KEY|API_SECRET|SECRET_KEY|API_KEY|SECRET|KEY|ENDPOINT)\s*[:=]\s*/i;

/**
 * Broker credentials are pasted out of a dashboard, so they routinely arrive with a
 * trailing newline from the textarea, surrounding quotes, or a copied label such as
 * `APCA-API-KEY-ID: PK...` / `ALPACA_SECRET_KEY=...`. Alpaca (and Binance/Bybit)
 * answer any of those with a bare 401 that is indistinguishable from a wrong key, so
 * normalise before validating. Coinbase secrets are PEM blocks: only their outer
 * whitespace is trimmed, their internal newlines are significant.
 */
export function normalizeCredential(value: string, exchange: string): string {
  const outer = value.trim().replace(/^["'`]|["'`]$/g, "").trim();
  if (!SINGLE_TOKEN_EXCHANGES.has(exchange)) return outer;
  return outer.replace(PASTED_LABEL, "").replace(/\s+/g, "");
}
