export type RecoverableVpsStatus = "failed";

/**
 * If a host reaches the retry limit without returning a completion result, the
 * actual VM state is unknown: the command may have run before the response was
 * lost. Never claim the last requested/known status is still true.
 */
export function exhaustedOperationStatus(
  _action: string,
  _payload: Record<string, unknown> | null,
): RecoverableVpsStatus {
  return "failed";
}
