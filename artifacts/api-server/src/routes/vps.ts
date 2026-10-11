import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { db, agentOperations, auditEvents, hosts, vpsInstances } from "@workspace/db";
import {
  CreateVpsBody,
  CreateVpsResponse,
  DeleteVpsParams,
  DeleteVpsResponse,
  GetVpsParams,
  GetVpsResponse,
  ListVpsQueryParams,
  ListVpsResponse,
  OperateVpsBody,
  OperateVpsParams,
  OperateVpsResponse,
} from "@workspace/api-zod";
import { isRealProvisioning, nextVpsStatus, serializeHost, serializeVps, simulatedIp } from "../lib/vps";
import { recordAudit } from "../lib/audit";
import { requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

async function hostNameFor(id: string | null): Promise<string | null> {
  if (!id) return null;
  const [host] = await db.select({ name: hosts.name }).from(hosts).where(eq(hosts.id, id)).limit(1);
  return host?.name ?? null;
}

router.get("/vps", requireAdmin, async (req, res): Promise<void> => {
  const parsedQuery = ListVpsQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: "Invalid search or status filter." });
    return;
  }

  const { search, status } = parsedQuery.data;
  const filters = [];
  if (search) {
    const term = `%${search}%`;
    filters.push(or(
      ilike(vpsInstances.name, term),
      ilike(vpsInstances.ipAddress, term),
      ilike(hosts.name, term),
    ));
  }
  if (status && status !== "all") filters.push(eq(vpsInstances.status, status));
  const rows = await db
    .select({ instance: vpsInstances, hostName: hosts.name })
    .from(vpsInstances)
    .leftJoin(hosts, eq(vpsInstances.hostId, hosts.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(vpsInstances.name));
  res.json(ListVpsResponse.parse(rows.map(({ instance, hostName }) => serializeVps(instance, hostName))));
});

router.post("/vps", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateVpsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid VPS configuration. Check name, image, and resource limits." });
    return;
  }
  const input = parsed.data;
  const liveMode = isRealProvisioning();
  const publicNetwork = input.publicNetwork
    ? { ...input.publicNetwork, macAddress: input.publicNetwork.macAddress.toLowerCase() }
    : null;
  if (publicNetwork && !liveMode) {
    res.status(400).json({ error: "A provider-assigned public IP and virtual MAC can only be used with the real KVM provider." });
    return;
  }
  if (
    liveMode &&
    !input.sshPublicKey?.trim().match(
      /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+(?: [^\r\n]{0,128})?$/,
    )
  ) {
    res.status(400).json({ error: "A valid SSH public key is required for real KVM provisioning." });
    return;
  }

  let assignedHostId: string | null = null;
  if (liveMode) {
    const availableHosts = await db.select().from(hosts).where(eq(hosts.simulation, 0));
    const selectedHost = input.hostId
      ? availableHosts.find((host) => host.id === input.hostId)
      : availableHosts.find((host) => serializeHost(host).status === "online");
    if (!selectedHost || serializeHost(selectedHost).status !== "online") {
      res.status(409).json({ error: "No online KVM host is reporting capacity. Register a Linux host agent before provisioning." });
      return;
    }
    const allocatedVcpus = await db
      .select({ id: vpsInstances.id, vcpus: vpsInstances.vcpus })
      .from(vpsInstances)
      .where(and(eq(vpsInstances.hostId, selectedHost.id), eq(vpsInstances.provider, "libvirt")));
    const alreadyAllocatedCores = allocatedVcpus.reduce((sum, instance) => sum + instance.vcpus, 0);
    const pendingInstances = await db
      .select({ memoryMb: vpsInstances.memoryMb, diskGb: vpsInstances.diskGb })
      .from(vpsInstances)
      .where(and(
        eq(vpsInstances.hostId, selectedHost.id),
        eq(vpsInstances.provider, "libvirt"),
        eq(vpsInstances.status, "provisioning"),
      ));
    const pendingMemoryMb = pendingInstances.reduce((sum, instance) => sum + instance.memoryMb, 0);
    const pendingDiskGb = pendingInstances.reduce((sum, instance) => sum + instance.diskGb, 0);
    const availableMemoryMb = selectedHost.totalMemoryMb - selectedHost.usedMemoryMb - pendingMemoryMb;
    const availableDiskGb = selectedHost.diskTotalGb - selectedHost.diskUsedGb - pendingDiskGb;
    if (
      input.vcpus + alreadyAllocatedCores > Math.max(1, selectedHost.totalVcpus * 2) ||
      input.memoryMb > availableMemoryMb ||
      input.diskGb > availableDiskGb
    ) {
      res.status(409).json({ error: "The selected host does not have enough reported capacity for this VPS." });
      return;
    }
    assignedHostId = selectedHost.id;
  } else if (input.hostId) {
    const [requestedHost] = await db
      .select()
      .from(hosts)
      .where(and(eq(hosts.id, input.hostId), eq(hosts.simulation, 1)))
      .limit(1);
    if (!requestedHost) {
      res.status(400).json({ error: "Choose a valid simulation host." });
      return;
    }
    assignedHostId = requestedHost.id;
  } else {
    const [demoHost] = await db
      .select({ id: hosts.id })
      .from(hosts)
      .where(eq(hosts.simulation, 1))
      .limit(1);
    assignedHostId = demoHost?.id ?? null;
  }

  const id = randomUUID();
  try {
    const result = await db.transaction(async (tx) => {
      const [created] = await tx.insert(vpsInstances).values({
        id,
        name: input.name,
        hostId: assignedHostId,
        osImage: input.osImage,
        vcpus: input.vcpus,
        memoryMb: input.memoryMb,
        diskGb: input.diskGb,
        status: liveMode ? "provisioning" : "running",
        provider: liveMode ? "libvirt" : "simulation",
        ipAddress: liveMode ? publicNetwork?.ipAddress ?? null : simulatedIp(id),
        publicNetwork: liveMode ? publicNetwork : null,
        sshPublicKey: input.sshPublicKey?.trim() || null,
        cpuUsagePercent: liveMode ? 0 : 7.4,
        memoryUsedMb: liveMode ? 0 : Math.min(input.memoryMb, 384),
        diskUsedGb: liveMode ? 0 : Math.min(input.diskGb, 3.2),
        networkRxMbps: 0,
        networkTxMbps: 0,
      }).returning();
      let operationId: string | null = null;
      if (liveMode && assignedHostId) {
        const [operation] = await tx.insert(agentOperations).values({
          hostId: assignedHostId,
          vpsId: created.id,
          action: "create",
          state: "queued",
          payload: { sshPublicKey: input.sshPublicKey?.trim() || null },
        }).returning({ id: agentOperations.id });
        operationId = operation.id;
      }
      await tx.insert(auditEvents).values({
        actor: res.locals.admin!.email,
        action: liveMode ? "vps.create.queued" : "vps.create.simulated",
        resourceType: "vps",
        resourceId: created.id,
        details: {
          name: created.name,
          osImage: created.osImage,
          hostId: assignedHostId,
          ...(operationId ? { operationId } : {}),
          resources: { vcpus: created.vcpus, memoryMb: created.memoryMb, diskGb: created.diskGb },
        },
      });
      return { created, operationId };
    });

    res.status(201).json(CreateVpsResponse.parse({
      vps: serializeVps(result.created, await hostNameFor(assignedHostId)),
      queued: liveMode,
      operationId: result.operationId,
      simulation: !liveMode,
    }));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "The VPS name, public IPv4 address, or virtual MAC is already assigned." });
      return;
    }
    throw error;
  }
});

router.get("/vps/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = GetVpsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid VPS id." });
    return;
  }
  const [instance] = await db.select().from(vpsInstances).where(eq(vpsInstances.id, params.data.id)).limit(1);
  if (!instance) {
    res.status(404).json({ error: "VPS not found." });
    return;
  }
  res.json(GetVpsResponse.parse(serializeVps(instance, await hostNameFor(instance.hostId))));
});

router.post("/vps/:id/actions", requireAdmin, async (req, res): Promise<void> => {
  const params = OperateVpsParams.safeParse(req.params);
  const parsed = OperateVpsBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid VPS action." });
    return;
  }
  const [instance] = await db.select().from(vpsInstances).where(eq(vpsInstances.id, params.data.id)).limit(1);
  if (!instance) {
    res.status(404).json({ error: "VPS not found." });
    return;
  }
  if (instance.status === "provisioning" || instance.status === "deleting" || instance.status === "failed") {
    res.status(409).json({ error: `Cannot ${parsed.data.action} a VPS while it is ${instance.status}.` });
    return;
  }
  if (instance.provider === "libvirt" && !isRealProvisioning()) {
    res.status(409).json({ error: "This VPS uses the real KVM provider, but this API is currently configured for simulation." });
    return;
  }
  const nextStatus = nextVpsStatus(instance.status, parsed.data.action);
  if (!nextStatus) {
    res.status(409).json({ error: `Cannot ${parsed.data.action} a VPS while it is ${instance.status}.` });
    return;
  }

  if (instance.provider === "libvirt") {
    if (!instance.hostId) {
      res.status(409).json({ error: "This VPS is not assigned to a virtualization host." });
      return;
    }
    try {
      const operation = await db.transaction(async (tx) => {
        const active = await tx.select({ id: agentOperations.id })
          .from(agentOperations)
          .where(and(
            eq(agentOperations.vpsId, instance.id),
            inArray(agentOperations.state, ["queued", "claimed"]),
          ))
          .limit(1);
        if (active.length) throw new Error("VPS_OPERATION_ALREADY_ACTIVE");
        const [createdOperation] = await tx.insert(agentOperations).values({
          hostId: instance.hostId!,
          vpsId: instance.id,
          action: parsed.data.action,
          state: "queued",
          payload: { previousStatus: instance.status },
        }).returning({ id: agentOperations.id });
        await tx.insert(auditEvents).values({
          actor: res.locals.admin!.email,
          action: `vps.${parsed.data.action}.queued`,
          resourceType: "vps",
          resourceId: instance.id,
          details: { operationId: createdOperation.id, hostId: instance.hostId },
        });
        return createdOperation;
      });
      res.status(202).json(OperateVpsResponse.parse({
        vps: serializeVps(instance, await hostNameFor(instance.hostId)),
        queued: true,
        operationId: operation.id,
        simulation: false,
      }));
    } catch (error) {
      if (isUniqueViolation(error) || (error instanceof Error && error.message === "VPS_OPERATION_ALREADY_ACTIVE")) {
        res.status(409).json({ error: "A VPS operation is already queued or running for this instance." });
        return;
      }
      throw error;
    }
    return;
  }

  const nowRunning = nextStatus === "running";
  const [updated] = await db.update(vpsInstances).set({
    status: nextStatus,
    cpuUsagePercent: nowRunning ? (parsed.data.action === "restart" ? 3.1 : 5.8) : 0,
    memoryUsedMb: nowRunning ? Math.min(instance.memoryMb, 384) : 0,
    networkRxMbps: 0,
    networkTxMbps: 0,
    updatedAt: new Date(),
  }).where(eq(vpsInstances.id, instance.id)).returning();
  await recordAudit(res.locals.admin!.email, `vps.${parsed.data.action}.simulated`, "vps", instance.id);
  res.json(OperateVpsResponse.parse({
    vps: serializeVps(updated, await hostNameFor(updated.hostId)),
    queued: false,
    operationId: null,
    simulation: true,
  }));
});

router.post("/vps/:id/delete", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteVpsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid VPS id." });
    return;
  }
  const [instance] = await db.select().from(vpsInstances).where(eq(vpsInstances.id, params.data.id)).limit(1);
  if (!instance) {
    res.status(404).json({ error: "VPS not found." });
    return;
  }
  if (instance.provider === "libvirt" && !isRealProvisioning()) {
    res.status(409).json({ error: "This VPS uses the real KVM provider, but this API is currently configured for simulation." });
    return;
  }
  if (instance.provider === "libvirt") {
    if (!instance.hostId) {
      res.status(409).json({ error: "This VPS is not assigned to a virtualization host." });
      return;
    }
    try {
      const operation = await db.transaction(async (tx) => {
        const active = await tx.select({ id: agentOperations.id })
          .from(agentOperations)
          .where(and(
            eq(agentOperations.vpsId, instance.id),
            inArray(agentOperations.state, ["queued", "claimed"]),
          ))
          .limit(1);
        if (active.length) throw new Error("VPS_OPERATION_ALREADY_ACTIVE");
        const [createdOperation] = await tx.insert(agentOperations).values({
          hostId: instance.hostId!,
          vpsId: instance.id,
          action: "delete",
          state: "queued",
          payload: { previousStatus: instance.status },
        }).returning({ id: agentOperations.id });
        await tx.update(vpsInstances)
          .set({ status: "deleting", updatedAt: new Date() })
          .where(eq(vpsInstances.id, instance.id));
        await tx.insert(auditEvents).values({
          actor: res.locals.admin!.email,
          action: "vps.delete.queued",
          resourceType: "vps",
          resourceId: instance.id,
          details: { operationId: createdOperation.id, hostId: instance.hostId },
        });
        return createdOperation;
      });
      res.status(202).json(DeleteVpsResponse.parse({ deleted: false, queued: true, operationId: operation.id }));
    } catch (error) {
      if (isUniqueViolation(error) || (error instanceof Error && error.message === "VPS_OPERATION_ALREADY_ACTIVE")) {
        res.status(409).json({ error: "A VPS operation is already queued or running for this instance." });
        return;
      }
      throw error;
    }
    return;
  }

  await db.transaction(async (tx) => {
    await tx.delete(vpsInstances).where(eq(vpsInstances.id, instance.id));
    await tx.insert(auditEvents).values({
      actor: res.locals.admin!.email,
      action: "vps.delete.simulated",
      resourceType: "vps",
      resourceId: instance.id,
      details: { name: instance.name },
    });
  });
  res.json(DeleteVpsResponse.parse({ deleted: true, queued: false, operationId: null }));
});

export default router;
