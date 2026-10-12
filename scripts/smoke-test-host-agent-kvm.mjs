#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { LibvirtProvider } from "../packages/host-agent/src/libvirt-provider.ts";

const execFile = promisify(execFileCallback);
const imageDirectory = process.env.BHAI_IMAGE_DIRECTORY ?? "/var/lib/libvirt/images/bhai-garage-base";
const storageDirectory = process.env.BHAI_VM_STORAGE ?? "/var/lib/libvirt/images/bhai-garage-vms";
const qemuGid = Number(process.env.BHAI_QEMU_GID);
const baseImage = path.join(imageDirectory, "noble-server-cloudimg-amd64.img");
if (!Number.isSafeInteger(qemuGid) || qemuGid < 1) {
  throw new Error("BHAI_QEMU_GID must be the numeric libvirt-qemu group ID");
}

const config = {
  apiUrl: new URL("http://127.0.0.1/api"),
  token: "kvm-live-smoke-test-token-".padEnd(48, "x"),
  hostname: os.hostname(),
  imageDirectory,
  storageDirectory,
  qemuGid,
  libvirtUri: "qemu:///system",
  libvirtNetwork: "default",
  images: { "ubuntu-24.04": baseImage },
  pollIntervalMs: 5000,
};
const provider = new LibvirtProvider(config);
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "bhai-garage-agent-kvm-"));
const keyPath = path.join(tempDirectory, "id_ed25519");
const vpsId = (await import("node:crypto")).randomUUID();
const domain = `bg-${vpsId.replaceAll("-", "").toLowerCase()}`;
const operationBase = {
  id: (await import("node:crypto")).randomUUID(),
  sshPublicKey: null,
  vps: {
    id: vpsId,
    name: "agent-kvm-smoke",
    hostId: null,
    hostName: os.hostname(),
    ipAddress: null,
    osImage: "ubuntu-24.04",
    vcpus: 1,
    memoryMb: 768,
    diskGb: 5,
    status: "provisioning",
    provider: "libvirt",
    cpuUsagePercent: 0,
    memoryUsedMb: 0,
    diskUsedGb: 0,
    networkRxMbps: 0,
    networkTxMbps: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
};
const operation = (action) => ({
  ...operationBase,
  id: crypto.randomUUID(),
  action,
  sshPublicKey: action === "create" ? publicKey : null,
  vps: { ...operationBase.vps, status: action === "create" ? "provisioning" : "running" },
});
let publicKey = "";
let created = false;

function log(message) {
  process.stdout.write(`[host-agent-live] ${message}\n`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function guestIp() {
  try {
    const { stdout } = await execFile("virsh", ["--connect", "qemu:///system", "domifaddr", domain, "--source", "lease"], { timeout: 15000 });
    return stdout.match(/\b((?:\d{1,3}\.){3}\d{1,3})\/\d{1,2}\b/)?.[1] ?? null;
  } catch {
    return null;
  }
}
async function ssh(ip, command) {
  return execFile("ssh", [
    "-i", keyPath,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=4",
    "-o", "LogLevel=ERROR",
    `ubuntu@${ip}`,
    command,
  ], { timeout: 12000 });
}
async function waitForGuestReady(phase) {
  const deadline = Date.now() + 240000;
  let lastError = "No DHCP lease yet";
  while (Date.now() < deadline) {
    const ip = await guestIp();
    if (ip) {
      try {
        await ssh(ip, "sudo -n cloud-init status --wait --long");
        const { stdout } = await ssh(ip, "sudo -n cloud-init status --long");
        assert.match(stdout, /status: done/);
        log(`${phase}: DHCP ${ip}, SSH and cloud-init status: done`);
        return ip;
      } catch (error) {
        lastError = String(error);
      }
    }
    await sleep(3000);
  }
  throw new Error(`${phase}: guest readiness timed out; last observation: ${lastError}`);
}

try {
  await provider.checkReady();
  log("Production host-agent preflight passed (KVM, libvirt, storage permissions, image and NAT network).");
  await execFile("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath], { timeout: 15000 });
  publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();

  const createResult = await provider.execute(operation("create"));
  created = true;
  assert.equal(typeof createResult, "object");
  log("Production LibvirtProvider.create completed.");
  await waitForGuestReady("create");

  await provider.execute(operation("stop"));
  assert.match((await execFile("virsh", ["--connect", "qemu:///system", "domstate", domain])).stdout.toLowerCase(), /shut off|shutoff/);
  log("Production LibvirtProvider.stop completed.");

  await provider.execute(operation("start"));
  await waitForGuestReady("start");
  log("Production LibvirtProvider.start completed.");

  await provider.execute(operation("restart"));
  await waitForGuestReady("restart");
  log("Production LibvirtProvider.restart completed.");

  await provider.execute(operation("delete"));
  created = false;
  const remaining = (await execFile("virsh", ["--connect", "qemu:///system", "list", "--all", "--name"])).stdout
    .split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  assert.equal(remaining.includes(domain), false, "host-agent delete must undefine the test domain");
  await assert.rejects(stat(path.join(storageDirectory, domain)), { code: "ENOENT" });
  log("Production LibvirtProvider.delete completed; domain and managed storage removed.");
  log("PASS: real KVM guest exercised through the actual host-agent provider lifecycle.");
} finally {
  if (created) {
    try {
      await provider.execute(operation("delete"));
      log("Cleanup: host-agent removed the test guest after an earlier failure.");
    } catch (error) {
      log(`CLEANUP WARNING: guest may need manual recovery; domain=${domain}; error=${String(error)}`);
    }
  }
  await rm(tempDirectory, { recursive: true, force: true });
}
