import { readFile } from "node:fs/promises";

/**
 * Guards the trading safety invariants. Two kinds of check:
 *  - required: the live-capable adapters must still refuse, and every order route
 *    must funnel through the execution gateway.
 *  - forbidden: routes must never call a broker adapter's placeOrder directly.
 */
const required = new Map([
  [
    "artifacts/api-server/src/lib/alpaca.ts",
    ['assertOrderPlacementQuarantined("AlpacaClient.placeOrder")'],
  ],
  [
    "artifacts/api-server/src/lib/broker-factory.ts",
    [
      'assertOrderPlacementQuarantined("AlpacaAdapter.placeOrder")',
      'assertOrderPlacementQuarantined("CoinbaseAdapter.placeOrder")',
      'assertOrderPlacementQuarantined("BinanceAdapter.placeOrder")',
      'assertOrderPlacementQuarantined("KrakenAdapter.placeOrder")',
      'assertOrderPlacementQuarantined("BybitAdapter.placeOrder")',
    ],
  ],
  [
    "artifacts/api-server/src/lib/execution-gateway.ts",
    ["EXECUTION_KILL_SWITCH", '"live_quarantined"', "ORDER_PLACEMENT_QUARANTINE_MESSAGE", "export function submitOrderIntent"],
  ],
  ["artifacts/api-server/src/lib/websocket.ts", ["submitOrderIntent"]],
  ["artifacts/api-server/src/routes/alpaca.ts", ["submitOrderIntent"]],
  ["artifacts/api-server/src/routes/broker.ts", ["submitOrderIntent"]],
]);

const forbidden = new Map([
  ["artifacts/api-server/src/routes/alpaca.ts", ["client.placeOrder("]],
  ["artifacts/api-server/src/routes/broker.ts", ["client.placeOrder("]],
  ["artifacts/api-server/src/lib/websocket.ts", ["client.placeOrder("]],
]);

const failures = [];

for (const [path, snippets] of required) {
  const source = await readFile(path, "utf8");
  for (const snippet of snippets) {
    if (!source.includes(snippet)) failures.push(`${path}: missing ${snippet}`);
  }
}

for (const [path, snippets] of forbidden) {
  const source = await readFile(path, "utf8");
  for (const snippet of snippets) {
    if (source.includes(snippet)) failures.push(`${path}: must not call ${snippet} — orders go through the gateway`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    "Trading safety verified: adapters quarantined, every order path funnels through the execution gateway.",
  );
}
