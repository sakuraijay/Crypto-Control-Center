import { Router, type IRouter } from "express";
import healthRouter from "./health";
import binanceRouter from "./binance";

const router: IRouter = Router();

router.use(healthRouter);
router.use(binanceRouter);

export default router;
