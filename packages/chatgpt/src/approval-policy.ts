export type ChatGptApprovalAutomationMode = "off" | "full_access";

export interface ChatGptApprovalCardObservation {
  readonly cardCount: number;
  readonly denyCount: number;
  readonly allowCount: number;
  readonly allowOnceCount: number;
  readonly allowConversationCount?: number;
  readonly alwaysAllowCount: number;
  readonly unknownCount: number;
}

export type ChatGptApprovalDecision =
  | { readonly action: "none"; readonly reason: "disabled" | "absent" | "ambiguous" | "unrecognized" }
  | { readonly action: "approve_once"; readonly preferredChoice: "allow_once" | "allow" }
  | { readonly action: "approve_conversation"; readonly preferredChoice: "allow_conversation" };

export type ChatGptAgentApprovalReview = Readonly<{
  readonly contractVersion: 1;
  readonly classification: "absent" | "eligible_once" | "eligible_conversation"
    | "disabled" | "ambiguous" | "unrecognized" | "limit_reached";
  readonly nextAction: "none" | "existing_owned_turn_automation" | "human_browser_review";
  /** Existing turn-owned automation is distinct from a new agent/tool grant. */
  readonly agentMayApprove: false;
}>;

/**
 * Resolve one currently observed card to one visible choice. Card text and
 * connector names do not participate in this decision.
 */
export function decideChatGptApproval(
  mode: ChatGptApprovalAutomationMode,
  observed: ChatGptApprovalCardObservation,
): ChatGptApprovalDecision {
  if (mode === "off") return Object.freeze({ action: "none", reason: "disabled" });
  if (observed.cardCount === 0) return Object.freeze({ action: "none", reason: "absent" });
  if (observed.cardCount !== 1) return Object.freeze({ action: "none", reason: "ambiguous" });
  if ((observed.denyCount ?? 0) > 1) return Object.freeze({ action: "none", reason: "ambiguous" });
  if ((observed.denyCount ?? 0) !== 1) return Object.freeze({ action: "none", reason: "unrecognized" });

  const conversation = observed.allowConversationCount ?? 0;
  const allowOnce = observed.allowOnceCount ?? 0;
  const allow = observed.allowCount ?? 0;

  if (conversation > 1) return Object.freeze({ action: "none", reason: "ambiguous" });

  // Prefer the conversation-scoped choice when available.
  if (conversation === 1) {
    return Object.freeze({ action: "approve_conversation", preferredChoice: "allow_conversation" });
  }
  // Otherwise use the one-shot choice.
  if (allowOnce === 1) {
    return Object.freeze({ action: "approve_once", preferredChoice: "allow_once" });
  }
  if (allowOnce > 1) return Object.freeze({ action: "none", reason: "ambiguous" });
  // Generic Allow is a one-shot fallback when it is the sole consent choice.
  if (allow === 1) {
    return Object.freeze({ action: "approve_once", preferredChoice: "allow" });
  }
  if (allow > 1) return Object.freeze({ action: "none", reason: "ambiguous" });

  return Object.freeze({ action: "none", reason: "unrecognized" });
}

/**
 * Model-safe guidance from the same structural policy as dispatch.
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
  const decision = decideChatGptApproval(mode, observed);
  const classification = decision.action === "approve_once" || decision.action === "approve_conversation"
    ? (unverifiedDispatchCount > 0 ? "limit_reached"
      : decision.action === "approve_conversation" ? "eligible_conversation" : "eligible_once")
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
