/**
 * Execution safety gateway controls.
 *
 * GET  /execution/status        → live/dry-run state, kill switch and caps
 * GET  /execution/audit         → this user's recent order intents
 * POST /execution/kill-switch   → engage/release the runtime kill switch
 * POST /execution/live-mode     → opt this account in/out of live execution
 *
 * The gateway itself lives in lib/execution-gateway.ts; every order route funnels
 * through it, and only that module decides whether an order may leave the process.
 * Live execution is off by default and needs BOTH an active live broker account and
 * an explicit opt-in here.
 */
import { Router, type IRouter } from "express";
import { db, tradingAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  executionStatus,
  killSwitchEngaged,
  liveModeEnabled,
  recentAudit,
  setKillSwitch,
  setLiveMode,
} from "../lib/execution-gateway";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function requireAuth(req: any, res: any): boolean {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  return true;
}

router.get("/execution/status", (req, res): void => {
  if (!requireAuth(req, res)) return;
  res.json(executionStatus(req.session.userId!));
});

router.get("/execution/audit", (req, res): void => {
  if (!requireAuth(req, res)) return;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  res.json({ intents: recentAudit(req.session.userId!, Number.isFinite(limit) ? limit : 50) });
});

router.post("/execution/kill-switch", (req, res): void => {
  if (!requireAuth(req, res)) return;
  if (typeof req.body?.engaged !== "boolean") {
    res.status(400).json({ error: "engaged must be true or false" });
    return;
  }

  const before = killSwitchEngaged();
  setKillSwitch(req.body.engaged);
  logger.warn(
    { userId: req.session.userId, before, after: req.body.engaged },
    req.body.engaged ? "Execution kill switch engaged" : "Execution kill switch released",
  );

  res.json(executionStatus(req.session.userId!));
});

router.post("/execution/live-mode", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId!;

  if (typeof req.body?.enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be true or false" });
    return;
  }

  if (req.body.enabled) {
    // Refuse to arm live execution with nothing to trade on.
    const liveAccounts = await db
      .select({ id: tradingAccountsTable.id })
      .from(tradingAccountsTable)
      .where(
        and(
          eq(tradingAccountsTable.userId, userId),
          eq(tradingAccountsTable.status, "active"),
          eq(tradingAccountsTable.mode, "live"),
        ),
      )
      .limit(1);

    if (liveAccounts.length === 0) {
      res.status(409).json({
        error: "Connect an active live broker account before turning on live execution.",
        code: "no_live_account",
      });
      return;
    }
  }

  const before = liveModeEnabled(userId);
  setLiveMode(userId, req.body.enabled);
  logger.warn(
    { userId, before, after: req.body.enabled },
    req.body.enabled ? "Live execution enabled for user" : "Live execution disabled for user",
  );

  res.json(executionStatus(userId));
});

export default router;
