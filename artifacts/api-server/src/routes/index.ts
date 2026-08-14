import { Router, type IRouter } from "express";
import healthRouter from "./health";
import gmxRouter from "./gmx";
import dataRouter from "./data";
import vpsRouter from "./vps";
import aiRouter from "./ai";

const router: IRouter = Router();

router.use(healthRouter);
router.use(gmxRouter);
router.use(dataRouter);
router.use(vpsRouter);
router.use(aiRouter);

export default router;
