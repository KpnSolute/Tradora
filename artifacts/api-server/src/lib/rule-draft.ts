/**
 * AI rule-builder draft pipeline: prompt → upstream call → JSON → validated rule.
 *
 * Deliberately free of express, the database and the logger so
 * scripts/test-rule-builder.mjs can drive every success and failure branch
 * against scripts/mock-model-server.mjs without a real model key.
 */
import {
  callChat,
  extractContent,
  parseDraftJson,
  upstreamMessage,
  type ResolvedProvider,
} from "./ai-provider.ts";
import { validateRuleInput, type AutomationRuleInput } from "./automation-rules.ts";
import { EXECUTION_DRY_RUN_NOTICE } from "./order-quarantine.ts";

export interface DraftOptions {
  prompt: string;
  mode: "create" | "edit";
  currentRule?: unknown;
  /** Symbols the rule may reference (server-side allowlist). */
  symbols: string[];
  /** Brokers the trader actually has connected (plus "paper"). */
  allowedBrokers: string[];
  connectedBrokers: string[];
  provider: ResolvedProvider;
}

export interface DraftSuccess {
  ok: true;
  rule: AutomationRuleInput;
  explanation: string;
  warnings: string[];
  model: string;
  endpoint: string;
  usedResponseFormat: boolean;
  attempts: number;
  streamed: boolean;
}

export interface DraftFailure {
  ok: false;
  kind: "upstream" | "shape" | "non_json" | "invalid_rule";
  /** HTTP status the route should return. */
  status: number;
  message: string;
  detail?: string;
  endpoint: string;
  model: string;
  upstreamStatus?: number;
}

export type DraftResult = DraftSuccess | DraftFailure;

export function systemPrompt(symbols: string[], brokers: string[]): string {
  return [
    "You convert a trader's plain-English instruction into ONE automation rule for the Tradora terminal.",
    "Reply with a single JSON object and nothing else, shaped exactly like:",
    `{"rule":{"symbol":string,"condition":"gte"|"lte","triggerPrice":number,"side":"buy"|"sell","quantity":number,"orderType":"market"|"limit","limitPrice":number|null,"broker":${JSON.stringify(brokers)}},"explanation":string,"warnings":string[]}`,
    "",
    "Rules:",
    `- symbol must be one of: ${symbols.join(", ")}.`,
    "- condition 'lte' means price drops to/below triggerPrice; 'gte' means price rises to/above.",
    "- quantity is in units of the base asset and must be positive.",
    "- orderType 'limit' requires a positive limitPrice; 'market' requires limitPrice null.",
    "- broker must be one the trader has connected, or 'paper'. Prefer 'paper' unless the trader names a broker.",
    `- Broker-bound rules do not send orders yet: ${EXECUTION_DRY_RUN_NOTICE} Mention that in warnings when broker is not 'paper'.`,
    "- explanation: one or two sentences describing exactly what the rule will do.",
    "- warnings: anything the trader should double-check (ambiguous price, size, broker). Empty array if none.",
    "- Never invent a symbol outside the allowed list. If the instruction is ambiguous, pick the most reasonable reading and add a warning.",
  ].join("\n");
}

function userMessage(options: DraftOptions): string {
  const { prompt, mode, currentRule, connectedBrokers } = options;
  return [
    `Trader's instruction: ${prompt}`,
    connectedBrokers.length > 0
      ? `Connected brokers: ${connectedBrokers.join(", ")}`
      : "The trader has no broker connected; use 'paper'.",
    mode === "edit" && currentRule
      ? `Existing rule to modify (return the complete updated rule):\n${JSON.stringify(currentRule)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function draftPayload(options: DraftOptions, responseFormat: boolean): Record<string, unknown> {
  return {
    model: options.provider.model,
    temperature: 0.2,
    max_tokens: 600,
    messages: [
      { role: "system", content: systemPrompt(options.symbols, options.allowedBrokers) },
      { role: "user", content: userMessage(options) },
    ],
    ...(responseFormat ? { response_format: { type: "json_object" } } : {}),
  };
}

/** A 400 that complains about JSON mode means the gateway wants the prompt-only path. */
export function isResponseFormatRejection(status: number, detail: string): boolean {
  return status === 400 && /response_format|json_object|json mode/i.test(detail);
}

export async function generateRuleDraft(options: DraftOptions): Promise<DraftResult> {
  const { provider } = options;

  if (!provider.configured) {
    return {
      ok: false,
      kind: "upstream",
      status: 503,
      message: `AI rule builder is not configured. Set ${provider.keyEnv} in the API service environment.`,
      endpoint: provider.endpoint,
      model: provider.model,
    };
  }

  let attempts = 0;
  let usedResponseFormat = true;
  let streamed = false;

  attempts += 1;
  let upstream = await callChat(provider, draftPayload(options, true));
  streamed = Boolean(upstream.streamed);

  if (!upstream.ok) {
    const detail = upstream.timedOut ? "request timed out after 30s" : upstreamMessage(upstream.body);
    if (!upstream.timedOut && isResponseFormatRejection(upstream.status, detail)) {
      attempts += 1;
      usedResponseFormat = false;
      upstream = await callChat(provider, draftPayload(options, false));
      streamed = Boolean(upstream.streamed);
    }
  }

  if (!upstream.ok) {
    const detail = upstream.timedOut
      ? "request timed out after 30s"
      : upstream.networkError
        ? `network error: ${upstream.networkError}`
        : upstreamMessage(upstream.body) || `HTTP ${upstream.status}`;

    return {
      ok: false,
      kind: "upstream",
      status: upstream.timedOut ? 504 : 502,
      message: `Rule builder model error (${upstream.status}): ${detail}`,
      detail,
      endpoint: provider.endpoint,
      model: provider.model,
      upstreamStatus: upstream.status,
    };
  }

  const content = extractContent(upstream.body);
  if (!content) {
    return {
      ok: false,
      kind: "shape",
      status: 502,
      message: "The rule builder gateway returned an unrecognised response shape.",
      detail: `top-level keys: ${Object.keys(upstream.body ?? {}).slice(0, 10).join(", ") || "none"}`,
      endpoint: provider.endpoint,
      model: provider.model,
    };
  }

  let parsed: any;
  try {
    parsed = parseDraftJson(content);
  } catch {
    return {
      ok: false,
      kind: "non_json",
      status: 422,
      message: "The model replied with something that was not JSON. Try rephrasing.",
      detail: `preview: ${content.slice(0, 200)}`,
      endpoint: provider.endpoint,
      model: provider.model,
    };
  }

  const validated = validateRuleInput(parsed?.rule);
  if ("error" in validated) {
    return {
      ok: false,
      kind: "invalid_rule",
      status: 422,
      message: `The model produced an unusable rule (${validated.error}). Try describing it differently.`,
      endpoint: provider.endpoint,
      model: provider.model,
    };
  }

  const warnings: string[] = Array.isArray(parsed?.warnings)
    ? parsed.warnings.filter((w: unknown): w is string => typeof w === "string").slice(0, 5)
    : [];

  let rule: AutomationRuleInput = validated;
  if (rule.broker !== "paper" && !options.connectedBrokers.includes(rule.broker)) {
    warnings.push(`You have no connected ${rule.broker} account, so this rule was set to paper.`);
    rule = { ...rule, broker: "paper" };
  }
  if (rule.broker !== "paper") {
    warnings.push(EXECUTION_DRY_RUN_NOTICE);
  }

  return {
    ok: true,
    rule,
    explanation: typeof parsed?.explanation === "string" ? parsed.explanation : "",
    warnings,
    model: provider.model,
    endpoint: provider.endpoint,
    usedResponseFormat,
    attempts,
    streamed,
  };
}
