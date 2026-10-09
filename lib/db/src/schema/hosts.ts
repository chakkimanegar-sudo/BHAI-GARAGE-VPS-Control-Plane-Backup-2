import { pgTable, text, timestamp, uuid, integer, real } from "drizzle-orm/pg-core";

export const hosts = pgTable("hosts", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  hostname: text("hostname"),
  status: text("status").notNull().default("offline"),
  simulation: integer("simulation").notNull().default(0),
  totalVcpus: integer("total_vcpus").notNull().default(0),
  cpuUsagePercent: real("cpu_usage_percent").notNull().default(0),
  totalMemoryMb: integer("total_memory_mb").notNull().default(0),
  usedMemoryMb: integer("used_memory_mb").notNull().default(0),
  diskTotalGb: real("disk_total_gb").notNull().default(0),
  diskUsedGb: real("disk_used_gb").notNull().default(0),
  networkRxMbps: real("network_rx_mbps").notNull().default(0),
  networkTxMbps: real("network_tx_mbps").notNull().default(0),
  agentVersion: text("agent_version"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
