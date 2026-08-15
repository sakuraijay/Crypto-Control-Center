import { Router, type IRouter } from "express";
import healthRouter from "./health";
import gmxRouter from "./gmx";
import dataRouter from "./data";
import aiRouter from "./ai";
import approvalsRouter from "./approvals";
import executorRouter from "./executor";

const router: IRouter = Router();

router.use(healthRouter);
router.use(gmxRouter);
router.use(dataRouter);
router.use(aiRouter);
router.use(approvalsRouter);
router.use(executorRouter);

export default router;
