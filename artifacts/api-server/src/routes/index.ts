import { Router, type IRouter } from "express";
import healthRouter      from "./health";
import authRouter        from "./auth";
import marketsRouter     from "./markets";
import watchlistRouter   from "./watchlist";
import tradesRouter      from "./trades";
import portfolioRouter   from "./portfolio";
import accountsRouter    from "./accounts";
import settingsRouter    from "./settings";
import alpacaRouter      from "./alpaca";
import brokerRouter      from "./broker";
import automationsRouter from "./automations";
import ruleBuilderRouter from "./rule-builder";
import strategyEngineRouter from "./strategy-engine";
import agentFeedRouter     from "./agent-feed";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(marketsRouter);
router.use(watchlistRouter);
router.use(tradesRouter);
router.use(portfolioRouter);
router.use(accountsRouter);
router.use(settingsRouter);
router.use(alpacaRouter);
router.use(brokerRouter);
router.use(automationsRouter);
router.use(ruleBuilderRouter);
router.use(strategyEngineRouter);
router.use(agentFeedRouter);

export default router;
