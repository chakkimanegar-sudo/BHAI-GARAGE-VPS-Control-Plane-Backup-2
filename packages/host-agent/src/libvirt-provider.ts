import { execFile as execFileCallback } from "node:child_process";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentOperation, AgentOperationResult, VirtualizationProvider } from "./types.ts";
import { assertVpsConfiguration, type AgentConfig } from "./config.ts";

const execFile = promisify(execFileCallback);

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

  private async virsh(args: string[], timeout?: number): Promise<string> {
    return command("virsh", ["--connect", this.config.libvirtUri, ...args], timeout);
  }

  private async exists(domain: string): Promise<boolean> {
    // A successful inventory query distinguishes "not defined" from a broken
    // libvirt connection. Never treat an arbitrary command failure as absence.
    const output = await this.virsh(["list", "--all", "--name"], 10_000);
    return output.split(/\r?\n/).some((name) => name.trim() === domain);
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
        await this.virsh(["start", name]);
        break;
      case "stop":
        await this.virsh(["shutdown", name]);
        break;
      case "restart":
        await this.virsh(["reboot", name]);
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
    if (!validSshPublicKey(operation.sshPublicKey)) {
      throw new Error("A supported SSH public key is required for real VPS provisioning");
    }
    if (await this.exists(name)) {
      return { ipAddress: await this.findIp(name) };
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
    await mkdir(instanceDirectory, { recursive: true, mode: 0o750 });

    try {
      await command("qemu-img", [
        "create", "-f", "qcow2", "-F", "qcow2", "-b", resolvedBaseImage,
        diskPath, `${vps.diskGb}G`,
      ], 120_000);
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
      await command("cloud-localds", [seedPath, userDataPath, metaDataPath], 30_000);

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
        `<interface type='network'><source network='${xmlEscape(this.config.libvirtNetwork)}'/>` +
          "<model type='virtio'/></interface>",
        "<console type='pty'><target type='serial' port='0'/></console>",
        "</devices>",
        "</domain>",
        "",
      ].join("");
      const xmlPath = path.join(instanceDirectory, "domain.xml");
      await writeFile(xmlPath, domainXml, { mode: 0o600 });
      await this.virsh(["define", xmlPath]);
      await this.virsh(["start", name]);
      return { ipAddress: await this.findIp(name) };
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
