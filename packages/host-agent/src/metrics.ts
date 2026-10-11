import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import type { AgentConfig } from "./config.ts";
import type { HostMetrics } from "./types.ts";

type Snapshot = { total: number; idle: number; rx: number; tx: number; at: number };

function cpuCounters(contents: string): { total: number; idle: number } {
  const first = contents.split("\n", 1)[0]?.trim().split(/\s+/);
  if (!first || first[0] !== "cpu") return { total: 0, idle: 0 };
  const values = first.slice(1).map((value) => Number(value));
  return {
    total: values.reduce((sum, value) => sum + value, 0),
    idle: (values[3] ?? 0) + (values[4] ?? 0),
  };
}

function networkCounters(contents: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of contents.split("\n").slice(2)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const interfaceName = line.slice(0, separator).trim();
    if (!interfaceName || interfaceName === "lo") continue;
    const values = line.slice(separator + 1).trim().split(/\s+/).map(Number);
    rx += values[0] ?? 0;
    tx += values[8] ?? 0;
  }
  return { rx, tx };
}

export class HostMetricsCollector {
  private previous: Snapshot | null = null;

  private readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  async collect(): Promise<HostMetrics> {
    const [stat, network, filesystem] = await Promise.all([
      readFile("/proc/stat", "utf8"),
      readFile("/proc/net/dev", "utf8"),
      statfs(this.config.storageDirectory),
    ]);
    const cpu = cpuCounters(stat);
    const net = networkCounters(network);
    const now = Date.now();
    let cpuUsagePercent = 0;
    let networkRxMbps = 0;
    let networkTxMbps = 0;

    if (this.previous) {
      const elapsedSeconds = Math.max(0.1, (now - this.previous.at) / 1000);
      const totalDelta = cpu.total - this.previous.total;
      const idleDelta = cpu.idle - this.previous.idle;
      if (totalDelta > 0) {
        cpuUsagePercent = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
      }
      networkRxMbps = Math.max(0, ((net.rx - this.previous.rx) * 8) / elapsedSeconds / 1_000_000);
      networkTxMbps = Math.max(0, ((net.tx - this.previous.tx) * 8) / elapsedSeconds / 1_000_000);
    }
    this.previous = { total: cpu.total, idle: cpu.idle, rx: net.rx, tx: net.tx, at: now };

    const totalDiskBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
    const freeDiskBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    const totalMemoryMb = Math.floor(os.totalmem() / (1024 * 1024));
    const usedMemoryMb = Math.min(totalMemoryMb, Math.floor((os.totalmem() - os.freemem()) / (1024 * 1024)));

    return {
      hostname: (this.config.hostname ?? os.hostname()).slice(0, 255),
      agentVersion: "0.1.0",
      totalVcpus: os.availableParallelism(),
      cpuUsagePercent: Number(cpuUsagePercent.toFixed(2)),
      totalMemoryMb,
      usedMemoryMb,
      diskTotalGb: Number((totalDiskBytes / 1_000_000_000).toFixed(2)),
      diskUsedGb: Number(((totalDiskBytes - freeDiskBytes) / 1_000_000_000).toFixed(2)),
      networkRxMbps: Number(networkRxMbps.toFixed(2)),
      networkTxMbps: Number(networkTxMbps.toFixed(2)),
    };
  }
}
