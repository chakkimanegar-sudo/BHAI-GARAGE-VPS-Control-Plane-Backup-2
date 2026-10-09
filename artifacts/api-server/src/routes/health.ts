import { Router, type IRouter } from "express";
import { HealthCheckResponse, ReadinessCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok", service: "bhai-garage-api" });
  res.json(data);
});

router.get("/readyz", async (_req, res): Promise<void> => {
  try {
    await pool.query("SELECT 1");
    res.json(ReadinessCheckResponse.parse({ status: "ok", service: "bhai-garage-api" }));
  } catch {
    res.status(503).json({ error: "Database is not ready." });
  }
});

export default router;
