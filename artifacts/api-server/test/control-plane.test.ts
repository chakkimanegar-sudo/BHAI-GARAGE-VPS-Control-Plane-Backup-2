import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, adminAccounts, agentOperations, auditEvents, hosts, vpsInstances } from "@workspace/db";
import { hashAgentToken, hashPassword, newOpaqueToken } from "../src/lib/security.ts";
import app from "../src/app.ts";

const testEmail = `control-plane-${randomUUID()}@example.invalid`;
const testPassword = randomBytes(24).toString("base64url");
const testVpsName = `test-${randomUUID().slice(0, 8)}`;
let adminId = "";
let server: ReturnType<typeof app.listen> | undefined;
let apiBase = "";
let cookie = "";
let createdVpsId: string | null = null;
let adminWasCreated = false;

before(async () => {
  process.env.BHAI_PROVISIONER = "simulation";
  const passwordHash = await hashPassword(testPassword);
  const [account] = await db.insert(adminAccounts).values({
    email: testEmail,
    passwordHash,
  }).returning();
  adminId = account.id;
  adminWasCreated = true;

  server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP address");
  apiBase = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
  }
  if (createdVpsId) {
    await db.delete(vpsInstances).where(eq(vpsInstances.id, createdVpsId));
    await db.delete(auditEvents).where(eq(auditEvents.resourceId, createdVpsId));
  }
  if (adminWasCreated) {
    await db.delete(auditEvents).where(eq(auditEvents.actor, testEmail));
    await db.delete(adminAccounts).where(eq(adminAccounts.id, adminId));
  }
  await pool.end();
});

test("login issues an HttpOnly admin session and rejects wrong credentials", async () => {
  const wrongPassword = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: "incorrect" }),
  });
  assert.equal(wrongPassword.status, 401);

  const response = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { authenticated: boolean; email: string };
  assert.equal(body.authenticated, true);
  assert.equal(body.email, testEmail);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie?.includes("bg_session="));
  assert.ok(setCookie?.includes("HttpOnly"));
  assert.ok(setCookie?.includes("SameSite=Strict"));
  cookie = setCookie!.split(";", 1)[0];
});

test("admin API validation rejects invalid allocations and writes real persistent VPS data", async () => {
  const unauthenticated = await fetch(`${apiBase}/dashboard`);
  assert.equal(unauthenticated.status, 401);

  const invalid = await fetch(`${apiBase}/vps`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: testVpsName,
      osImage: "ubuntu-24.04",
      vcpus: 0,
      memoryMb: 128,
      diskGb: 1,
    }),
  });
  assert.equal(invalid.status, 400);

  const created = await fetch(`${apiBase}/vps`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: testVpsName,
      osImage: "ubuntu-24.04",
      vcpus: 2,
      memoryMb: 2048,
      diskGb: 20,
    }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { vps: { id: string; status: string; provider: string } };
  createdVpsId = createdBody.vps.id;
  assert.equal(createdBody.vps.status, "running");
  assert.equal(createdBody.vps.provider, "simulation");

  const detail = await fetch(`${apiBase}/vps/${createdVpsId}`, { headers: { cookie } });
  assert.equal(detail.status, 200);
  const saved = await detail.json() as { name: string; ipAddress: string };
  assert.equal(saved.name, testVpsName);
  assert.match(saved.ipAddress, /^192\.168\.122\./);
});

test("VPS lifecycle actions persist, audit, and delete correctly in simulation", async () => {
  assert.ok(createdVpsId, "previous test must create an instance");
  for (const [action, expectedStatus] of [
    ["stop", "stopped"],
    ["start", "running"],
    ["restart", "running"],
  ] as const) {
    const response = await fetch(`${apiBase}/vps/${createdVpsId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ action }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { vps: { status: string }; queued: boolean };
    assert.equal(body.vps.status, expectedStatus);
    assert.equal(body.queued, false);
  }

  const audit = await fetch(`${apiBase}/audit?limit=10`, { headers: { cookie } });
  assert.equal(audit.status, 200);
  const events = await audit.json() as Array<{ action: string }>;
  assert.ok(events.some((event) => event.action === "vps.stop.simulated"));

  const deleted = await fetch(`${apiBase}/vps/${createdVpsId}/delete`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(deleted.status, 200);
  const deletion = await deleted.json() as { deleted: boolean; queued: boolean };
  assert.equal(deletion.deleted, true);
  assert.equal(deletion.queued, false);

  const missing = await fetch(`${apiBase}/vps/${createdVpsId}`, { headers: { cookie } });
  assert.equal(missing.status, 404);
  createdVpsId = null;
});

test("logout revokes the persisted session", async () => {
  const logout = await fetch(`${apiBase}/auth/logout`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${apiBase}/dashboard`, { headers: { cookie } });
  assert.equal(afterLogout.status, 401);
});


test("host-agent polling recovers exhausted stale operations and restores VPS inventory state", async () => {
  const hostName = `recovery-${randomUUID().slice(0, 8)}`;
  const agentToken = newOpaqueToken();
  const [host] = await db.insert(hosts).values({
    name: hostName,
    tokenHash: hashAgentToken(agentToken),
    simulation: 0,
  }).returning();
  const vpsIds: string[] = [];

  try {
    const instances = await db.insert(vpsInstances).values([
      {
        name: `recovery-create-${randomUUID().slice(0, 8)}`,
        hostId: host.id,
        osImage: "ubuntu-24.04",
        vcpus: 2,
        memoryMb: 2048,
        diskGb: 20,
        status: "provisioning",
        provider: "libvirt",
      },
      {
        name: `recovery-delete-${randomUUID().slice(0, 8)}`,
        hostId: host.id,
        osImage: "ubuntu-24.04",
        vcpus: 2,
        memoryMb: 2048,
        diskGb: 20,
        status: "deleting",
        provider: "libvirt",
      },
    ]).returning();
    vpsIds.push(...instances.map((instance) => instance.id));

    const staleClaimedAt = new Date(Date.now() - 6 * 60 * 1000);
    const operations = await db.insert(agentOperations).values([
      {
        hostId: host.id,
        vpsId: instances[0]!.id,
        action: "create",
        state: "claimed",
        attempts: 10,
        claimedAt: staleClaimedAt,
        payload: { sshPublicKey: "ssh-ed25519 AAAA" },
      },
      {
        hostId: host.id,
        vpsId: instances[1]!.id,
        action: "delete",
        state: "claimed",
        attempts: 10,
        claimedAt: staleClaimedAt,
        payload: { previousStatus: "running" },
      },
    ]).returning();

    const response = await fetch(`${apiBase}/agent/operations/next`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { operation: unknown | null };
    assert.equal(body.operation, null);

    const [createVps] = await db.select().from(vpsInstances).where(eq(vpsInstances.id, instances[0]!.id));
    const [deletingVps] = await db.select().from(vpsInstances).where(eq(vpsInstances.id, instances[1]!.id));
    const [createOperation] = await db.select().from(agentOperations).where(eq(agentOperations.id, operations[0]!.id));
    const [stopOperation] = await db.select().from(agentOperations).where(eq(agentOperations.id, operations[1]!.id));

    assert.equal(createVps?.status, "failed");
    assert.equal(deletingVps?.status, "running");
    assert.equal(createOperation?.state, "failed");
    assert.equal(stopOperation?.state, "failed");

    for (const vpsId of vpsIds) {
      const events = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, vpsId));
      assert.ok(events.some((event) => event.action === "agent.operation.exhausted"));
    }
  } finally {
    await db.delete(agentOperations).where(eq(agentOperations.hostId, host.id));
    await db.delete(auditEvents).where(eq(auditEvents.actor, `host-agent:${hostName}`));
    for (const vpsId of vpsIds) {
      await db.delete(auditEvents).where(eq(auditEvents.resourceId, vpsId));
      await db.delete(vpsInstances).where(eq(vpsInstances.id, vpsId));
    }
    await db.delete(hosts).where(eq(hosts.id, host.id));
  }
});
