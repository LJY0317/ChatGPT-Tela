/** A conversation grant requires an explicitly selected mode AND an exact provider choice. */
export type ChatGptApprovalAutomationMode = "off" | "recognized_once" | "recognized_conversation";

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
  /** Provider card-local connector heading proves generic Allow is this action. */
  readonly genericAllowIsCurrentAction?: boolean;
  readonly allowOnceCount: number;
  readonly allowConversationCount?: number;
  readonly alwaysAllowCount: number;
  readonly unknownCount: number;
}

export type ChatGptApprovalDecision =
  | { readonly action: "none"; readonly reason: "disabled" | "absent" | "ambiguous" | "unrecognized" | "manual_review" }
  | { readonly action: "approve_once"; readonly preferredChoice: "allow_once" | "allow" }
  | { readonly action: "approve_conversation"; readonly preferredChoice: "allow_conversation" };

export type ChatGptAgentApprovalReview = Readonly<{
  readonly contractVersion: 1;
  readonly classification: "absent" | "eligible_once" | "eligible_conversation" | "manual_review"
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
  if (observed.cardCount !== 1) return Object.freeze({ action: "none", reason: "ambiguous" });
  // Candidate metadata (Deny, disclosures, persistent alternatives and unrelated
  // controls) does not decide whether the exact requested choice is unique.
  const choices = mode === "recognized_conversation"
    ? [[observed.allowConversationCount ?? 0, "allow_conversation"],
      [observed.allowOnceCount, "allow_once"], [observed.genericAllowIsCurrentAction ? observed.allowCount : 0, "allow"]] as const
    : [[observed.allowOnceCount, "allow_once"], [observed.genericAllowIsCurrentAction ? observed.allowCount : 0, "allow"]] as const;
  for (const [count, choice] of choices) {
    if (count > 1) return Object.freeze({ action: "none", reason: "ambiguous" });
    if (count === 1) return choice === "allow_conversation"
      ? Object.freeze({ action: "approve_conversation", preferredChoice: choice })
      : Object.freeze({ action: "approve_once", preferredChoice: choice });
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
  unverifiedDispatchCount = 0,
): ChatGptAgentApprovalReview {
  if (!Number.isSafeInteger(unverifiedDispatchCount) || unverifiedDispatchCount < 0) {
    throw new Error("unverified approval count is invalid");
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
    || decision.action === "approve_conversation"
    ? unverifiedDispatchCount > 0 ? "limit_reached"
      : decision.action === "approve_conversation" ? "eligible_conversation" : "eligible_once"
    : decision.reason;
  return Object.freeze({
    contractVersion: 1,
    classification,
    nextAction: classification === "eligible_once" || classification === "eligible_conversation"
      ? "existing_owned_turn_automation"
      : "human_browser_review",
    agentMayApprove: false,
  });
}
