import { Router, type IRouter } from "express";
import { db, hosts } from "@workspace/db";
import { ListHostsResponse, RegisterHostBody, RegisterHostResponse } from "@workspace/api-zod";
import { recordAudit } from "../lib/audit";
import { hashAgentToken, newOpaqueToken } from "../lib/security";
import { serializeHost } from "../lib/vps";
import { requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/hosts", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(hosts).orderBy(hosts.createdAt);
  res.json(ListHostsResponse.parse(rows.map(serializeHost)));
});

router.post("/hosts", requireAdmin, async (req, res): Promise<void> => {
  const parsed = RegisterHostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Host name must contain between 2 and 80 characters." });
    return;
  }

  const agentToken = newOpaqueToken();
  const [host] = await db.insert(hosts).values({
    name: parsed.data.name.trim(),
    tokenHash: hashAgentToken(agentToken),
    simulation: 0,
  }).returning();
  await recordAudit(res.locals.admin!.email, "host.registered", "host", host.id, { name: host.name });

  res.status(201).json(RegisterHostResponse.parse({
    host: serializeHost(host),
    agentToken,
  }));
});

export default router;
