import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import dashboardRouter from "./dashboard";
import vpsRouter from "./vps";
import hostsRouter from "./hosts";
import auditRouter from "./audit";
import agentRouter from "./agent";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(dashboardRouter);
router.use(vpsRouter);
router.use(hostsRouter);
router.use(auditRouter);
router.use(agentRouter);

export default router;
