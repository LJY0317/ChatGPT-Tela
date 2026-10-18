/**
 * One bounded and payload-free eligibility contract shared by the browser preview
 * and the Native Work inspector. This reports eligibility; it grants no input,
 * Native-turn, or host-platform approval authority.
 */
export type CodexAgentApprovalReviewContract = Readonly<{
  readonly contractVersion: 1;
  readonly classification: "eligible_once" | "eligible_conversation" | "disabled"
    | "ambiguous" | "unrecognized" | "limit_reached";
  readonly nextAction: "existing_owned_turn_automation" | "human_browser_review";
  readonly agentMayApprove: false;
}>;

export function parseCodexAgentApprovalReview(value: unknown): CodexAgentApprovalReviewContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid agent approval review");
  }
  const item = value as Record<string, unknown>;
  const classification = item.classification;
  const hasEligibleChoice = classification === "eligible_once" || classification === "eligible_conversation";
  if (item.contractVersion !== 1 || item.agentMayApprove !== false
    || !["eligible_once", "eligible_conversation", "disabled", "ambiguous", "unrecognized", "limit_reached"].includes(String(classification))
    || item.nextAction !== (hasEligibleChoice ? "existing_owned_turn_automation" : "human_browser_review")) {
    throw new Error("unrecognized agent approval review");
  }
  return Object.freeze({
    contractVersion: 1,
    classification: classification as CodexAgentApprovalReviewContract["classification"],
    nextAction: item.nextAction as CodexAgentApprovalReviewContract["nextAction"],
    agentMayApprove: false,
  });
}

/** Snapshot of the provider's existing unresolved episode, never an approval grant. */
export interface CodexApprovalWaitContract {
  readonly phase: "pending" | "dispatch_sent" | "input_received" | "card_cleared" | "task_progress";
  readonly elapsedMs: number;
  readonly expiresAfterMs: 600000;
  readonly unverifiedDispatchCount: number;
  readonly operationState: "waiting" | "stopping";
}
export function parseCodexApprovalWait(value: unknown): CodexApprovalWaitContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid approval wait");
  const item = value as Record<string, unknown>;
  if (typeof item.phase !== "string"
    || !["pending", "dispatch_sent", "input_received", "card_cleared", "task_progress"].includes(item.phase)
    || !Number.isSafeInteger(item.elapsedMs) || (item.elapsedMs as number) < 0 || item.expiresAfterMs !== 600000
    || !Number.isSafeInteger(item.unverifiedDispatchCount) || (item.unverifiedDispatchCount as number) < 0
    || typeof item.operationState !== "string"
    || !["waiting", "stopping"].includes(item.operationState)) throw new Error("invalid approval wait");
  return Object.freeze({
    phase: item.phase as CodexApprovalWaitContract["phase"],
    elapsedMs: item.elapsedMs as number,
    expiresAfterMs: 600000,
    unverifiedDispatchCount: item.unverifiedDispatchCount as number,
    operationState: item.operationState as CodexApprovalWaitContract["operationState"],
  });
}
