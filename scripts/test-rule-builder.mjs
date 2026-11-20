/**
 * Keyless regression tests for the AI rule builder and the execution gateway.
 *
 *   node scripts/test-rule-builder.mjs          # mock model, no API key needed
 *   node scripts/test-rule-builder.mjs --live   # one real draft via OPENROUTER_API_KEY
 *
 * The draft tests import the API's own source (Node strips the types), so they
 * cover the real transport, folding, retry and validation code — not a copy.
 * The gateway tests prove the kill switch is off by default, dry-run covers every
 * broker-bound intent, and each intended order lands in the audit trail.
 */
import { startMockModelServer } from "./mock-model-server.mjs";
import { resolveProvider } from "../artifacts/api-server/src/lib/ai-provider.ts";
import { generateRuleDraft } from "../artifacts/api-server/src/lib/rule-draft.ts";
import {
  executionStatus,
  recentAudit,
  resetExecutionState,
  setKillSwitch,
  submitOrderIntent,
} from "../artifacts/api-server/src/lib/execution-gateway.ts";

const LIVE = process.argv.includes("--live");
const SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT"];

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function checkEqual(name, actual, expected) {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── Draft pipeline (mock model, no key) ─────────────────────────────────────

async function draftWith(provider, prompt, extra = {}) {
  return generateRuleDraft({
    prompt,
    mode: "create",
    symbols: SYMBOLS,
    allowedBrokers: ["paper"],
    connectedBrokers: [],
    provider,
    ...extra,
  });
}

async function runDraftTests() {
  const mock = await startMockModelServer({ port: 0, quiet: true });
  const provider = resolveProvider({
    RULE_BUILDER_PROVIDER: "mock",
    MOCK_MODEL_BASE_URL: mock.url,
    MOCK_MODEL_API_KEY: "test-key-not-secret",
  });

  console.log(`\nAI draft path — mock model at ${mock.url}`);
  check("mock provider resolves and is configured", provider.configured && provider.name === "mock");

  const plainPrompt = "buy 1 BTC-USDT when price rises above 65000";

  // ── Success shapes ──
  const plain = await draftWith(provider, plainPrompt);
  check("plain JSON response produces a validated rule", plain.ok, JSON.stringify(plain).slice(0, 200));
  if (plain.ok) {
    checkEqual("draft symbol", plain.rule.symbol, "BTC-USDT");
    checkEqual("draft side", plain.rule.side, "buy");
    checkEqual("draft triggerPrice", plain.rule.triggerPrice, 65000);
    checkEqual("draft condition", plain.rule.condition, "gte");
    checkEqual("draft used response_format", plain.usedResponseFormat, true);
    checkEqual("draft needed one attempt", plain.attempts, 1);
    check("draft reports the endpoint", plain.endpoint.endsWith("/chat/completions"), plain.endpoint);
  }

  const fenced = await draftWith(provider, `${plainPrompt} [scenario:fenced]`);
  check("markdown-fenced JSON is unwrapped", fenced.ok && fenced.rule.symbol === "BTC-USDT", JSON.stringify(fenced).slice(0, 160));

  const sse = await draftWith(provider, `${plainPrompt} [scenario:sse]`);
  check("streamed SSE body is folded back into one message", sse.ok && sse.rule.symbol === "BTC-USDT", JSON.stringify(sse).slice(0, 160));
  if (sse.ok) check("folded SSE is reported as streamed", sse.streamed === true);

  const parts = await draftWith(provider, `${plainPrompt} [scenario:parts]`);
  check("array-shaped content parts are joined", parts.ok && parts.rule.symbol === "BTC-USDT", JSON.stringify(parts).slice(0, 160));

  const outputText = await draftWith(provider, `${plainPrompt} [scenario:output_text]`);
  check("output_text responses are accepted", outputText.ok && outputText.rule.symbol === "BTC-USDT", JSON.stringify(outputText).slice(0, 160));

  const sell = await draftWith(provider, "sell 2 ETH-USDT when price drops below 2400");
  check(
    "sell/below instructions survive the round trip",
    sell.ok && sell.rule.side === "sell" && sell.rule.condition === "lte" && sell.rule.quantity === 2,
    JSON.stringify(sell).slice(0, 200),
  );

  // ── Failure branches ──
  await fetch(`${mock.url}/__reset`, { method: "POST" });
  const rejected = await draftWith(provider, `${plainPrompt} [scenario:reject_response_format]`);
  const afterRetry = await (await fetch(`${mock.url}/__stats`)).json();
  check("gateway rejecting response_format is retried without it", rejected.ok && rejected.usedResponseFormat === false, JSON.stringify(rejected).slice(0, 200));
  checkEqual("retry hit the gateway twice", afterRetry.requests, 2);

  const nonJson = await draftWith(provider, `${plainPrompt} [scenario:invalid_json]`);
  check("non-JSON reply is a 422", nonJson.ok === false && nonJson.status === 422 && nonJson.kind === "non_json", JSON.stringify(nonJson).slice(0, 200));

  const badRule = await draftWith(provider, `${plainPrompt} [scenario:invalid_rule]`);
  check(
    "invalid rule is a 422 naming the field",
    badRule.ok === false && badRule.status === 422 && badRule.kind === "invalid_rule" && /quantity/.test(badRule.message),
    JSON.stringify(badRule).slice(0, 200),
  );

  const emptyShape = await draftWith(provider, `${plainPrompt} [scenario:empty]`);
  check("empty content is reported as a shape error", emptyShape.ok === false && emptyShape.status === 502 && emptyShape.kind === "shape", JSON.stringify(emptyShape).slice(0, 200));

  const upstream500 = await draftWith(provider, `${plainPrompt} [scenario:server_error]`);
  check(
    "upstream 500 is a diagnosable 502",
    upstream500.ok === false && upstream500.status === 502 && upstream500.upstreamStatus === 500 && /mock upstream exploded/.test(upstream500.detail ?? ""),
    JSON.stringify(upstream500).slice(0, 240),
  );

  const unconfigured = await draftWith(
    resolveProvider({ RULE_BUILDER_PROVIDER: "mock", MOCK_MODEL_BASE_URL: mock.url }),
    plainPrompt,
  );
  check(
    "missing key is a 503 that names the env var",
    unconfigured.ok === false && unconfigured.status === 503 && /MOCK_MODEL_API_KEY/.test(unconfigured.message),
    JSON.stringify(unconfigured).slice(0, 200),
  );

  const wrongKey = await draftWith(
    resolveProvider({ RULE_BUILDER_PROVIDER: "mock", MOCK_MODEL_BASE_URL: mock.url, MOCK_MODEL_API_KEY: "x" }),
    `${plainPrompt} [scenario:no_key]`,
  );
  check(
    "upstream 401 is surfaced with the upstream status",
    wrongKey.ok === false && wrongKey.upstreamStatus === 401 && /invalid API key/.test(wrongKey.detail ?? ""),
    JSON.stringify(wrongKey).slice(0, 240),
  );

  // ── Provider defaults ──
  const openrouter = resolveProvider({ OPENROUTER_API_KEY: "sk-or-test" });
  checkEqual("OpenRouter is selected when OPENROUTER_API_KEY is set", openrouter.name, "openrouter");
  checkEqual("OpenRouter base URL", openrouter.chatUrl, "https://openrouter.ai/api/v1/chat/completions");
  checkEqual("OpenRouter default model", openrouter.model, "openai/gpt-4o-mini");
  check("OpenRouter attribution headers are sent", openrouter.extraHeaders["X-Title"] === "Tradora");
  checkEqual(
    "OPENROUTER_BASE_URL overrides the endpoint",
    resolveProvider({ OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: "https://proxy.test/v1/" }).chatUrl,
    "https://proxy.test/v1/chat/completions",
  );
  checkEqual(
    "off-list RULE_BUILDER_MODEL falls back to the provider default",
    resolveProvider({ OPENROUTER_API_KEY: "k", RULE_BUILDER_MODEL: "not/a-real-model" }).model,
    "openai/gpt-4o-mini",
  );
  checkEqual(
    "allow-listed RULE_BUILDER_MODEL is honoured",
    resolveProvider({ OPENROUTER_API_KEY: "k", RULE_BUILDER_MODEL: "anthropic/claude-3.5-haiku" }).model,
    "anthropic/claude-3.5-haiku",
  );

  await mock.close();
}

// ─── Execution gateway ───────────────────────────────────────────────────────

function runGatewayTests() {
  console.log("\nExecution gateway");

  delete process.env.EXECUTION_KILL_SWITCH;
  delete process.env.EXECUTION_MODE;
  delete process.env.EXECUTION_MAX_NOTIONAL_USD;
  delete process.env.EXECUTION_DAILY_NOTIONAL_USD;
  resetExecutionState();

  const status = executionStatus();
  checkEqual("default mode is dry_run", status.mode, "dry_run");
  checkEqual("kill switch is off by default", status.killSwitchEngaged, false);
  checkEqual("live execution is disabled", status.liveEnabled, false);

  const intent = (over = {}) => ({
    source: "test",
    userId: 1,
    broker: "alpaca",
    accountMode: "live",
    localFill: false,
    symbol: "BTC-USDT",
    side: "buy",
    type: "limit",
    qty: 0.01,
    limitPrice: 60000,
    ...over,
  });

  const dry = submitOrderIntent(intent());
  check("broker-bound intent is accepted as a dry run", dry.outcome === "dry_run", JSON.stringify(dry).slice(0, 200));
  if (dry.outcome === "dry_run") {
    checkEqual("dry-run notional is priced", dry.notional, 600);
    check("dry-run message says nothing was sent", /nothing sent/.test(dry.message), dry.message);
    check("dry run returns an audit id", typeof dry.audit.id === "string" && dry.audit.id.startsWith("ord_"));
  }

  const audited = recentAudit(1);
  check("intended order is written to the audit trail", audited.length === 1 && audited[0].outcome === "dry_run");
  if (audited[0]) {
    checkEqual("audit records the symbol", audited[0].symbol, "BTC-USDT");
    checkEqual("audit records the broker", audited[0].broker, "alpaca");
    checkEqual("audit records the notional", audited[0].notional, 600);
  }

  const paper = submitOrderIntent(
    intent({ broker: "paper", accountMode: "paper", localFill: true, qty: 20, limitPrice: 100000 }),
  );
  check("local paper fills still settle (not capped)", paper.outcome === "paper_local", JSON.stringify(paper).slice(0, 200));
  checkEqual("paper fill is audited too", recentAudit(1)[0].outcome, "paper_local");

  const overCap = submitOrderIntent(intent({ qty: 1, limitPrice: 60000 }));
  check(
    "per-order notional cap blocks and explains",
    overCap.outcome === "blocked" && overCap.code === "max_notional" && overCap.httpStatus === 403,
    JSON.stringify(overCap).slice(0, 200),
  );

  process.env.EXECUTION_MAX_NOTIONAL_USD = "5000";
  process.env.EXECUTION_DAILY_NOTIONAL_USD = "1000";
  submitOrderIntent(intent({ userId: 2 }));
  const overDaily = submitOrderIntent(intent({ userId: 2 }));
  check(
    "daily notional cap blocks the second order",
    overDaily.outcome === "blocked" && overDaily.code === "daily_notional",
    JSON.stringify(overDaily).slice(0, 200),
  );
  delete process.env.EXECUTION_MAX_NOTIONAL_USD;
  delete process.env.EXECUTION_DAILY_NOTIONAL_USD;

  const unpriced = submitOrderIntent(intent({ type: "market", limitPrice: undefined, referencePrice: undefined }));
  check(
    "unpriceable market order is refused",
    unpriced.outcome === "blocked" && unpriced.code === "invalid_order" && unpriced.httpStatus === 422,
    JSON.stringify(unpriced).slice(0, 200),
  );

  const badQty = submitOrderIntent(intent({ qty: 0 }));
  check("non-positive quantity is refused", badQty.outcome === "blocked" && badQty.code === "invalid_order");

  setKillSwitch(true);
  const killed = submitOrderIntent(intent());
  const killedPaper = submitOrderIntent(intent({ broker: "paper", localFill: true }));
  check(
    "engaged kill switch blocks broker intents",
    killed.outcome === "blocked" && killed.code === "kill_switch" && killed.httpStatus === 503,
    JSON.stringify(killed).slice(0, 200),
  );
  check("engaged kill switch blocks paper fills too", killedPaper.outcome === "blocked");
  checkEqual("kill switch state is reported", executionStatus().killSwitchEngaged, true);
  checkEqual("kill switch source is the runtime override", executionStatus().killSwitchSource, "runtime");

  setKillSwitch(false);
  process.env.EXECUTION_MODE = "live";
  const live = submitOrderIntent(intent());
  check(
    "live mode is still refused by the quarantine",
    live.outcome === "blocked" && live.code === "live_quarantined" && /quarantined/i.test(live.message),
    JSON.stringify(live).slice(0, 200),
  );
  delete process.env.EXECUTION_MODE;

  process.env.EXECUTION_KILL_SWITCH = "1";
  resetExecutionState(); // drop the runtime override so the env var decides
  const envStatus = executionStatus();
  checkEqual("EXECUTION_KILL_SWITCH=1 engages the switch from the environment", envStatus.killSwitchEngaged, true);
  checkEqual("kill switch source is reported as the environment", envStatus.killSwitchSource, "env");
  delete process.env.EXECUTION_KILL_SWITCH;
  resetExecutionState();
}

// ─── Optional live run against a real provider ───────────────────────────────

async function runLiveTest() {
  if (!LIVE) return;
  const provider = resolveProvider();
  console.log(`\nLive draft against ${provider.name} (${provider.endpoint}, ${provider.model})`);

  if (!provider.configured) {
    console.log(`  SKIP  no key configured — set ${provider.keyEnv} (or pass RULE_BUILDER_PROVIDER)`);
    return;
  }

  const result = await draftWith(provider, "buy 0.001 BTC-USDT when price drops below 58000");
  if (result.ok) {
    console.log(`  PASS  live draft: ${JSON.stringify(result.rule)} (attempts=${result.attempts})`);
  } else {
    failures += 1;
    console.error(`  FAIL  live draft: ${result.message} (status ${result.status}, upstream ${result.upstreamStatus ?? "n/a"})`);
  }
  checks += 1;
}

// ─── Main ────────────────────────────────────────────────────────────────────

try {
  await runDraftTests();
  runGatewayTests();
  await runLiveTest();
} catch (err) {
  failures += 1;
  console.error("\nTest harness crashed:", err);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log("AI draft path and execution gateway OK.");
}
