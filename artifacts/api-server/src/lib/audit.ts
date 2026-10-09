import { desc } from "drizzle-orm";
import { db, auditEvents } from "@workspace/db";

export async function recordAudit(
  actor: string,
  action: string,
  resourceType: string,
  resourceId: string | null = null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditEvents).values({ actor, action, resourceType, resourceId, details });
}

export async function recentAudit(limit: number) {
  return db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(limit);
}
