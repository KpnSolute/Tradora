import { readFile } from "node:fs/promises";

const requiredGuards = new Map([
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
    "artifacts/api-server/src/routes/alpaca.ts",
    ["ORDER_PLACEMENT_QUARANTINE_MESSAGE"],
  ],
  [
    "artifacts/api-server/src/routes/broker.ts",
    ["ORDER_PLACEMENT_QUARANTINE_MESSAGE"],
  ],
  [
    "artifacts/api-server/src/lib/websocket.ts",
    ['assertOrderPlacementQuarantined("WebSocket automation execution")'],
  ],
]);

const failures = [];
for (const [path, snippets] of requiredGuards) {
  const source = await readFile(path, "utf8");
  for (const snippet of snippets) {
    if (!source.includes(snippet)) failures.push(`${path}: missing ${snippet}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    "Trading quarantine verified across all five live-capable paths.",
  );
}
