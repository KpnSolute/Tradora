/**
 * AI rule builder.
 *
 * POST /rule-builder/draft  → turns a natural-language description (and optionally
 *                             an existing rule to edit) into a validated automation
 *                             rule draft. Nothing is saved here; the client reviews
 *                             the draft and submits it to POST/PATCH /automations.
 * GET  /rule-builder/status → whether the model is configured, the effective
 *                             endpoint, and the hourly quota.
 *
 * The API key never leaves the server: the browser only ever sees the draft.
 */
import { Router, type IRouter } from "express";
import { db, tradingAccountsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { SUPPORTED_MARKETS } from "../lib/market-data";
import { validateRuleInput, VALID_BROKERS, type AutomationRuleInput } from "../lib/automation-rules";
import { ORDER_PLACEMENT_QUARANTINE_MESSAGE } from "../lib/order-quarantine";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function requireAuth(req: any, res: any): boolean {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  return true;
}

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * OpenAI-compatible chat endpoint. Both halves are configurable because the
 * gateway's path is not guaranteed to be `/chat/completions`:
 *   OPENAI_BASE_URL=https://freebuff.com/api/v1/paid
 *   OPENAI_CHAT_PATH=/chat/completions     (ignored if the base already ends in it)
 * If the gateway exposes the completion route at the base URL itself, set
 * OPENAI_CHAT_PATH="" to POST straight at the base.
 */
function resolveChatUrl(): string {
  const base = (process.env.OPENAI_BASE_URL ?? "https://freebuff.com/api/v1/paid").replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(base)) return base;
  const rawPath = process.env.OPENAI_CHAT_PATH;
  const path = rawPath === "" ? "" : (rawPath ?? "/chat/completions");
  const normalized = path === "" ? "" : path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

/** Host + path only — safe to surface in status output and logs (never the key). */
function chatEndpointLabel(): string {
  try {
    const u = new URL(resolveChatUrl());
    return `${u.origin}${u.pathname}`;
  } catch {
    return "invalid OPENAI_BASE_URL";
  }
}

/** Server-side allowlist — the browser can never choose a model. */
const ALLOWED_MODELS = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"];
const AI_MODEL = ALLOWED_MODELS.includes(process.env.RULE_BUILDER_MODEL ?? "")
  ? (process.env.RULE_BUILDER_MODEL as string)
  : "gpt-4o-mini";

const DRAFTS_PER_HOUR = 30;
const draftUsage = new Map<number, number[]>();

function recentDrafts(userId: number, now = Date.now()): number[] {
  const windowStart = now - 60 * 60 * 1000;
  return (draftUsage.get(userId) ?? []).filter(t => t > windowStart);
}

/** Does NOT consume quota — a failed upstream call must not count against the user. */
function checkQuota(userId: number): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  const hits = recentDrafts(userId, now);
  draftUsage.set(userId, hits);
  if (hits.length >= DRAFTS_PER_HOUR) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((hits[0] + 60 * 60 * 1000 - now) / 1000)) };
  }
  return { ok: true };
}

function recordDraft(userId: number): void {
  const now = Date.now();
  const hits = recentDrafts(userId, now);
  hits.push(now);
  draftUsage.set(userId, hits);
}

// ─── Upstream helpers ────────────────────────────────────────────────────────

/** Accept the common OpenAI-compatible response shapes. */
function extractContent(body: any): string | null {
  const message = body?.choices?.[0]?.message;
  if (typeof message?.content === "string" && message.content.trim() !== "") return message.content;
  if (Array.isArray(message?.content)) {
    const joined = message.content
      .map((part: any) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
    if (joined.trim() !== "") return joined;
  }
  if (typeof body?.output_text === "string" && body.output_text.trim() !== "") return body.output_text;
  return null;
}

/** Pull a human-readable reason out of an OpenAI-compatible error envelope. */
function upstreamMessage(body: any): string {
  const msg =
    body?.error?.message ??
    body?.message ??
    body?.error?.code ??
    (typeof body === "string" ? body : "");
  return String(msg ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Models often wrap JSON in a markdown fence; strip it before parsing. */
function parseDraftJson(content: string): any {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

interface UpstreamResult {
  ok: boolean;
  status: number;
  body: any;
  timedOut?: boolean;
  networkError?: string;
}

/**
 * Some gateways stream regardless of `stream: false`. Fold an SSE body back into a
 * single chat-completions shape so the caller sees one code path.
 */
function foldSse(raw: string): any | null {
  const chunks = raw.split(/\r?\n/).filter(line => line.startsWith("data:"));
  if (chunks.length === 0) return null;

  let content = "";
  let sawJson = false;
  for (const line of chunks) {
    const payload = line.replace(/^data:\s*/, "").trim();
    if (payload === "" || payload === "[DONE]") continue;
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    sawJson = true;
    const piece = event?.choices?.[0]?.delta?.content ?? event?.choices?.[0]?.message?.content;
    if (typeof piece === "string") content += piece;
  }
  if (!sawJson) return null;
  return { choices: [{ message: { content } }], streamed: true };
}

async function callModel(
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<UpstreamResult> {
  try {
    const res = await fetch(resolveChatUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text().catch(() => "");

    let body: any = null;
    if (contentType.includes("text/event-stream") || raw.trimStart().startsWith("data:")) {
      body = foldSse(raw);
    } else if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw.slice(0, 400);
      }
    }

    return { ok: res.ok, status: res.status, body };
  } catch (err: any) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, status: timedOut ? 504 : 502, body: null, timedOut, networkError: err?.message };
  }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

function systemPrompt(symbols: string[], brokers: string[]): string {
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
    `- Broker-bound rules cannot place real orders yet: ${ORDER_PLACEMENT_QUARANTINE_MESSAGE} Mention that in warnings when broker is not 'paper'.`,
    "- explanation: one or two sentences describing exactly what the rule will do.",
    "- warnings: anything the trader should double-check (ambiguous price, size, broker). Empty array if none.",
    "- Never invent a symbol outside the allowed list. If the instruction is ambiguous, pick the most reasonable reading and add a warning.",
  ].join("\n");
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get("/rule-builder/status", (req, res): void => {
  if (!requireAuth(req, res)) return;
  res.json({
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: AI_MODEL,
    draftsPerHour: DRAFTS_PER_HOUR,
    usedThisHour: recentDrafts(req.session.userId!, Date.now()).length,
    endpoint: chatEndpointLabel(),
    responseFormat: "json_object",
  });
});

router.post("/rule-builder/draft", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId!;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error: "AI rule builder is not configured. Set OPENAI_API_KEY in the API service environment.",
    });
    return;
  }

  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (prompt.length < 3) {
    res.status(400).json({ error: "Describe the rule in at least a few words." });
    return;
  }
  if (prompt.length > 2000) {
    res.status(400).json({ error: "Description is too long (2000 characters max)." });
    return;
  }

  const mode = req.body?.mode === "edit" ? "edit" : "create";
  const currentRule = req.body?.currentRule;
  if (mode === "edit" && (!currentRule || typeof currentRule !== "object")) {
    res.status(400).json({ error: "Editing needs the current rule." });
    return;
  }

  const quota = checkQuota(userId);
  if (!quota.ok) {
    res.status(429).json({
      error: `Rule builder limit reached (${DRAFTS_PER_HOUR}/hour). Try again in ${Math.ceil(quota.retryAfterSeconds / 60)} minutes.`,
    });
    return;
  }

  // Only brokers this user actually has can be used; everything else is 'paper'.
  const accounts = await db
    .select()
    .from(tradingAccountsTable)
    .where(and(eq(tradingAccountsTable.userId, userId), eq(tradingAccountsTable.status, "active")));
  const connected = Array.from(new Set(accounts.map(a => a.exchange))).filter(b =>
    VALID_BROKERS.includes(b as any),
  );
  const allowedBrokers = Array.from(new Set(["paper", ...connected]));
  const symbols = SUPPORTED_MARKETS.map(m => m.symbol);

  const userContent = [
    `Trader's instruction: ${prompt}`,
    connected.length > 0
      ? `Connected brokers: ${connected.join(", ")}`
      : "The trader has no broker connected; use 'paper'.",
    mode === "edit" && currentRule
      ? `Existing rule to modify (return the complete updated rule):\n${JSON.stringify(currentRule)}`
      : "",
  ].filter(Boolean).join("\n\n");

  const basePayload = {
    model: AI_MODEL,
    temperature: 0.2,
    max_tokens: 600,
    messages: [
      { role: "system", content: systemPrompt(symbols, allowedBrokers) },
      { role: "user", content: userContent },
    ],
  };

  // Prefer JSON mode, but fall back once if the gateway rejects response_format.
  let upstream = await callModel(apiKey, { ...basePayload, response_format: { type: "json_object" } });
  let usedResponseFormat = true;

  if (!upstream.ok && upstream.status === 400 && /response_format|json_object|json mode/i.test(upstreamMessage(upstream.body))) {
    logger.info({ endpoint: chatEndpointLabel() }, "Rule builder: gateway rejected response_format, retrying without it");
    upstream = await callModel(apiKey, basePayload);
    usedResponseFormat = false;
  }

  if (!upstream.ok) {
    const detail = upstream.timedOut
      ? "request timed out after 30s"
      : upstream.networkError
        ? `network error: ${upstream.networkError}`
        : upstreamMessage(upstream.body) || `HTTP ${upstream.status}`;

    logger.warn(
      { endpoint: chatEndpointLabel(), model: AI_MODEL, upstreamStatus: upstream.status, detail },
      "Rule builder upstream failure",
    );

    res.status(upstream.timedOut ? 504 : 502).json({
      error: `Rule builder model error (${upstream.status}): ${detail}`,
      upstreamStatus: upstream.status,
      upstreamDetail: detail,
      endpoint: chatEndpointLabel(),
      model: AI_MODEL,
    });
    return;
  }

  const content = extractContent(upstream.body);
  if (!content) {
    logger.warn(
      { endpoint: chatEndpointLabel(), keys: Object.keys(upstream.body ?? {}).slice(0, 10) },
      "Rule builder: unrecognised response shape",
    );
    res.status(502).json({
      error: "The rule builder gateway returned an unrecognised response shape.",
      endpoint: chatEndpointLabel(),
      model: AI_MODEL,
    });
    return;
  }

  let parsed: any;
  try {
    parsed = parseDraftJson(content);
  } catch {
    logger.warn(
      { endpoint: chatEndpointLabel(), preview: content.slice(0, 200) },
      "Rule builder: model returned non-JSON content",
    );
    res.status(422).json({
      error: "The model replied with something that was not JSON. Try rephrasing.",
      endpoint: chatEndpointLabel(),
    });
    return;
  }

  const validated = validateRuleInput(parsed?.rule);
  if ("error" in validated) {
    res.status(422).json({
      error: `The model produced an unusable rule (${validated.error}). Try describing it differently.`,
    });
    return;
  }

  const warnings: string[] = Array.isArray(parsed?.warnings)
    ? parsed.warnings.filter((w: unknown) => typeof w === "string").slice(0, 5)
    : [];

  let rule: AutomationRuleInput = validated;
  if (rule.broker !== "paper" && !connected.includes(rule.broker)) {
    warnings.push(`You have no connected ${rule.broker} account, so this rule was set to paper.`);
    rule = { ...rule, broker: "paper" };
  }
  if (rule.broker !== "paper") {
    warnings.push(ORDER_PLACEMENT_QUARANTINE_MESSAGE);
  }

  // Quota is only consumed by a draft the user could actually use.
  recordDraft(userId);

  logger.info({ userId, mode, symbol: rule.symbol, broker: rule.broker }, "Rule draft generated");
  res.json({
    rule,
    explanation: typeof parsed?.explanation === "string" ? parsed.explanation : "",
    warnings,
    model: AI_MODEL,
    usedResponseFormat,
  });
});

export default router;
