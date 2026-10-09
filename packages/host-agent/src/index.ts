import { mkdir } from "node:fs/promises";
import { readConfig } from "./config.ts";
import { LibvirtProvider } from "./libvirt-provider.ts";
import { HostMetricsCollector } from "./metrics.ts";
import type { AgentOperation } from "./types.ts";

const config = readConfig();
const provider = new LibvirtProvider(config);
const metricsCollector = new HostMetricsCollector(config);
let shuttingDown = false;

function log(event: string, context: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    service: "bhai-garage-host-agent",
    event,
    ...context,
  })}\n`);
}

function apiEndpoint(path: string): URL {
  const url = new URL(config.apiUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return url;
}

async function requestJson<T>(
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T | null }> {
  const response = await fetch(apiEndpoint(path), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    return { status: response.status, data: null };
  }
  const data = await response.json() as T;
  return { status: response.status, data };
}

function parseOperation(value: unknown): AgentOperation | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const action = data.action;
  const allowedActions = ["create", "start", "stop", "restart", "delete"];
  if (
    typeof data.id !== "string" ||
    !allowedActions.includes(String(action)) ||
    !data.vps ||
    typeof data.vps !== "object"
  ) return null;
  const candidate = data.vps as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.osImage !== "string" ||
    typeof candidate.vcpus !== "number" ||
    typeof candidate.memoryMb !== "number" ||
    typeof candidate.diskGb !== "number"
  ) return null;
  if (data.sshPublicKey !== null && typeof data.sshPublicKey !== "string") return null;
  return data as unknown as AgentOperation;
}

async function complete(operation: AgentOperation, result: {
  success: boolean;
  ipAddress?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  const response = await requestJson(`agent/operations/${encodeURIComponent(operation.id)}/complete`, result);
  if (response.status !== 200) throw new Error(`Agent completion rejected with HTTP ${response.status}`);
}

async function runOnce(): Promise<void> {
  const metrics = await metricsCollector.collect();
  const heartbeat = await requestJson<{ accepted: boolean }>("agent/heartbeat", metrics);
  if (heartbeat.status !== 200) {
    log("heartbeat-rejected", { status: heartbeat.status });
    return;
  }

  const claim = await requestJson<{ operation?: unknown }>("agent/operations/next");
  if (claim.status !== 200) {
    log("operation-claim-rejected", { status: claim.status });
    return;
  }
  const operation = parseOperation(claim.data?.operation);
  if (!operation) return;

  log("operation-started", { operationId: operation.id, action: operation.action, vpsId: operation.vps.id });
  try {
    const result = await provider.execute(operation);
    await complete(operation, { success: true, ipAddress: result.ipAddress });
    log("operation-completed", { operationId: operation.id, success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Host operation failed";
    try {
      await complete(operation, { success: false, errorMessage: message });
      log("operation-completed", { operationId: operation.id, success: false });
    } catch {
      log("operation-result-not-accepted", { operationId: operation.id });
    }
  }
}

async function main(): Promise<void> {
  await mkdir(config.storageDirectory, { recursive: true, mode: 0o750 });
  log("started", {
    apiHost: config.apiUrl.hostname,
    pollIntervalMs: config.pollIntervalMs,
    provider: "libvirt",
  });

  process.on("SIGTERM", () => { shuttingDown = true; });
  process.on("SIGINT", () => { shuttingDown = true; });

  while (!shuttingDown) {
    try {
      await runOnce();
    } catch (error) {
      log("loop-error", { errorType: error instanceof Error ? error.name : "UnknownError" });
    }
    if (!shuttingDown) {
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  }
  log("stopped");
}

main().catch((error) => {
  log("startup-failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
  process.exitCode = 1;
});
