export type OsImage =
  | "ubuntu-24.04"
  | "ubuntu-22.04"
  | "debian-12"
  | "rocky-9";

export type AgentAction = "create" | "start" | "stop" | "restart" | "delete";

export interface VpsInstance {
  id: string;
  name: string;
  hostId: string | null;
  hostName: string | null;
  ipAddress: string | null;
  osImage: OsImage;
  vcpus: number;
  memoryMb: number;
  diskGb: number;
  status: "provisioning" | "running" | "stopped" | "deleting" | "failed";
  provider: "simulation" | "libvirt";
  cpuUsagePercent: number;
  memoryUsedMb: number;
  diskUsedGb: number;
  networkRxMbps: number;
  networkTxMbps: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicNetworkConfig {
  ipAddress: string;
  prefixLength: number;
  gateway: string;
  macAddress: string;
  nameservers: string[];
}

export interface AgentOperation {
  id: string;
  action: AgentAction;
  vps: VpsInstance;
  sshPublicKey: string | null;
  publicNetwork?: PublicNetworkConfig | null;
}

export interface HostMetrics {
  hostname: string;
  agentVersion: string;
  totalVcpus: number;
  cpuUsagePercent: number;
  totalMemoryMb: number;
  usedMemoryMb: number;
  diskTotalGb: number;
  diskUsedGb: number;
  networkRxMbps: number;
  networkTxMbps: number;
}

export interface AgentOperationResult {
  ipAddress: string | null;
}

export interface VirtualizationProvider {
  execute(operation: AgentOperation): Promise<AgentOperationResult>;
}
