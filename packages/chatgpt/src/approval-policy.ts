export type ChatGptApprovalAutomationMode = "off" | "recognized_once";

/** Display-only, bounded classification of a public card warning. Never approval authority. */
export type ChatGptApprovalReviewReason =
  | "tool_description_policy_directive"
  | "suspicious_instruction"
  | "provider_warning";

export interface ChatGptApprovalCardObservation {
  readonly cardCount: number;
  /** Provider-observed warning; never eligible for automatic approval. */
  readonly requiresManualReview?: boolean;
  readonly reviewReason?: ChatGptApprovalReviewReason;
  readonly denyCount: number;
  readonly allowCount: number;
  readonly allowOnceCount: number;
  readonly alwaysAllowCount: number;
  readonly unknownCount: number;
}

export type ChatGptApprovalDecision =
  | { readonly action: "none"; readonly reason: "disabled" | "absent" | "ambiguous" | "unrecognized" | "manual_review" }
  | { readonly action: "approve_once"; readonly preferredChoice: "allow_once" };

/**
 * A finite per-accepted-Web-turn limit, not a timer or a quota reset on a DOM
 * revision. A new card is not evidence of a new owner or unlimited authority.
 */
export const MAX_RECOGNIZED_APPROVALS_PER_TURN = 8;

export type ChatGptAgentApprovalReview = Readonly<{
  readonly contractVersion: 1;
  readonly classification: "absent" | "eligible_once" | "manual_review"
    | "disabled" | "ambiguous" | "unrecognized" | "limit_reached";
  readonly nextAction: "none" | "existing_owned_turn_automation" | "human_browser_review";
  /** Existing turn-owned automation is distinct from a new agent/tool grant. */
  readonly agentMayApprove: false;
  readonly reviewReason?: ChatGptApprovalReviewReason;
}>;

/**
 * Decide from structural card evidence and the provider warning flag. No tool arguments,
 * prompt, or integration identity grants approval. Warnings and ambiguous cards fail closed.
 */
export function decideChatGptApproval(
  mode: ChatGptApprovalAutomationMode,
  observed: ChatGptApprovalCardObservation,
): ChatGptApprovalDecision {
  if (mode === "off") return Object.freeze({ action: "none", reason: "disabled" });
  if (observed.requiresManualReview) return Object.freeze({ action: "none", reason: "manual_review" });
  if (observed.cardCount === 0) return Object.freeze({ action: "none", reason: "absent" });
  if (observed.cardCount !== 1 || observed.denyCount !== 1
    || observed.allowCount > 1 || observed.allowOnceCount > 1
    || (observed.allowCount > 0 && observed.allowOnceCount > 0)
    || observed.alwaysAllowCount > 1 || observed.unknownCount !== 0) {
    return Object.freeze({ action: "none", reason: "ambiguous" });
  }
  if (observed.allowOnceCount === 1) {
    return Object.freeze({ action: "approve_once", preferredChoice: "allow_once" });
  }
  return Object.freeze({ action: "none", reason: "unrecognized" });
}

/**
 * Model-safe guidance from exactly the same structural policy as dispatch.
 * The consumer must separately prove current turn/surface ownership before
 * dispatch; this review never issues or enlarges approval authority.
 */
export function reviewChatGptApprovalForAgent(
  mode: ChatGptApprovalAutomationMode,
  observed?: ChatGptApprovalCardObservation,
  dispatchCount = 0,
): ChatGptAgentApprovalReview {
  if (!Number.isSafeInteger(dispatchCount) || dispatchCount < 0) {
    throw new Error("approval dispatch count is invalid");
  }
  if (!observed?.cardCount) {
    return Object.freeze({ contractVersion: 1, classification: "absent",
      nextAction: "none", agentMayApprove: false });
  }
  if (observed.requiresManualReview) {
    return Object.freeze({ contractVersion: 1, classification: "manual_review",
      nextAction: "human_browser_review", agentMayApprove: false,
      ...(observed.reviewReason ? { reviewReason: observed.reviewReason } : {}) });
  }
  const decision = decideChatGptApproval(mode, observed);
  const classification = decision.action === "approve_once"
    ? dispatchCount >= MAX_RECOGNIZED_APPROVALS_PER_TURN ? "limit_reached" : "eligible_once"
    : decision.reason;
  return Object.freeze({
    contractVersion: 1,
    classification,
    nextAction: classification === "eligible_once" ? "existing_owned_turn_automation"
      : "human_browser_review",
    agentMayApprove: false,
  });
}
