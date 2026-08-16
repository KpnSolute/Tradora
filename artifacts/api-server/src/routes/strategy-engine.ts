import { Router, type IRouter } from "express";
import {
  getStrategies,
  getStrategyEngineHealth,
  StrategyEngineError,
} from "../lib/strategy-engine";

const router: IRouter = Router();

function requireAuth(req: any, res: any): boolean {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  return true;
}

function sendEngineError(res: any, error: unknown): void {
  if (error instanceof StrategyEngineError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  res.status(502).json({ error: "Strategy engine request failed" });
}

router.get("/strategy-engine/health", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  try {
    res.json(await getStrategyEngineHealth());
  } catch (error) {
    sendEngineError(res, error);
  }
});

router.get("/strategy-engine/strategies", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  try {
    res.json(await getStrategies());
  } catch (error) {
    sendEngineError(res, error);
  }
});

export default router;
