import { createHmac, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "bg_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export { SESSION_COOKIE, SESSION_TTL_MS };

export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashSessionToken(token: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
  return createHmac("sha256", secret).update(token).digest("hex");
}

export function safeEqualString(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  const sameBytes = timingSafeEqual(expectedDigest, actualDigest);
  return sameBytes && Buffer.byteLength(expected) === Buffer.byteLength(actual);
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltText, hashText, ...extra] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText || extra.length > 0) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = await scrypt(password, salt);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

type RateEntry = { count: number; resetAt: number };
const attempts = new Map<string, RateEntry>();

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  if (attempts.size > 2_000) {
    for (const [entryKey, entry] of attempts) {
      if (entry.resetAt <= now) attempts.delete(entryKey);
    }
  }
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (current.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}
