import path from "node:path";
import type { OsImage } from "./types.ts";

export interface AgentConfig {
  apiUrl: URL;
  token: string;
  hostname: string | null;
  imageDirectory: string;
  storageDirectory: string;
  libvirtUri: string;
  libvirtNetwork: string;
  images: Partial<Record<OsImage, string>>;
  pollIntervalMs: number;
}

const IMAGE_IDS: OsImage[] = [
  "ubuntu-24.04",
  "ubuntu-22.04",
  "debian-12",
  "rocky-9",
];

export function readConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const rawApiUrl = env.BHAI_API_URL;
  const token = env.BHAI_AGENT_TOKEN;
  if (!rawApiUrl || !token) {
    throw new Error("BHAI_API_URL and BHAI_AGENT_TOKEN must be configured");
  }
  const apiUrl = new URL(rawApiUrl);
  const isLocal = ["localhost", "127.0.0.1", "::1", "api"].includes(apiUrl.hostname);
  if (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && isLocal)) {
    throw new Error("BHAI_API_URL must use HTTPS except on localhost or the internal Docker network");
  }
  if (!apiUrl.pathname.endsWith("/api")) {
    throw new Error("BHAI_API_URL must include the /api base path");
  }
  if (token.length < 32 || token.length > 128) {
    throw new Error("BHAI_AGENT_TOKEN must be between 32 and 128 characters");
  }

  let images: Partial<Record<OsImage, string>> = {};
  if (env.BHAI_IMAGES_JSON) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.BHAI_IMAGES_JSON);
    } catch {
      throw new Error("BHAI_IMAGES_JSON must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("BHAI_IMAGES_JSON must map allowed image IDs to QCOW2 file paths");
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!IMAGE_IDS.includes(key as OsImage) || typeof value !== "string" || !path.isAbsolute(value)) {
        throw new Error("BHAI_IMAGES_JSON contains an unsupported image ID or non-absolute path");
      }
      images[key as OsImage] = value;
    }
  }

  const pollMs = Number(env.BHAI_AGENT_POLL_MS ?? 5000);
  if (!Number.isInteger(pollMs) || pollMs < 2000 || pollMs > 60_000) {
    throw new Error("BHAI_AGENT_POLL_MS must be between 2000 and 60000");
  }
  const libvirtNetwork = env.BHAI_LIBVIRT_NETWORK ?? "default";
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(libvirtNetwork)) {
    throw new Error("BHAI_LIBVIRT_NETWORK contains unsupported characters");
  }

  const libvirtUri = env.LIBVIRT_URI ?? "qemu:///system";
  if (libvirtUri !== "qemu:///system") {
    throw new Error("Only the local qemu:///system libvirt socket is supported");
  }
  const hostname = env.BHAI_HOSTNAME?.trim() || null;
  if (hostname && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/.test(hostname)) {
    throw new Error("BHAI_HOSTNAME must be a valid host label");
  }

  return {
    apiUrl,
    token,
    hostname,
    imageDirectory: path.resolve(env.BHAI_IMAGE_DIRECTORY ?? "/var/lib/bhai-garage/images"),
    storageDirectory: path.resolve(env.BHAI_VM_STORAGE ?? "/var/lib/bhai-garage/vms"),
    libvirtUri,
    libvirtNetwork,
    images,
    pollIntervalMs: pollMs,
  };
}

export function assertVpsConfiguration(operation: AgentOperationShape): void {
  const vps = operation.vps;
  if (
    !/^[0-9a-f-]{36}$/i.test(vps.id) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]{1,47}$/.test(vps.name) ||
    !IMAGE_IDS.includes(vps.osImage) ||
    !Number.isInteger(vps.vcpus) || vps.vcpus < 1 || vps.vcpus > 32 ||
    !Number.isInteger(vps.memoryMb) || vps.memoryMb < 512 || vps.memoryMb > 262144 ||
    !Number.isInteger(vps.diskGb) || vps.diskGb < 5 || vps.diskGb > 5000
  ) {
    throw new Error("VPS operation contains invalid or unsupported configuration");
  }
}

type AgentOperationShape = {
  vps: {
    id: string;
    name: string;
    osImage: OsImage;
    vcpus: number;
    memoryMb: number;
    diskGb: number;
  };
};
