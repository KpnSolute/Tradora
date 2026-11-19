/**
 * AI rule builder.
 *
 * POST /rule-builder/draft  → turns a natural-language description (and optionally
 *                             an existing rule to edit) into a validated automation
 *                             rule draft. Nothing is saved here; the client reviews
 *                             the draft and submits it to POST/PATCH /automations.
 * GET  /rule-builder/status → whether the model is configured, and the quota.
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

/** OpenAI-compatible endpoint; override with OPENAI_BASE_URL if you self-host one. */
const AI_BASE_URL = (process.env.OPENAI_BASE_URL ?? "https://freebuff.com/api/v1/paid").replace(/\/+$/, "");
/** Server-side allowlist — the browser can never choose a model. */
const ALLOWED_MODELS = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"];
const AI_MODEL = ALLOWED_MODELS.includes(process.env.RULE_BUILDER_MODEL ?? "")
  ? (process.env.RULE_BUILDER_MODEL as string)
  : "gpt-4o-mini";

const DRAFTS_PER_HOUR = 30;
const draftUsage = new Map<number, number[]>();

function takeDraftQuota(userId: number): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const hits = (draftUsage.get(userId) ?? []).filter(t => t > windowStart);
  if (hits.length >= DRAFTS_PER_HOUR) {
    draftUsage.set(userId, hits);
    return { ok: false, retryAfterSeconds: Math.ceil((hits[0] + 60 * 60 * 1000 - now) / 1000) };
  }
  hits.push(now);
  draftUsage.set(userId, hits);
  return { ok: true };
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

  const quota = takeDraftQuota(userId);
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

  let draft: any;
  try {
    const upstream = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: 0.2,
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt(symbols, allowedBrokers) },
          { role: "user", content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const body: any = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      logger.warn({ status: upstream.status, body }, "Rule builder upstream error");
      res.status(502).json({ error: `Rule builder model error (${upstream.status}).` });
      return;
    }

    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      res.status(502).json({ error: "The model returned an empty draft. Try rephrasing." });
      return;
    }
    draft = JSON.parse(content);
  } catch (err: any) {
    logger.warn({ err }, "Rule builder request failed");
    res.status(502).json({ error: `Rule builder unavailable: ${err?.message ?? "unknown error"}` });
    return;
  }

  const validated = validateRuleInput(draft?.rule);
  if ("error" in validated) {
    res.status(422).json({
      error: `The model produced an unusable rule (${validated.error}). Try describing it differently.`,
    });
    return;
  }

  const warnings: string[] = Array.isArray(draft?.warnings)
    ? draft.warnings.filter((w: unknown) => typeof w === "string").slice(0, 5)
    : [];

  let rule: AutomationRuleInput = validated;
  if (rule.broker !== "paper" && !connected.includes(rule.broker)) {
    warnings.push(`You have no connected ${rule.broker} account, so this rule was set to paper.`);
    rule = { ...rule, broker: "paper" };
  }
  if (rule.broker !== "paper") {
    warnings.push(ORDER_PLACEMENT_QUARANTINE_MESSAGE);
  }

  logger.info({ userId, mode, symbol: rule.symbol, broker: rule.broker }, "Rule draft generated");
  res.json({
    rule,
    explanation: typeof draft?.explanation === "string" ? draft.explanation : "",
    warnings,
    model: AI_MODEL,
  });
});

export default router;
