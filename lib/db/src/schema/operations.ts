import { jsonb, integer, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hosts } from "./hosts";
import { vpsInstances } from "./vps";

export const agentOperations = pgTable("agent_operations", {
  id: uuid("id").defaultRandom().primaryKey(),
  hostId: uuid("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  vpsId: uuid("vps_id").references(() => vpsInstances.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  state: text("state").notNull().default("queued"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("agent_operations_one_active_vps_idx")
    .on(table.vpsId)
    .where(sql`${table.vpsId} is not null and ${table.state} in ('queued', 'claimed')`),
]);
