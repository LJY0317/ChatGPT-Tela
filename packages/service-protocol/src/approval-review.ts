/** Snapshot of the provider's existing unresolved episode, never an approval grant. */
export interface CodexApprovalWaitContract {
  readonly phase: "pending" | "dispatch_sent" | "input_received" | "card_cleared" | "task_progress";
  readonly elapsedMs: number;
  readonly unverifiedDispatchCount: number;
  readonly operationState: "waiting" | "stopping";
}
export function parseCodexApprovalWait(value: unknown): CodexApprovalWaitContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid approval wait");
  const item = value as Record<string, unknown>;
  if (typeof item.phase !== "string"
    || !["pending", "dispatch_sent", "input_received", "card_cleared", "task_progress"].includes(item.phase)
    || !Number.isSafeInteger(item.elapsedMs) || (item.elapsedMs as number) < 0
    || !Number.isSafeInteger(item.unverifiedDispatchCount) || (item.unverifiedDispatchCount as number) < 0
    || typeof item.operationState !== "string"
    || !["waiting", "stopping"].includes(item.operationState)) throw new Error("invalid approval wait");
  return Object.freeze({
    phase: item.phase as CodexApprovalWaitContract["phase"],
    elapsedMs: item.elapsedMs as number,
    unverifiedDispatchCount: item.unverifiedDispatchCount as number,
    operationState: item.operationState as CodexApprovalWaitContract["operationState"],
  });
}
