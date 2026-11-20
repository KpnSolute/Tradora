/**
 * AI rule builder.
 *
 * POST /rule-builder/draft  → turns a natural-language description (and optionally
 *                             an existing rule to edit) into a validated automation
 *                             rule draft. Nothing is saved here; the client reviews
 *                             the draft and submits it to POST/PATCH /automations.
 * GET  /rule-builder/status → whether the model is configured, which provider and
 *                             endpoint are in effect, and the hourly quota.
 *
 * Provider selection (OpenRouter by default) lives in lib/ai-provider.ts and the
 * prompt→rule pipeline in lib/rule-draft.ts. The API key never leaves the server:
 * the browser only ever sees the draft.
 */
import { Router, type IRouter } from "express";
import { db, tradingAccountsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { SUPPORTED_MARKETS } from "../lib/market-data";
import { VALID_BROKERS } from "../lib/automation-rules";
import { resolveProvider } from "../lib/ai-provider";
import { generateRuleDraft } from "../lib/rule-draft";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function requireAuth(req: any, res: any): boolean {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  return true;
}

// ─── Quota ───────────────────────────────────────────────────────────────────

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

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get("/rule-builder/status", (req, res): void => {
  if (!requireAuth(req, res)) return;
  const provider = resolveProvider();
  res.json({
    configured: provider.configured,
    provider: provider.name,
    keyEnv: provider.keyEnv,
    model: provider.model,
    draftsPerHour: DRAFTS_PER_HOUR,
    usedThisHour: recentDrafts(req.session.userId!, Date.now()).length,
    endpoint: provider.endpoint,
    responseFormat: "json_object",
  });
});

router.post("/rule-builder/draft", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId!;

  const provider = resolveProvider();
  if (!provider.configured) {
    res.status(503).json({
      error: `AI rule builder is not configured. Set ${provider.keyEnv} in the API service environment.`,
      provider: provider.name,
      keyEnv: provider.keyEnv,
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

  const result = await generateRuleDraft({
    prompt,
    mode,
    currentRule,
    symbols: SUPPORTED_MARKETS.map(m => m.symbol),
    allowedBrokers,
    connectedBrokers: connected,
    provider,
  });

  if (!result.ok) {
    logger.warn(
      {
        userId,
        provider: provider.name,
        endpoint: result.endpoint,
        model: result.model,
        kind: result.kind,
        upstreamStatus: result.upstreamStatus,
        detail: result.detail,
      },
      "Rule builder draft failed",
    );

    res.status(result.status).json({
      error: result.message,
      reason: result.kind,
      upstreamStatus: result.upstreamStatus,
      upstreamDetail: result.detail,
      endpoint: result.endpoint,
      model: result.model,
      provider: provider.name,
    });
    return;
  }

  // Quota is only consumed by a draft the user could actually use.
  recordDraft(userId);

  logger.info(
    { userId, mode, symbol: result.rule.symbol, broker: result.rule.broker, provider: provider.name, attempts: result.attempts },
    "Rule draft generated",
  );

  res.json({
    rule: result.rule,
    explanation: result.explanation,
    warnings: result.warnings,
    model: result.model,
    provider: provider.name,
    usedResponseFormat: result.usedResponseFormat,
    attempts: result.attempts,
  });
});

export default router;
