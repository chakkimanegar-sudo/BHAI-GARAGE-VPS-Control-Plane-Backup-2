import type { vpsInstances, hosts } from "@workspace/db";

export type VpsRow = typeof vpsInstances.$inferSelect;
export type HostRow = typeof hosts.$inferSelect;

export function serializeVps(instance: VpsRow, hostName: string | null = null) {
  return {
    id: instance.id,
    name: instance.name,
    hostId: instance.hostId,
    hostName,
    ipAddress: instance.ipAddress,
    osImage: instance.osImage,
    vcpus: instance.vcpus,
    memoryMb: instance.memoryMb,
    diskGb: instance.diskGb,
    status: instance.status,
    provider: instance.provider,
    cpuUsagePercent: instance.cpuUsagePercent,
    memoryUsedMb: instance.memoryUsedMb,
    diskUsedGb: instance.diskUsedGb,
    networkRxMbps: instance.networkRxMbps,
    networkTxMbps: instance.networkTxMbps,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

export function hostStatus(host: HostRow, now = Date.now()): "online" | "offline" {
  if (host.simulation === 1) return "online";
  if (!host.lastSeenAt) return "offline";
  return now - host.lastSeenAt.getTime() <= 90_000 ? "online" : "offline";
}

export function serializeHost(host: HostRow) {
  return {
    id: host.id,
    name: host.name,
    hostname: host.hostname,
    status: hostStatus(host),
    simulation: host.simulation === 1,
    totalVcpus: host.totalVcpus,
    cpuUsagePercent: host.cpuUsagePercent,
    totalMemoryMb: host.totalMemoryMb,
    usedMemoryMb: host.usedMemoryMb,
    diskTotalGb: host.diskTotalGb,
    diskUsedGb: host.diskUsedGb,
    networkRxMbps: host.networkRxMbps,
    networkTxMbps: host.networkTxMbps,
    agentVersion: host.agentVersion,
    lastSeenAt: host.lastSeenAt,
    createdAt: host.createdAt,
  };
}

export function simulatedIp(id: string): string {
  const last = Number.parseInt(id.replaceAll("-", "").slice(-4), 16);
  return `192.168.122.${20 + (Number.isFinite(last) ? last % 220 : 0)}`;
}

export function nextVpsStatus(
  current: string,
  action: "start" | "stop" | "restart",
): "running" | "stopped" | null {
  if (action === "start" && current === "stopped") return "running";
  if (action === "stop" && current === "running") return "stopped";
  if (action === "restart" && current === "running") return "running";
  return null;
}

export function isRealProvisioning(): boolean {
  return process.env.BHAI_PROVISIONER === "libvirt";
}
