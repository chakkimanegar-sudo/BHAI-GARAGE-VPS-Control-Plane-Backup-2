import { Router, type IRouter } from "express";
import { ListAuditEventsQueryParams, ListAuditEventsResponse } from "@workspace/api-zod";
import { recentAudit } from "../lib/audit";
import { requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/audit", requireAdmin, async (req, res): Promise<void> => {
  const parsed = ListAuditEventsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Audit limit must be between 1 and 100." });
    return;
  }
  const events = await recentAudit(parsed.data.limit ?? 30);
  res.json(ListAuditEventsResponse.parse(events));
});

export default router;
