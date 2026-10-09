import { Router, type IRouter } from "express";
import { db, hosts, vpsInstances } from "@workspace/db";
import { GetDashboardResponse } from "@workspace/api-zod";
import { recentAudit } from "../lib/audit";
import { hostStatus } from "../lib/vps";
import { requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/dashboard", requireAdmin, async (_req, res): Promise<void> => {
  const [allHosts, allInstances, activity] = await Promise.all([
    db.select().from(hosts),
    db.select().from(vpsInstances),
    recentAudit(8),
  ]);
  const liveMode = process.env.BHAI_PROVISIONER === "libvirt";
  const hostRows = allHosts.filter((host) => liveMode ? host.simulation === 0 : host.simulation === 1);
  const instanceRows = allInstances.filter((instance) => liveMode
    ? instance.provider === "libvirt"
    : instance.provider === "simulation");

  const statusCounts = instanceRows.reduce(
    (counts, instance) => {
      if (instance.status === "running") counts.running += 1;
      else if (instance.status === "stopped") counts.stopped += 1;
      else if (instance.status === "failed") counts.failed += 1;
      return counts;
    },
    { running: 0, stopped: 0, failed: 0 },
  );
  const onlineHosts = hostRows.filter((host) => hostStatus(host) === "online");
  const resourceTotals = onlineHosts.reduce(
    (totals, host) => ({
      cpuUsagePercent: totals.cpuUsagePercent + host.cpuUsagePercent,
      memoryUsedMb: totals.memoryUsedMb + host.usedMemoryMb,
      memoryTotalMb: totals.memoryTotalMb + host.totalMemoryMb,
      diskUsedGb: totals.diskUsedGb + host.diskUsedGb,
      diskTotalGb: totals.diskTotalGb + host.diskTotalGb,
      networkRxMbps: totals.networkRxMbps + host.networkRxMbps,
      networkTxMbps: totals.networkTxMbps + host.networkTxMbps,
    }),
    {
      cpuUsagePercent: 0,
      memoryUsedMb: 0,
      memoryTotalMb: 0,
      diskUsedGb: 0,
      diskTotalGb: 0,
      networkRxMbps: 0,
      networkTxMbps: 0,
    },
  );

  const data = {
    provider: liveMode ? "libvirt" : "simulation",
    hosts: { total: hostRows.length, online: onlineHosts.length },
    instances: { total: instanceRows.length, ...statusCounts },
    resources: {
      ...resourceTotals,
      cpuUsagePercent: onlineHosts.length
        ? Math.round(resourceTotals.cpuUsagePercent / onlineHosts.length)
        : 0,
    },
    recentActivity: activity,
  };

  res.json(GetDashboardResponse.parse(data));
});

export default router;
