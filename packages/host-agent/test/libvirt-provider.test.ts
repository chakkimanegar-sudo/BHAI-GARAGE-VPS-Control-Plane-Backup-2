import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isValidPublicNetworkConfig, LibvirtProvider, renderBridgeInterfaceXml, renderCloudInitPublicNetwork } from "../src/libvirt-provider.ts";
import { HostMetricsCollector } from "../src/metrics.ts";
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
      name: "safe-vps",
      hostId: "00000000-0000-4000-8000-000000000003",
      hostName: "test-host",
      ipAddress: null,
      osImage: "ubuntu-24.04",
      vcpus: 2,
      memoryMb: 2048,
      diskGb: 20,
      status: action === "create" ? "provisioning" : "running",
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

test("static public network config renders a safe cloud-init bridge and rejects invalid values", () => {
  const publicNetwork = {
    ipAddress: "203.0.113.10",
    prefixLength: 32,
    gateway: "192.0.2.1",
    macAddress: "02:00:00:00:00:10",
    nameservers: ["1.1.1.1", "8.8.8.8"],
  };
  assert.equal(isValidPublicNetworkConfig(publicNetwork), true);
  const networkYaml = renderCloudInitPublicNetwork(publicNetwork);
  assert.match(networkYaml, /macaddress: '02:00:00:00:00:10'/);
  assert.match(networkYaml, /- 203\.0\.113\.10\/32/);
  assert.match(networkYaml, /via: 192\.0\.2\.1/);
  assert.match(networkYaml, /on-link: true/);
  assert.match(networkYaml, /- 1\.1\.1\.1/);
  const xml = renderBridgeInterfaceXml("br-ex", publicNetwork.macAddress);
  assert.match(xml, /interface type='bridge'/);
  assert.match(xml, /source bridge='br-ex'/);
  assert.match(xml, /mac address='02:00:00:00:00:10'/);
  assert.equal(isValidPublicNetworkConfig({ ...publicNetwork, macAddress: "01:00:00:00:00:10" }), false);
  assert.equal(isValidPublicNetworkConfig({ ...publicNetwork, ipAddress: "not-an-ip" }), false);
  assert.throws(() => renderBridgeInterfaceXml("bridge-name-that-is-too-long", publicNetwork.macAddress), /Invalid public bridge/);
});

test("a newly provisioned VPS directory grants libvirt-qemu search-only access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bhai-garage-vps-path-test-"));
  const originalPath = process.env.PATH;
  const bin = path.join(root, "bin");
  const images = path.join(root, "images");
  const storage = path.join(root, "vms");
  const image = path.join(images, "ubuntu-24.04.qcow2");
  const stateFile = path.join(root, "domain-state");
  const definedFile = path.join(root, "domain-defined");
  const config: AgentConfig = {
    apiUrl: new URL("https://garage.example.invalid/api"),
    token: "x".repeat(48),
    hostname: "test-host",
    imageDirectory: images,
    storageDirectory: storage,
    qemuGid: typeof process.getgid === "function" ? process.getgid() : 0,
    libvirtUri: "qemu:///system",
    libvirtNetwork: "default",
    images: { "ubuntu-24.04": image },
    pollIntervalMs: 5000,
  };

  try {
    await mkdir(bin, { recursive: true });
    await mkdir(images, { recursive: true });
    await mkdir(storage, { recursive: true, mode: 0o2710 });
    await chmod(storage, 0o2710);
    await writeFile(image, "fake cloud image");
    await writeFile(stateFile, "shut off\n");
    await executable(path.join(bin, "virsh"), [
      "#!/bin/sh",
      'case "$3" in',
      '  list) if [ -f "' + definedFile + '" ]; then echo "' + DOMAIN + '"; fi; exit 0 ;;',
      '  define) touch "' + definedFile + '"; printf "shut off\\n" > "' + stateFile + '"; exit 0 ;;',
      '  start) printf "running\\n" > "' + stateFile + '"; exit 0 ;;',
      '  domstate) cat "' + stateFile + '"; exit 0 ;;',
      '  domifaddr) exit 1 ;;',
      '  *) echo "unexpected command: $*" >&2; exit 90 ;;',
      "esac",
      "",
    ].join("\n"));
    await executable(path.join(bin, "qemu-img"), [
      "#!/bin/sh",
      'case "$1" in',
      '  create) touch "$8"; exit 0 ;;',
      '  *) exit 0 ;;',
      "esac",
      "",
    ].join("\n"));
    await executable(path.join(bin, "cloud-localds"), '#!/bin/sh\ntouch "$1"\nexit 0\n');
    process.env.PATH = bin + ":" + (originalPath ?? "/usr/bin:/bin");

    const provider = new LibvirtProvider(config);
    await provider.execute(operation("create"));

    const instanceDirectory = path.join(storage, DOMAIN);
    const directory = await stat(instanceDirectory);
    const disk = await stat(path.join(instanceDirectory, "root.qcow2"));
    const seed = await stat(path.join(instanceDirectory, "cloud-init.iso"));
    const qemuGid = typeof process.getgid === "function" ? process.getgid() : 0;
    assert.equal(directory.mode & 0o7777, 0o2710, "new VM directory must be setgid and group-searchable only");
    assert.equal(directory.gid, qemuGid, "new VM directory must inherit the libvirt-qemu group");
    assert.equal(disk.mode & 0o777, 0o660, "QEMU needs group read/write on the guest disk but no world access");
    assert.equal(disk.gid, qemuGid, "guest disk must inherit libvirt-qemu group");
    assert.equal(seed.mode & 0o777, 0o640, "QEMU needs group read-only access to cloud-init ISO");
    assert.equal(seed.gid, qemuGid, "cloud-init ISO must inherit libvirt-qemu group");
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("libvirt outages and unconfirmed rollback preserve VPS storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bhai-garage-libvirt-test-"));
  const originalPath = process.env.PATH;
  const bin = path.join(root, "bin");
  const images = path.join(root, "images");
  const storage = path.join(root, "vms");
  const image = path.join(images, "ubuntu-24.04.qcow2");
  const instanceDirectory = path.join(storage, DOMAIN);
  const disk = path.join(instanceDirectory, "root.qcow2");
  const stateFile = path.join(root, "domain-defined");
  const config: AgentConfig = {
    apiUrl: new URL("https://garage.example.invalid/api"),
    token: "x".repeat(48),
    hostname: "test-host",
    imageDirectory: images,
    storageDirectory: storage,
    qemuGid: typeof process.getgid === "function" ? process.getgid() : 0,
    libvirtUri: "qemu:///system",
    libvirtNetwork: "default",
    images: { "ubuntu-24.04": image },
    pollIntervalMs: 5000,
  };

  try {
    await mkdir(bin, { recursive: true });
    await mkdir(images, { recursive: true });
    await mkdir(instanceDirectory, { recursive: true });
    await chmod(storage, 0o2710);
    await chmod(instanceDirectory, 0o2710);
    await writeFile(image, "fake cloud image");
    await writeFile(disk, "keep this VPS disk");
    process.env.PATH = `${bin}:${originalPath ?? "/usr/bin:/bin"}`;

    // A libvirt connection error must not be interpreted as "domain absent".
    await executable(path.join(bin, "virsh"), "#!/bin/sh\nexit 1\n");
    const provider = new LibvirtProvider(config);
    assert.ok(new HostMetricsCollector(config));
    await assert.rejects(provider.checkReady());
    await assert.rejects(new LibvirtProvider({ ...config, images: {} }).checkReady(), /At least one supported QCOW2 cloud image/);
    await assert.rejects(provider.execute(operation("delete")));
    assert.equal(await readFile(disk, "utf8"), "keep this VPS disk");

    // Simulate a partial create: define succeeds, start fails, and undefine fails.
    // The provider must retain files because it cannot confirm the domain is gone.
    await rm(stateFile, { force: true });
    await executable(path.join(bin, "virsh"), [
      "#!/bin/sh",
      'case "$3" in',
      '  uri) echo "qemu:///system"; exit 0 ;;',
      "  capabilities) printf \"<capabilities><host><cpu><arch>x86_64</arch></cpu></host><guest><arch name='x86_64'><domain type='kvm'></domain></arch></guest></capabilities>\\n\"; exit 0 ;;",
      '  net-info) printf "Name: default\\nActive: yes\\n"; exit 0 ;;',
      '  list) if [ -f "' + stateFile + '" ]; then echo "' + DOMAIN + '"; fi; exit 0 ;;',
      '  define) touch "' + stateFile + '"; exit 0 ;;',
      '  domstate) echo "shut off"; exit 0 ;;',
      '  start|undefine) exit 1 ;;',
      '  *) exit 0 ;;',
      "esac",
      "",
    ].join("\n"));
    await executable(path.join(bin, "qemu-img"), [
      "#!/bin/sh",
      'case "$1" in',
      '  info) echo \'{"format":"qcow2"}\'; exit 0 ;;',
      '  create) touch "$8"; exit 0 ;;',
      '  *) exit 0 ;;',
      "esac",
      "",
    ].join("\n"));
    await executable(path.join(bin, "cloud-localds"), '#!/bin/sh\ntouch "$1"\nexit 0\n');

    await provider.checkReady();
    await assert.rejects(provider.execute(operation("create")));
    assert.equal(await readFile(disk, "utf8"), "keep this VPS disk");
    assert.equal(await readFile(stateFile, "utf8").then(() => true, () => false), true);
    const instanceMode = (await stat(instanceDirectory)).mode & 0o7777;
    assert.equal(instanceMode, 0o2710, "VPS directory must provide private setgid traversal through the QEMU group");
    assert.equal((await readFile(path.join(instanceDirectory, "user-data"), "utf8")).includes("ssh_authorized_keys"), true);
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});
