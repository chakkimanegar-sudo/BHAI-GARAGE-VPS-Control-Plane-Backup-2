import { and, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  AgentHeartbeatBody,
  AgentHeartbeatResponse,
  ClaimAgentOperationResponse,
  CompleteAgentOperationBody,
  CompleteAgentOperationParams,
  CompleteAgentOperationResponse,
} from "@workspace/api-zod";
import { db, agentOperations, auditEvents, hosts, vpsInstances } from "@workspace/db";
import { requireHostAgent } from "../middlewares/auth";
import { serializeVps } from "../lib/vps";

const router: IRouter = Router();

router.post("/agent/heartbeat", requireHostAgent, async (req, res): Promise<void> => {
  const parsed = AgentHeartbeatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid host metrics." });
    return;
  }
  const metrics = parsed.data;
  await db.update(hosts).set({
    hostname: metrics.hostname,
    agentVersion: metrics.agentVersion,
    status: "online",
    totalVcpus: metrics.totalVcpus,
    cpuUsagePercent: metrics.cpuUsagePercent,
    totalMemoryMb: metrics.totalMemoryMb,
    usedMemoryMb: metrics.usedMemoryMb,
    diskTotalGb: metrics.diskTotalGb,
    diskUsedGb: Math.min(metrics.diskUsedGb, metrics.diskTotalGb),
    networkRxMbps: metrics.networkRxMbps,
    networkTxMbps: metrics.networkTxMbps,
    lastSeenAt: new Date(),
  }).where(eq(hosts.id, res.locals.host!.id));
  res.json(AgentHeartbeatResponse.parse({ accepted: true }));
});

router.post("/agent/operations/next", requireHostAgent, async (_req, res): Promise<void> => {
  const claimed = await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      UPDATE agent_operations
      SET state = 'claimed', claimed_at = NOW(), attempts = attempts + 1, updated_at = NOW()
      WHERE id = (
        SELECT id
        FROM agent_operations
        WHERE host_id = ${res.locals.host!.id}
          AND attempts < 10
          AND (
            state = 'queued'
            OR (state = 'claimed' AND claimed_at < NOW() - INTERVAL '5 minutes')
          )
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, vps_id, action, payload
    `);
    return result.rows[0] as
      | { id: string; vps_id: string | null; action: string; payload: Record<string, unknown> }
      | undefined;
  });

  if (!claimed?.vps_id) {
    res.json(ClaimAgentOperationResponse.parse({ operation: null }));
    return;
  }
  const [instance] = await db.select().from(vpsInstances).where(eq(vpsInstances.id, claimed.vps_id)).limit(1);
  if (!instance) {
    await db.update(agentOperations)
      .set({ state: "failed", updatedAt: new Date() })
      .where(and(eq(agentOperations.id, claimed.id), eq(agentOperations.hostId, res.locals.host!.id)));
    res.json(ClaimAgentOperationResponse.parse({ operation: null }));
    return;
  }
  const operation = {
    id: claimed.id,
    action: claimed.action,
    vps: serializeVps(instance, res.locals.host!.name),
    sshPublicKey: typeof claimed.payload?.sshPublicKey === "string"
      ? claimed.payload.sshPublicKey
      : null,
  };
  res.json(ClaimAgentOperationResponse.parse({ operation }));
});

router.post("/agent/operations/:operationId/complete", requireHostAgent, async (req, res): Promise<void> => {
  const params = CompleteAgentOperationParams.safeParse(req.params);
  const parsed = CompleteAgentOperationBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid host-agent operation result." });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [operation] = await tx.select()
      .from(agentOperations)
      .where(and(
        eq(agentOperations.id, params.data.operationId),
        eq(agentOperations.hostId, res.locals.host!.id),
        eq(agentOperations.state, "claimed"),
      ))
      .limit(1);
    if (!operation) return false;

    const [instance] = operation.vpsId
      ? await tx.select().from(vpsInstances).where(eq(vpsInstances.id, operation.vpsId)).limit(1)
      : [];
    if (!instance) {
      await tx.update(agentOperations)
        .set({ state: "failed", updatedAt: new Date() })
        .where(eq(agentOperations.id, operation.id));
      return false;
    }

    const previousStatus = typeof operation.payload.previousStatus === "string"
      ? operation.payload.previousStatus
      : "stopped";
    const action = operation.action;
    const success = parsed.data.success;

    if (action === "delete" && success) {
      await tx.delete(vpsInstances).where(eq(vpsInstances.id, instance.id));
    } else {
      let status = instance.status;
      if (action === "create") status = success ? "running" : "failed";
      else if (action === "start" || action === "restart") status = success ? "running" : previousStatus;
      else if (action === "stop") status = success ? "stopped" : previousStatus;
      else if (action === "delete" && !success) status = previousStatus;
      await tx.update(vpsInstances).set({
        status,
        ...(success && parsed.data.ipAddress ? { ipAddress: parsed.data.ipAddress } : {}),
        ...(success && parsed.data.cpuUsagePercent !== undefined
          ? { cpuUsagePercent: parsed.data.cpuUsagePercent }
          : {}),
        ...(success && parsed.data.memoryUsedMb !== undefined
          ? { memoryUsedMb: parsed.data.memoryUsedMb }
          : {}),
        ...(success && parsed.data.diskUsedGb !== undefined
          ? { diskUsedGb: parsed.data.diskUsedGb }
          : {}),
        updatedAt: new Date(),
      }).where(eq(vpsInstances.id, instance.id));
    }

    await tx.update(agentOperations).set({
      state: success ? "succeeded" : "failed",
      updatedAt: new Date(),
    }).where(eq(agentOperations.id, operation.id));
    await tx.insert(auditEvents).values({
      actor: `host-agent:${res.locals.host!.name}`,
      action: `vps.${action}.${success ? "succeeded" : "failed"}`,
      resourceType: "vps",
      resourceId: instance.id,
      details: {
        operationId: operation.id,
        ...(success ? {} : { error: parsed.data.errorMessage ?? "Host operation failed." }),
      },
    });
    return true;
  });

  if (!result) {
    res.status(404).json({ error: "Operation is missing, expired, or assigned to another host." });
    return;
  }
  res.json(CompleteAgentOperationResponse.parse({ accepted: true }));
});

export default router;
