import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LibvirtProvider, waitForDomainState } from "../src/libvirt-provider.ts";
import type { AgentConfig } from "../src/config.ts";
import type { AgentOperation } from "../src/types.ts";

const VPS_ID = "00000000-0000-4000-8000-000000000002";
const DOMAIN = `bg-${VPS_ID.replaceAll("-", "").toLowerCase()}`;

function operation(action: AgentOperation["action"]): AgentOperation {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    action,
    sshPublicKey: action === "create" ? "ssh-ed25519 AAAA ci-test" : null,
    vps: {
      id: VPS_ID,
      name: "lifecycle-vps",
      hostId: "00000000-0000-4000-8000-000000000003",
      hostName: "test-host",
      ipAddress: null,
      osImage: "ubuntu-24.04",
      vcpus: 2,
      memoryMb: 2048,
      diskGb: 20,
      status: "running",
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
}

async function executable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, { mode: 0o700 });
  await chmod(file, 0o700);
}

test("waitForDomainState waits until libvirt reports the requested state", async () => {
  const states = ["running", "in shutdown", "shut off"];
  let index = 0;
  const state = await waitForDomainState(
    async () => states[Math.min(index++, states.length - 1)]!,
    ["shut off"],
    500,
    1,
  );
  assert.equal(state, "shut off");
});

test("waitForDomainState rejects when the requested state is never observed", async () => {
  await assert.rejects(
    waitForDomainState(async () => "running", ["shut off"], 8, 1),
    /Timed out waiting for VPS state.*last observed state: running/,
  );
});

test("waitForDomainState fails closed when libvirt state cannot be read", async () => {
  await assert.rejects(
    waitForDomainState(async () => { throw new Error("do not expose raw command output"); }, ["running"], 10, 1),
    /Unable to verify VPS domain state through libvirt/,
  );
});

test("start, stop and restart wait for verified libvirt lifecycle states", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bhai-garage-lifecycle-test-"));
  const originalPath = process.env.PATH;
  const bin = path.join(root, "bin");
  const stateFile = path.join(root, "domain-state");
  const logFile = path.join(root, "actions.log");

  const config: AgentConfig = {
    apiUrl: new URL("https://garage.example.invalid/api"),
    token: "x".repeat(48),
    hostname: "test-host",
    imageDirectory: path.join(root, "images"),
    storageDirectory: path.join(root, "vms"),
    qemuGid: typeof process.getgid === "function" ? process.getgid() : 0,
    libvirtUri: "qemu:///system",
    libvirtNetwork: "default",
    images: {},
    pollIntervalMs: 5000,
  };

  try {
    await mkdir(bin, { recursive: true });
    await mkdir(config.storageDirectory, { recursive: true });
    await writeFile(stateFile, "shut off\n");
    await writeFile(logFile, "");
    await executable(path.join(bin, "virsh"), [
      "#!/bin/sh",
      'case "$3" in',
      '  domstate) cat "' + stateFile + '"; exit 0 ;;',
      '  start) printf "running\\n" > "' + stateFile + '"; printf "start\\n" >> "' + logFile + '"; exit 0 ;;',
      '  shutdown) printf "shut off\\n" > "' + stateFile + '"; printf "shutdown\\n" >> "' + logFile + '"; exit 0 ;;',
      '  domifaddr) exit 1 ;;',
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"));
    process.env.PATH = bin + ":" + (originalPath ?? "/usr/bin:/bin");

    const provider = new LibvirtProvider(config);
    await provider.execute(operation("start"));
    assert.equal((await readFile(stateFile, "utf8")).trim(), "running");

    await provider.execute(operation("stop"));
    assert.equal((await readFile(stateFile, "utf8")).trim(), "shut off");

    // Simulate an already-running guest and ensure restart has a complete
    // stopped -> started transition, rather than just accepting reboot request.
    await writeFile(stateFile, "running\n");
    await provider.execute(operation("restart"));
    assert.equal((await readFile(stateFile, "utf8")).trim(), "running");
    assert.equal(
      await readFile(logFile, "utf8"),
      "start\nshutdown\nshutdown\nstart\n",
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("retried create verifies an existing domain and restarts a shut-off guest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bhai-garage-create-retry-test-"));
  const originalPath = process.env.PATH;
  const bin = path.join(root, "bin");
  const stateFile = path.join(root, "domain-state");
  const logFile = path.join(root, "actions.log");

  const config: AgentConfig = {
    apiUrl: new URL("https://garage.example.invalid/api"),
    token: "x".repeat(48),
    hostname: "test-host",
    imageDirectory: path.join(root, "images"),
    storageDirectory: path.join(root, "vms"),
    qemuGid: typeof process.getgid === "function" ? process.getgid() : 0,
    libvirtUri: "qemu:///system",
    libvirtNetwork: "default",
    images: {},
    pollIntervalMs: 5000,
  };

  try {
    await mkdir(bin, { recursive: true });
    await mkdir(config.storageDirectory, { recursive: true });
    await writeFile(stateFile, "shut off\n");
    await writeFile(logFile, "");
    await executable(path.join(bin, "virsh"), [
      "#!/bin/sh",
      'case "$3" in',
      '  list) echo "' + DOMAIN + '"; exit 0 ;;',
      '  domstate) cat "' + stateFile + '"; exit 0 ;;',
      '  start) printf "running\\n" > "' + stateFile + '"; printf "start\\n" >> "' + logFile + '"; exit 0 ;;',
      '  domifaddr) exit 1 ;;',
      '  *) echo "unexpected command: $*" >&2; exit 90 ;;',
      "esac",
      "",
    ].join("\n"));
    process.env.PATH = bin + ":" + (originalPath ?? "/usr/bin:/bin");

    const provider = new LibvirtProvider(config);

    // A prior create may have succeeded even when the control plane lost the
    // completion response. Retry must restore a shut-off existing guest.
    await provider.execute(operation("create"));
    assert.equal((await readFile(stateFile, "utf8")).trim(), "running");
    assert.equal(await readFile(logFile, "utf8"), "start\n");

    // When the already-existing guest is running, a retry is idempotent.
    await provider.execute(operation("create"));
    assert.equal(await readFile(logFile, "utf8"), "start\n");

    // Ambiguous/active states such as paused must never be reported as a
    // successful create without reconciliation.
    await writeFile(stateFile, "paused\n");
    await assert.rejects(
      provider.execute(operation("create")),
      /Existing VPS domain state cannot be safely reconciled/,
    );
    assert.equal((await readFile(stateFile, "utf8")).trim(), "paused");
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

