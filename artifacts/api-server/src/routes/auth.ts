import { and, eq, gt, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, adminAccounts, adminSessions } from "@workspace/db";
import {
  GetSetupStatusResponse,
  LoginAdminBody,
  LoginAdminResponse,
  LogoutAdminResponse,
  SetupAdminBody,
  SetupAdminResponse,
} from "@workspace/api-zod";
import {
  checkRateLimit,
  hashPassword,
  hashSessionToken,
  newOpaqueToken,
  safeEqualString,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyPassword,
} from "../lib/security";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();
const SESSION_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
const dummyPasswordHash = hashPassword("not-a-real-user-password");

function setupToken(): string | null {
  const token = process.env.BHAI_SETUP_TOKEN;
  return token && token.length >= 32 ? token : null;
}

async function hasAdmin(): Promise<boolean> {
  const [account] = await db.select({ id: adminAccounts.id }).from(adminAccounts).limit(1);
  return Boolean(account);
}

async function currentAdmin(token: unknown) {
  if (typeof token !== "string" || token.length > 200) return null;
  const tokenHash = hashSessionToken(token);
  const [record] = await db
    .select({ id: adminAccounts.id, email: adminAccounts.email })
    .from(adminSessions)
    .innerJoin(adminAccounts, eq(adminSessions.adminId, adminAccounts.id))
    .where(and(eq(adminSessions.tokenHash, tokenHash), gt(adminSessions.expiresAt, new Date())))
    .limit(1);
  return record ?? null;
}

function state(configured: boolean, email: string | null, authenticated: boolean) {
  return GetSetupStatusResponse.parse({
    configured,
    authenticated,
    setupEnabled: !configured && Boolean(setupToken()),
    provisioner: process.env.BHAI_PROVISIONER === "libvirt" ? "libvirt" : "simulation",
    email,
  });
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api",
    maxAge: SESSION_TTL_MS,
  });
}

function authRateLimit(
  req: Request,
  res: Response,
  bucket: string,
  limit: number,
  identity?: string,
): boolean {
  // Account-specific buckets must not depend on the proxy's shared internal IP.
  const key = identity === undefined ? `${bucket}:${req.ip ?? "unknown"}` : `${bucket}:${identity}`;
  const result = checkRateLimit(key, limit, 15 * 60 * 1000);
  if (result.allowed) return true;
  res.setHeader("Retry-After", String(result.retryAfterSeconds));
  res.status(429).json({ error: "Too many attempts. Wait before trying again." });
  return false;
}

router.get("/auth/setup-status", async (req, res): Promise<void> => {
  const configured = await hasAdmin();
  const admin = await currentAdmin(req.cookies?.[SESSION_COOKIE]);
  res.json(state(configured, admin?.email ?? null, Boolean(admin)));
});

router.post("/auth/setup", async (req, res): Promise<void> => {
  if (!authRateLimit(req, res, "setup", 5)) return;
  const parsed = SetupAdminBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Provide a valid email and a password with at least 12 characters." });
    return;
  }

  const expected = setupToken();
  const supplied = parsed.data.setupToken ?? "";
  if (!expected || !safeEqualString(expected, supplied)) {
    res.status(403).json({
      error: expected
        ? "The setup token is invalid."
        : "Initial setup is disabled. Configure BHAI_SETUP_TOKEN with a random value of at least 32 characters.",
    });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const accountId = randomUUID();
  const sessionToken = newOpaqueToken();

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(71400517)`);
      const [existing] = await tx.select({ id: adminAccounts.id }).from(adminAccounts).limit(1);
      if (existing) throw new Error("ADMIN_ALREADY_CONFIGURED");
      await tx.insert(adminAccounts).values({
        id: accountId,
        email: parsed.data.email.toLowerCase(),
        passwordHash,
      });
      await tx.insert(adminSessions).values({
        adminId: accountId,
        tokenHash: hashSessionToken(sessionToken),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_ALREADY_CONFIGURED") {
      res.status(409).json({ error: "Admin setup has already been completed." });
      return;
    }
    throw error;
  }

  await db.delete(adminSessions).where(lt(adminSessions.expiresAt, new Date()));
  setSessionCookie(res, sessionToken);
  await recordAudit(parsed.data.email.toLowerCase(), "admin.setup", "admin", accountId);
  res.status(201).json(state(true, parsed.data.email.toLowerCase(), true));
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginAdminBody.safeParse(req.body);
  if (!parsed.success) {
    if (!authRateLimit(req, res, "login-invalid", 30)) return;
    res.status(400).json({ error: "Provide a valid email and password." });
    return;
  }
  if (!authRateLimit(req, res, "login", 8, parsed.data.email.toLowerCase())) return;

  const [account] = await db
    .select()
    .from(adminAccounts)
    .where(eq(adminAccounts.email, parsed.data.email.toLowerCase()))
    .limit(1);
  if (!account) {
    await verifyPassword(parsed.data.password, await dummyPasswordHash);
    res.status(401).json({ error: "Email or password is incorrect." });
    return;
  }
  if (!(await verifyPassword(parsed.data.password, account.passwordHash))) {
    res.status(401).json({ error: "Email or password is incorrect." });
    return;
  }

  const token = newOpaqueToken();
  await db.insert(adminSessions).values({
    adminId: account.id,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  await db.delete(adminSessions).where(lt(adminSessions.expiresAt, new Date()));
  setSessionCookie(res, token);
  await recordAudit(account.email, "admin.login", "admin", account.id);
  res.json(LoginAdminResponse.parse(state(true, account.email, true)));
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string" && token.length <= 200) {
    await db.delete(adminSessions).where(eq(adminSessions.tokenHash, hashSessionToken(token)));
  }
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api",
  });
  res.json(LogoutAdminResponse.parse({
    configured: await hasAdmin(),
    authenticated: false,
    setupEnabled: false,
    provisioner: process.env.BHAI_PROVISIONER === "libvirt" ? "libvirt" : "simulation",
    email: null,
  }));
});

router.get("/auth/session", async (req, res): Promise<void> => {
  const admin = await currentAdmin(req.cookies?.[SESSION_COOKIE]);
  if (!admin) {
    res.status(401).json({ error: "Sign in is required" });
    return;
  }
  res.json(state(true, admin.email, true));
});

export default router;
