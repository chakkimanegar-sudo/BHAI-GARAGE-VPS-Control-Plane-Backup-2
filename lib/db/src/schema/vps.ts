import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  real,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { hosts } from "./hosts";

export const vpsInstances = pgTable(
  "vps_instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    hostId: uuid("host_id").references(() => hosts.id, { onDelete: "set null" }),
    ipAddress: text("ip_address"),
    osImage: text("os_image").notNull(),
    vcpus: integer("vcpus").notNull(),
    memoryMb: integer("memory_mb").notNull(),
    diskGb: integer("disk_gb").notNull(),
    status: text("status").notNull().default("provisioning"),
    provider: text("provider").notNull().default("simulation"),
    sshPublicKey: text("ssh_public_key"),
    cpuUsagePercent: real("cpu_usage_percent").notNull().default(0),
    memoryUsedMb: integer("memory_used_mb").notNull().default(0),
    diskUsedGb: real("disk_used_gb").notNull().default(0),
    networkRxMbps: real("network_rx_mbps").notNull().default(0),
    networkTxMbps: real("network_tx_mbps").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("vps_instances_name_unique").on(table.name)],
);
