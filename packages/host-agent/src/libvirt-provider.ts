import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentOperation, AgentOperationResult, PublicNetworkConfig, VirtualizationProvider } from "./types.ts";
import { assertVpsConfiguration, type AgentConfig } from "./config.ts";

const execFile = promisify(execFileCallback);

const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;
const MAC_PATTERN = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export function isValidPublicNetworkConfig(value: unknown): value is PublicNetworkConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (
    typeof config.ipAddress !== "string" || !IPV4_PATTERN.test(config.ipAddress) ||
    typeof config.gateway !== "string" || !IPV4_PATTERN.test(config.gateway) ||
    typeof config.macAddress !== "string" || !MAC_PATTERN.test(config.macAddress) ||
    !Number.isInteger(config.prefixLength) || Number(config.prefixLength) < 1 || Number(config.prefixLength) > 32 ||
    !Array.isArray(config.nameservers) || config.nameservers.length < 1 || config.nameservers.length > 4 ||
    !config.nameservers.every((value) => typeof value === "string" && IPV4_PATTERN.test(value))
  ) return false;

  const firstMacOctet = Number.parseInt(config.macAddress.slice(0, 2), 16);
  return Number.isFinite(firstMacOctet) && (firstMacOctet & 1) === 0;
}

export function renderCloudInitPublicNetwork(config: PublicNetworkConfig): string {
  if (!isValidPublicNetworkConfig(config)) {
    throw new Error("Invalid static public network configuration");
  }
  return [
    "version: 2",
    "ethernets:",
    "  public0:",
    "    match:",
    "      macaddress: '" + config.macAddress.toLowerCase() + "'",
    "    dhcp4: false",
    "    addresses:",
    "      - " + config.ipAddress + "/" + config.prefixLength,
    "    routes:",
    "      - to: 0.0.0.0/0",
    "        via: " + config.gateway,
    "        on-link: true",
    "    nameservers:",
    "      addresses:",
    ...config.nameservers.map((address) => "        - " + address),
    "",
  ].join("\n");
}

export function renderBridgeInterfaceXml(bridge: string, macAddress: string): string {
  if (!/^[A-Za-z0-9_.-]{1,15}$/.test(bridge) || !MAC_PATTERN.test(macAddress)) {
    throw new Error("Invalid public bridge name or virtual MAC address");
  }
  const escapedBridge = xmlEscape(bridge);
  const escapedMac = xmlEscape(macAddress.toLowerCase());
  return "<interface type='bridge'><mac address='" + escapedMac + "'/><source bridge='" + escapedBridge + "'/><model type='virtio'/></interface>";
}


const DOMAIN_STATE_TIMEOUT_MS = 120_000;
const DOMAIN_STATE_POLL_INTERVAL_MS = 1_000;

function normalizeDomainState(state: string): string {
  const normalized = state.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "shutoff" ? "shut off" : normalized;
}

export async function waitForDomainState(
  readState: () => Promise<string>,
  expectedStates: readonly string[],
  timeoutMs = DOMAIN_STATE_TIMEOUT_MS,
  pollIntervalMs = DOMAIN_STATE_POLL_INTERVAL_MS,
): Promise<string> {
  const expected = new Set(expectedStates.map(normalizeDomainState).filter(Boolean));
  if (expected.size === 0) {
    throw new Error("At least one expected libvirt domain state is required");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 ||
      !Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error("Invalid libvirt domain-state polling interval");
  }

  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";
  while (true) {
    try {
      lastState = normalizeDomainState(await readState()) || "unknown";
    } catch {
      throw new Error("Unable to verify VPS domain state through libvirt");
    }
    if (expected.has(lastState)) return lastState;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        "Timed out waiting for VPS state " + Array.from(expected).join(" or ") +
        "; last observed state: " + lastState,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }
}


async function command(program: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await execFile(program, args, {
    timeout,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    // Never expose the host-agent bearer token to virsh/qemu helper processes.
    env: {
      PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: process.env.HOME ?? "/",
      LANG: "C",
      LC_ALL: "C",
    },
  });
  return stdout;
}

function domainName(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid VPS identifier");
  return `bg-${id.replaceAll("-", "").toLowerCase()}`;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function validSshPublicKey(value: string | null): value is string {
  return Boolean(value && /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+(?: [^\r\n]{0,128})?$/.test(value));
}

export class LibvirtProvider implements VirtualizationProvider {
  private readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  async checkReady(): Promise<void> {
    const configuredImages = Object.entries(this.config.images)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
    if (configuredImages.length === 0) {
      throw new Error("At least one supported QCOW2 cloud image must be configured");
    }

    await access(this.config.storageDirectory, fsConstants.W_OK);
    const storage = await stat(this.config.storageDirectory);
    const agentUid = typeof process.getuid === "function" ? process.getuid() : storage.uid;
    if (!storage.isDirectory() || storage.uid !== agentUid) {
      throw new Error("VM storage must be a real directory owned by the host-agent UID");
    }
    const storageMode = storage.mode & 0o7777;
    if (storage.gid !== this.config.qemuGid || (storageMode & 0o2010) !== 0o2010) {
      throw new Error("VM storage must inherit the libvirt-qemu GID and have setgid + group-search permissions (2710); run prepare-kvm-host.sh --install");
    }
    const groups = new Set([
      ...(typeof process.getgroups === "function" ? process.getgroups() : []),
      ...(typeof process.getgid === "function" ? [process.getgid()] : []),
    ]);
    if (!groups.has(this.config.qemuGid)) {
      throw new Error("Host-agent lacks the libvirt-qemu supplementary group; set BHAI_QEMU_GID and recreate the host-agent container");
    }
    for (const entry of await readdir(this.config.storageDirectory, { withFileTypes: true })) {
      if (!entry.name.startsWith("bg-")) continue;
      const guestPath = path.join(this.config.storageDirectory, entry.name);
      const guest = await lstat(guestPath);
      const guestMode = guest.mode & 0o7777;
      if (!guest.isDirectory() || guest.uid !== agentUid || guest.gid !== this.config.qemuGid ||
          (guestMode & 0o2010) !== 0o2010) {
        throw new Error("Existing VPS directory has unsafe QEMU storage permissions: " + entry.name + "; run prepare-kvm-host.sh --install");
      }
    }
    const uri = (await this.virsh(["uri"], 10_000)).trim();
    if (uri !== this.config.libvirtUri) {
      throw new Error("The configured local libvirt connection is not available");
    }

    const capabilities = await this.virsh(["capabilities"], 10_000);
    const hostSection = capabilities.split("<host>", 2)[1]?.split("</host>", 1)[0] ?? "";
    const hostArchitecture = hostSection.includes("<arch>x86_64</arch>") ? "x86_64" : "";
    const x86Guest = (
      capabilities.split("<arch name='x86_64'", 2)[1]?.split("</arch>", 1)[0] ??
      capabilities.split('<arch name="x86_64"', 2)[1]?.split("</arch>", 1)[0] ??
      ""
    );
    const hasKvm = x86Guest.includes("type='kvm'") || x86Guest.includes('type="kvm"');
    if (hostArchitecture !== "x86_64" || !hasKvm) {
      throw new Error("This host must expose x86_64 KVM acceleration for VPS guests");
    }

    const networkInfo = await this.virsh(["net-info", this.config.libvirtNetwork], 10_000);
    if (!networkInfo.split("\n").some((line) => /^\s*Active:\s+yes\s*$/i.test(line))) {
      throw new Error(`The configured libvirt network "${this.config.libvirtNetwork}" must be active`);
    }

    const imageRoot = await realpath(this.config.imageDirectory);
    for (const [imageId, imagePath] of configuredImages) {
      const resolvedImage = await realpath(imagePath);
      if (!resolvedImage.startsWith(`${imageRoot}${path.sep}`)) {
        throw new Error(`Cloud image "${imageId}" must stay inside BHAI_IMAGE_DIRECTORY`);
      }
      if (!(await stat(resolvedImage)).isFile()) {
        throw new Error(`Cloud image "${imageId}" is not a regular file`);
      }
      let metadata: { format?: unknown };
      try {
        metadata = JSON.parse(await command("qemu-img", ["info", "--output=json", resolvedImage], 15_000)) as { format?: unknown };
      } catch {
        throw new Error(`Cloud image "${imageId}" could not be read by qemu-img`);
      }
      if (metadata.format !== "qcow2") {
        throw new Error(`Cloud image "${imageId}" must be in QCOW2 format`);
      }
    }

    await command("/bin/sh", ["-c", "command -v cloud-localds >/dev/null 2>&1"], 10_000);

    if (this.config.libvirtBridge) {
      let bridgeInfo: unknown;
      try {
        bridgeInfo = JSON.parse(await command("ip", ["-json", "-details", "link", "show", "dev", this.config.libvirtBridge], 10_000));
      } catch {
        throw new Error("Unable to inspect the configured public Linux bridge");
      }
      const link = Array.isArray(bridgeInfo) ? bridgeInfo[0] as Record<string, unknown> | undefined : undefined;
      const linkInfo = link?.linkinfo as Record<string, unknown> | undefined;
      if (linkInfo?.info_kind !== "bridge" || link?.operstate !== "UP") {
        throw new Error("The configured public bridge must exist, be a Linux bridge, and be UP");
      }
    }
  }

  private async virsh(args: string[], timeout?: number): Promise<string> {
    return command("virsh", ["--connect", this.config.libvirtUri, ...args], timeout);
  }

  private async exists(domain: string): Promise<boolean> {
    // A successful inventory query distinguishes "not defined" from a broken
    // libvirt connection. Never treat an arbitrary command failure as absence.
    const output = await this.virsh(["list", "--all", "--name"], 10_000);
    return output.split(/\r?\n/).some((name) => name.trim() === domain);
  }

  private async domainState(domain: string): Promise<string> {
    return normalizeDomainState(await this.virsh(["domstate", domain], 10_000));
  }

  private async waitForState(domain: string, expectedStates: readonly string[]): Promise<void> {
    await waitForDomainState(() => this.domainState(domain), expectedStates);
  }

  private async startDomain(domain: string): Promise<void> {
    const currentState = await this.domainState(domain);
    if (currentState === "running" || currentState === "idle") return;
    await this.virsh(["start", domain]);
    await this.waitForState(domain, ["running", "idle"]);
  }

  private async stopDomain(domain: string): Promise<void> {
    const currentState = await this.domainState(domain);
    if (currentState === "shut off") return;
    await this.virsh(["shutdown", domain]);
    await this.waitForState(domain, ["shut off"]);
  }

  private async removeDomainIfPresent(domain: string): Promise<void> {
    if (!(await this.exists(domain))) return;

    const state = (await this.virsh(["domstate", domain], 10_000)).trim().toLowerCase();
    const isStopped = state === "shut off" || state === "shutoff" || state === "crashed";
    if (!isStopped) {
      await this.virsh(["destroy", domain], 30_000);
    }

    try {
      await this.virsh(["undefine", domain, "--nvram"], 30_000);
    } catch {
      // Older libvirt versions may not support --nvram; try the portable form.
      if (await this.exists(domain)) {
        await this.virsh(["undefine", domain], 30_000);
      }
    }

    if (await this.exists(domain)) {
      throw new Error("Libvirt still reports the VPS domain after removal");
    }
  }

  private async findIp(domain: string): Promise<string | null> {
    try {
      const output = await this.virsh(["domifaddr", domain, "--source", "lease"], 15_000);
      const match = output.match(/\b((?:\d{1,3}\.){3}\d{1,3})\/\d{1,2}\b/);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }

  async execute(operation: AgentOperation): Promise<AgentOperationResult> {
    assertVpsConfiguration(operation);
    const name = domainName(operation.vps.id);
    switch (operation.action) {
      case "create":
        return this.create(operation, name);
      case "start":
        await this.startDomain(name);
        break;
      case "stop":
        await this.stopDomain(name);
        break;
      case "restart":
        await this.stopDomain(name);
        await this.startDomain(name);
        break;
      case "delete":
        await this.delete(name, operation.vps.id);
        return { ipAddress: null };
      default:
        throw new Error("Unsupported host operation");
    }
    return { ipAddress: await this.findIp(name) };
  }

  private async create(operation: AgentOperation, name: string): Promise<AgentOperationResult> {
    const vps = operation.vps;
    const publicNetwork = operation.publicNetwork ?? null;
    if (!validSshPublicKey(operation.sshPublicKey)) {
      throw new Error("A supported SSH public key is required for real VPS provisioning");
    }
    if (publicNetwork) {
      if (!this.config.libvirtBridge) {
        throw new Error("Public network requested but BHAI_LIBVIRT_BRIDGE is not configured");
      }
      if (!isValidPublicNetworkConfig(publicNetwork) || publicNetwork.ipAddress !== vps.ipAddress) {
        throw new Error("The assigned public IP, prefix, gateway, DNS, or virtual MAC is invalid");
      }
    }
    if (await this.exists(name)) {
      // A lost completion response can cause a create operation to be retried.
      // Do not mark that retry successful merely because the libvirt domain exists.
      const existingState = await this.domainState(name);
      if (existingState === "running" || existingState === "idle") {
        return { ipAddress: publicNetwork?.ipAddress ?? await this.findIp(name) };
      }
      if (existingState !== "shut off") {
        throw new Error("Existing VPS domain state cannot be safely reconciled; manual inspection is required");
      }
      await this.startDomain(name);
      return { ipAddress: publicNetwork?.ipAddress ?? await this.findIp(name) };
    }

    const baseImage = this.config.images[vps.osImage];
    if (!baseImage) {
      throw new Error(`No cloud image is configured for ${vps.osImage}`);
    }
    const imageRoot = await realpath(this.config.imageDirectory);
    const resolvedBaseImage = await realpath(baseImage);
    if (!resolvedBaseImage.startsWith(`${imageRoot}${path.sep}`)) {
      throw new Error("Configured cloud images must stay inside BHAI_IMAGE_DIRECTORY");
    }
    const imageInfo = await stat(resolvedBaseImage);
    if (!imageInfo.isFile()) throw new Error("Configured cloud image is not a regular file");

    const instanceDirectory = path.join(this.config.storageDirectory, name);
    const diskPath = path.join(instanceDirectory, "root.qcow2");
    const seedPath = path.join(instanceDirectory, "cloud-init.iso");
    const userDataPath = path.join(instanceDirectory, "user-data");
    const metaDataPath = path.join(instanceDirectory, "meta-data");
    await mkdir(instanceDirectory, { recursive: true, mode: 0o2710 });
    // The setgid parent makes new guest files inherit libvirt-qemu's group.
    // QEMU can traverse its folder without listing or writing another guest's folder.
    await chmod(instanceDirectory, 0o2710);

    try {
      await command("qemu-img", [
        "create", "-f", "qcow2", "-F", "qcow2", "-b", resolvedBaseImage,
        diskPath, `${vps.diskGb}G`,
      ], 120_000);
      // System QEMU needs group read/write on the mutable overlay, not world write.
      await chmod(diskPath, 0o660);
      await writeFile(userDataPath, [
        "#cloud-config",
        "ssh_pwauth: false",
        "disable_root: true",
        "ssh_authorized_keys:",
        `  - ${JSON.stringify(operation.sshPublicKey)}`,
        "",
      ].join("\n"), { mode: 0o600 });
      await writeFile(metaDataPath, [
        `instance-id: ${name}`,
        `local-hostname: ${vps.name}`,
        "",
      ].join("\n"), { mode: 0o600 });
      let cloudLocalDsArgs: string[];
      if (publicNetwork) {
        const networkConfigPath = path.join(instanceDirectory, "network-config");
        await writeFile(networkConfigPath, renderCloudInitPublicNetwork(publicNetwork), { mode: 0o600 });
        cloudLocalDsArgs = ["--network-config", networkConfigPath, seedPath, userDataPath, metaDataPath];
      } else {
        cloudLocalDsArgs = [seedPath, userDataPath, metaDataPath];
      }
      await command("cloud-localds", cloudLocalDsArgs, 30_000);
      // QEMU reads the seed ISO but never writes to it.
      await chmod(seedPath, 0o640);

      const networkInterfaceXml = publicNetwork
        ? renderBridgeInterfaceXml(this.config.libvirtBridge!, publicNetwork.macAddress)
        : "<interface type='network'><source network='" + xmlEscape(this.config.libvirtNetwork) + "'/><model type='virtio'/></interface>";

      const domainXml = [
        "<domain type='kvm'>",
        `<name>${name}</name>`,
        `<memory unit='MiB'>${vps.memoryMb}</memory>`,
        `<currentMemory unit='MiB'>${vps.memoryMb}</currentMemory>`,
        `<vcpu placement='static'>${vps.vcpus}</vcpu>`,
        "<os><type arch='x86_64' machine='q35'>hvm</type><boot dev='hd'/></os>",
        "<features><acpi/><apic/></features>",
        "<cpu mode='host-passthrough' check='none'/>",
        "<clock offset='utc'/>",
        "<on_poweroff>destroy</on_poweroff><on_reboot>restart</on_reboot><on_crash>destroy</on_crash>",
        "<devices>",
        `<disk type='file' device='disk'><driver name='qemu' type='qcow2' cache='none' discard='unmap'/>` +
          `<source file='${xmlEscape(diskPath)}'/><target dev='vda' bus='virtio'/></disk>`,
        `<disk type='file' device='cdrom'><driver name='qemu' type='raw'/>` +
          `<source file='${xmlEscape(seedPath)}'/><target dev='sda' bus='sata'/><readonly/></disk>`,
        networkInterfaceXml,
        "<console type='pty'><target type='serial' port='0'/></console>",
        "</devices>",
        "</domain>",
        "",
      ].join("");
      const xmlPath = path.join(instanceDirectory, "domain.xml");
      await writeFile(xmlPath, domainXml, { mode: 0o600 });
      await this.virsh(["define", xmlPath]);
      await this.virsh(["start", name]);
      await this.waitForState(name, ["running", "idle"]);
      return { ipAddress: publicNetwork?.ipAddress ?? await this.findIp(name) };
    } catch (error) {
      let rollbackConfirmed = false;
      try {
        await this.removeDomainIfPresent(name);
        rollbackConfirmed = true;
      } catch {
        // The VM may still reference these files. Preserve them if libvirt cleanup
        // cannot be confirmed, and preserve the original provisioning error.
      }
      if (rollbackConfirmed) {
        await rm(instanceDirectory, { recursive: true, force: true });
      } else {
        process.stderr.write(`${JSON.stringify({
          timestamp: new Date().toISOString(),
          service: "bhai-garage-host-agent",
          event: "provisioning-rollback-incomplete",
          domain: name,
          storagePreserved: true,
        })}\n`);
      }
      throw error;
    }
  }

  private async delete(name: string, id: string): Promise<void> {
    await this.removeDomainIfPresent(name);
    const instanceDirectory = path.resolve(this.config.storageDirectory, name);
    const expectedPrefix = `${path.resolve(this.config.storageDirectory)}${path.sep}`;
    if (!instanceDirectory.startsWith(expectedPrefix) || name !== domainName(id)) {
      throw new Error("Refusing to remove a disk outside the configured VPS storage directory");
    }
    await rm(instanceDirectory, { recursive: true, force: true });
  }
}
