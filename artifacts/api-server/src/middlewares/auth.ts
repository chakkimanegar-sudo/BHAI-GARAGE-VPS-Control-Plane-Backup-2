import { and, eq, gt } from "drizzle-orm";
import type { RequestHandler } from "express";
import { db, adminAccounts, adminSessions, hosts } from "@workspace/db";
import { hashAgentToken, hashSessionToken, SESSION_COOKIE } from "../lib/security";

declare global {
  namespace Express {
    interface Locals {
      admin?: { id: string; email: string };
      host?: { id: string; name: string; simulation: number };
    }
  }
}

export const requireAdmin: RequestHandler = async (req, res, next): Promise<void> => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string" || token.length > 200) {
    res.status(401).json({ error: "Sign in is required" });
    return;
  }

  const tokenHash = hashSessionToken(token);
  const [record] = await db
    .select({ id: adminAccounts.id, email: adminAccounts.email })
    .from(adminSessions)
    .innerJoin(adminAccounts, eq(adminSessions.adminId, adminAccounts.id))
    .where(and(eq(adminSessions.tokenHash, tokenHash), gt(adminSessions.expiresAt, new Date())))
    .limit(1);

  if (!record) {
    res.clearCookie(SESSION_COOKIE, { path: "/api", sameSite: "strict" });
    res.status(401).json({ error: "Sign in is required" });
    return;
  }

  res.locals.admin = record;
  next();
};

export const requireHostAgent: RequestHandler = async (req, res, next): Promise<void> => {
  const authorization = req.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization);
  if (!match) {
    res.status(401).json({ error: "Valid host-agent bearer token is required" });
    return;
  }

  const tokenHash = hashAgentToken(match[1]);
  const [host] = await db
    .select({ id: hosts.id, name: hosts.name, simulation: hosts.simulation })
    .from(hosts)
    .where(eq(hosts.tokenHash, tokenHash))
    .limit(1);

  if (!host || host.simulation === 1) {
    res.status(401).json({ error: "Host-agent token is invalid" });
    return;
  }

  res.locals.host = host;
  next();
};
