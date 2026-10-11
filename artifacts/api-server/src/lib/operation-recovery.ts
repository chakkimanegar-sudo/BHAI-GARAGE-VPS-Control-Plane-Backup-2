export type RecoverableVpsStatus = "running" | "stopped" | "failed";

/**
 * Decide the safe inventory state after a host operation exhausts its retries.
 * A create request cannot assume that a VM exists; other lifecycle actions revert
 * to the state recorded when they were queued.
 */
export function exhaustedOperationStatus(
  action: string,
  payload: Record<string, unknown> | null,
): RecoverableVpsStatus {
  if (action === "create") return "failed";

  const previousStatus = payload?.previousStatus;
  if (
    previousStatus === "running" ||
    previousStatus === "stopped" ||
    previousStatus === "failed"
  ) {
    return previousStatus;
  }
  return "failed";
}
