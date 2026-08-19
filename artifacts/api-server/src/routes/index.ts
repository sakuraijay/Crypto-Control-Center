import { Router, type IRouter } from "express";
import healthRouter from "./health";
import gmxRouter from "./gmx";
import dataRouter from "./data";
import aiRouter from "./ai";
import approvalsRouter from "./approvals";
import executorRouter from "./executor";
import walletDiagnosticRouter from "./wallet-diagnostic";
import notificationsRouter from "./notifications";
import livetestRouter from "./livetest";
import relayRouter from "./relay";
import gmxapiRouter from "./gmxapi";
import riskRouter from "./risk";
import intelRouter from "./intel";
import canaryRouter from "./canary";

const router: IRouter = Router();

router.use(healthRouter);
router.use(gmxRouter);
router.use(dataRouter);
router.use(aiRouter);
router.use(approvalsRouter);
router.use(executorRouter);
router.use(walletDiagnosticRouter);
router.use(notificationsRouter);
router.use(livetestRouter);
router.use(relayRouter);
router.use(gmxapiRouter);
router.use(riskRouter);
router.use(intelRouter);
router.use(canaryRouter);

export default router;
