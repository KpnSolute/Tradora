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
import strategyEngineRouter from "./strategy-engine";

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
router.use(strategyEngineRouter);

export default router;
