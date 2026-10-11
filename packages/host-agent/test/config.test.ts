import assert from "node:assert/strict";
import { test } from "node:test";
import { assertVpsConfiguration, readConfig } from "../src/config.ts";
import type { AgentOperation } from "../src/types.ts";

test("host-agent config requires HTTPS unless using the internal Docker network", () => {
  const base = {
    BHAI_AGENT_TOKEN: "x".repeat(48),
    BHAI_API_URL: "https://garage.example.com/api",
    BHAI_HOSTNAME: "kvm-01",
    BHAI_QEMU_GID: "640",
  };
  assert.equal(readConfig(base).apiUrl.protocol, "https:");
  assert.equal(readConfig(base).hostname, "kvm-01");
  assert.equal(readConfig(base).qemuGid, 640);
  assert.throws(() => readConfig({ ...base, BHAI_QEMU_GID: "" }), /BHAI_QEMU_GID must be set/);
  assert.throws(() => readConfig({ ...base, BHAI_QEMU_GID: "libvirt-qemu" }), /BHAI_QEMU_GID must be set/);
  assert.equal(readConfig({ ...base, BHAI_LIBVIRT_BRIDGE: "br-ex" }).libvirtBridge, "br-ex");
  assert.throws(
    () => readConfig({ ...base, BHAI_LIBVIRT_BRIDGE: "bridge-name-is-too-long" }),
    /valid Linux interface name/,
  );
  assert.throws(
    () => readConfig({ ...base, BHAI_LIBVIRT_BRIDGE: "br-ex; reboot" }),
    /valid Linux interface name/,
  );
  assert.throws(
    () => readConfig({ ...base, BHAI_API_URL: "http://garage.example.com/api" }),
    /must use HTTPS/,
  );
  assert.equal(
    readConfig({ ...base, BHAI_API_URL: "http://api:5000/api" }).apiUrl.hostname,
    "api",
  );
  assert.throws(
    () => readConfig({ ...base, LIBVIRT_URI: "qemu+ssh://root@host/system" }),
    /Only the local/,
  );
});

test("host agent rejects VPS commands outside the resource and image allowlist", () => {
  const operation: AgentOperation = {
    id: "00000000-0000-4000-8000-000000000001",
    action: "create",
    sshPublicKey: "ssh-ed25519 AAAA",
    vps: {
      id: "00000000-0000-4000-8000-000000000002",
      name: "safe-vps",
      hostId: "00000000-0000-4000-8000-000000000003",
      hostName: "host",
      ipAddress: null,
      osImage: "ubuntu-24.04",
      vcpus: 2,
      memoryMb: 2048,
      diskGb: 20,
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
  assert.doesNotThrow(() => assertVpsConfiguration(operation));
  assert.throws(
    () => assertVpsConfiguration({ ...operation, vps: { ...operation.vps, name: "safe;shutdown" } }),
    /invalid or unsupported/,
  );
  assert.throws(
    () => assertVpsConfiguration({ ...operation, vps: { ...operation.vps, osImage: "../etc/passwd" as AgentOperation["vps"]["osImage"] } }),
    /invalid or unsupported/,
  );
});
