import { eq } from "drizzle-orm";
import { db, auditEvents, hosts, vpsInstances } from "@workspace/db";

export async function ensureSimulationExamples(): Promise<void> {
  if (process.env.BHAI_PROVISIONER === "libvirt") return;
  const [existing] = await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.simulation, 1)).limit(1);
  if (existing) return;

  await db.transaction(async (tx) => {
    const [host] = await tx.insert(hosts).values({
      name: "Garage Demo Node",
      tokenHash: "simulation-only-no-agent-token",
      simulation: 1,
      hostname: "demo-node.local",
      status: "online",
      totalVcpus: 8,
      cpuUsagePercent: 28,
      totalMemoryMb: 16_384,
      usedMemoryMb: 5_632,
      diskTotalGb: 512,
      diskUsedGb: 186.2,
      networkRxMbps: 4.8,
      networkTxMbps: 1.2,
      agentVersion: "simulator",
      lastSeenAt: new Date(),
    }).returning();

    await tx.insert(vpsInstances).values([
      {
        name: "demo-web-01",
        hostId: host.id,
        ipAddress: "192.168.122.21",
        osImage: "ubuntu-24.04",
        vcpus: 2,
        memoryMb: 2_048,
        diskGb: 40,
        status: "running",
        provider: "simulation",
        cpuUsagePercent: 9.6,
        memoryUsedMb: 872,
        diskUsedGb: 12.4,
        networkRxMbps: 0.8,
        networkTxMbps: 0.3,
      },
      {
        name: "demo-db-01",
        hostId: host.id,
        ipAddress: "192.168.122.22",
        osImage: "debian-12",
        vcpus: 2,
        memoryMb: 4_096,
        diskGb: 80,
        status: "stopped",
        provider: "simulation",
      },
    ]);
    await tx.insert(auditEvents).values({
      actor: "system",
      action: "simulation.seeded",
      resourceType: "host",
      resourceId: host.id,
      details: { label: "Simulation data only", instances: 2 },
    });
  });
}
