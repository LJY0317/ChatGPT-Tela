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
