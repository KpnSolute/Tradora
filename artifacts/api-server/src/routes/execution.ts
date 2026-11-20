/**
 * Execution safety gateway controls.
 *
 * GET  /execution/status        → mode (dry_run), kill switch state and caps
 * GET  /execution/audit         → this user's recent order intents
 * POST /execution/kill-switch   → engage/release the runtime kill switch
 *
 * The gateway itself lives in lib/execution-gateway.ts; every order route funnels
 * through it. There is deliberately no endpoint that sends a live order.
 */
import { Router, type IRouter } from "express";
import {
  executionStatus,
  killSwitchEngaged,
  recentAudit,
  setKillSwitch,
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
  res.json(executionStatus());
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

  res.json(executionStatus());
});

export default router;
