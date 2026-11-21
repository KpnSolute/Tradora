/**
 * Automations CRUD routes.
 *
 * GET    /automations        → list user's automation rules
 * POST   /automations        → create a rule
 * DELETE /automations/:id    → cancel/delete a rule
 */
import { Router, type IRouter } from "express";
import { db, automationsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { validateRuleInput, type AutomationRuleInput } from "../lib/automation-rules";

const router: IRouter = Router();

function requireAuth(req: any, res: any): boolean {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  return true;
}



function serializeAutomation(a: any) {
  return {
    id:           a.id,
    userId:       a.userId,
    symbol:       a.symbol,
    condition:    a.condition,
    triggerPrice: parseFloat(a.triggerPrice),
    side:         a.side,
    quantity:     parseFloat(a.quantity),
    orderType:    a.orderType,
    limitPrice:    a.limitPrice != null ? parseFloat(a.limitPrice) : null,
    broker:        a.broker,
    status:        a.status,
    failureReason: a.failureReason ?? null,
    firedAt:       a.firedAt ?? null,
    createdAt:     a.createdAt,
  };
}

// GET /automations
router.get("/automations", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const rules = await db
    .select()
    .from(automationsTable)
    .where(eq(automationsTable.userId, req.session.userId!));
  res.json(rules.map(serializeAutomation));
});

// POST /automations
router.post("/automations", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const validated = validateRuleInput(req.body);
  if ("error" in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const data: AutomationRuleInput = validated;
  const [rule] = await db
    .insert(automationsTable)
    .values({
      userId:       req.session.userId!,
      symbol:       data.symbol.toUpperCase(),
      condition:    data.condition,
      triggerPrice: String(data.triggerPrice),
      side:         data.side,
      quantity:     String(data.quantity),
      orderType:    data.orderType,
      limitPrice:   data.limitPrice ? String(data.limitPrice) : undefined,
      broker:       data.broker,
      status:       "active",
    })
    .returning();
  logger.info({ ruleId: rule.id, symbol: rule.symbol, condition: rule.condition, triggerPrice: rule.triggerPrice }, "Automation created");
  res.status(201).json(serializeAutomation(rule));
});

// PATCH /automations/:id — edit a rule that hasn't fired yet
router.patch("/automations/:id", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId!;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid rule id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(automationsTable)
    .where(and(eq(automationsTable.id, id), eq(automationsTable.userId, userId)));

  if (!existing) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  if (existing.status !== "active") {
    res.status(409).json({ error: `Only a rule that is still watching can be edited (this one is ${existing.status}).` });
    return;
  }

  const validated = validateRuleInput(req.body);
  if ("error" in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const data = validated;

  const [rule] = await db
    .update(automationsTable)
    .set({
      symbol:       data.symbol,
      condition:    data.condition,
      triggerPrice: String(data.triggerPrice),
      side:         data.side,
      quantity:     String(data.quantity),
      orderType:    data.orderType,
      limitPrice:   data.limitPrice ? String(data.limitPrice) : null,
      broker:       data.broker,
      status:       "active",
      failureReason: null,
      firedAt:      null,
    })
    .where(and(eq(automationsTable.id, id), eq(automationsTable.userId, userId)))
    .returning();

  logger.info({ ruleId: rule.id }, "Automation updated");
  res.json(serializeAutomation(rule));
});

// POST /automations/:id/retry — re-arm a rule that failed (or got stuck mid-fire)
// so it watches its trigger again. It fires on the next tick that still matches.
router.post("/automations/:id/retry", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId!;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid rule id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(automationsTable)
    .where(and(eq(automationsTable.id, id), eq(automationsTable.userId, userId)));

  if (!existing) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  if (existing.status !== "failed" && existing.status !== "triggered") {
    res.status(409).json({
      error: `Only a failed rule can be retried (this one is ${existing.status}).`,
    });
    return;
  }

  const [rule] = await db
    .update(automationsTable)
    .set({ status: "active", failureReason: null, firedAt: null })
    .where(and(eq(automationsTable.id, id), eq(automationsTable.userId, userId)))
    .returning();

  logger.info(
    { ruleId: rule.id, symbol: rule.symbol, previousStatus: existing.status },
    "Automation retried",
  );
  res.json(serializeAutomation(rule));
});

// DELETE /automations/:id
router.delete("/automations/:id", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const id = parseInt(req.params.id, 10);
  await db
    .delete(automationsTable)
    .where(and(eq(automationsTable.id, id), eq(automationsTable.userId, req.session.userId!)));
  res.sendStatus(204);
});

export default router;
