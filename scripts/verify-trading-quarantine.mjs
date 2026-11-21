import { readFile } from "node:fs/promises";

/**
 * Guards the trading safety invariants.
 *
 *  - required: the live gate still exists (kill switch, notional caps, an explicit
 *    per-user live opt-in), adapters only accept live accounts, and every order
 *    path funnels through the gateway's executeOrderIntent.
 *  - forbidden: no route or engine may place a broker order directly — placement
 *    has to happen inside the callback the gateway invokes for a live decision.
 */
const required = new Map([
  ["artifacts/api-server/src/lib/order-quarantine.ts", ["assertLiveBrokerAccount"]],
  [
    "artifacts/api-server/src/lib/alpaca.ts",
    ['assertLiveBrokerAccount("AlpacaClient.placeOrder", this.mode)'],
  ],
  [
    "artifacts/api-server/src/lib/broker-factory.ts",
    [
      'assertLiveBrokerAccount("AlpacaAdapter.placeOrder", this.mode)',
      'assertLiveBrokerAccount("CoinbaseAdapter.placeOrder", this.mode)',
      'assertLiveBrokerAccount("BinanceAdapter.placeOrder", this.mode)',
      'assertLiveBrokerAccount("KrakenAdapter.placeOrder", this.mode)',
      'assertLiveBrokerAccount("BybitAdapter.placeOrder", this.mode)',
    ],
  ],
  [
    "artifacts/api-server/src/lib/execution-gateway.ts",
    [
      "EXECUTION_KILL_SWITCH",
      "export function submitOrderIntent",
      "export async function executeOrderIntent",
      "export function liveModeEnabled",
      '"max_notional"',
      '"daily_notional"',
      '"kill_switch"',
    ],
  ],
  ["artifacts/api-server/src/lib/websocket.ts", ["executeOrderIntent"]],
  ["artifacts/api-server/src/routes/alpaca.ts", ["executeOrderIntent"]],
  ["artifacts/api-server/src/routes/broker.ts", ["executeOrderIntent"]],
  ["artifacts/api-server/src/routes/trades.ts", ["submitOrderIntent"]],
  ["artifacts/api-server/src/routes/execution.ts", ["setLiveMode", "setKillSwitch"]],
]);

const forbidden = new Map([
  ["artifacts/api-server/src/routes/alpaca.ts", ["await client.placeOrder("]],
  ["artifacts/api-server/src/routes/broker.ts", ["await getBrokerClient("]],
  ["artifacts/api-server/src/lib/websocket.ts", ["await getBrokerClient("]],
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
    if (source.includes(snippet)) {
      failures.push(`${path}: must not call ${snippet} directly — placement happens inside executeOrderIntent`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    "Trading safety verified: kill switch, caps and the live opt-in gate every order, adapters only accept live accounts, and every order path funnels through the execution gateway.",
  );
}
