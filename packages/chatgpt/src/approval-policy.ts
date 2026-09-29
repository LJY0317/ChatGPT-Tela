export type ChatGptApprovalAutomationMode = "off" | "recognized_once";

export interface ChatGptApprovalCardObservation {
  readonly cardCount: number;
  readonly denyCount: number;
  readonly allowCount: number;
  readonly allowOnceCount: number;
  readonly alwaysAllowCount: number;
  readonly unknownCount: number;
}

export type ChatGptApprovalDecision =
  | { readonly action: "none"; readonly reason: "disabled" | "absent" | "ambiguous" | "unrecognized" }
  | { readonly action: "approve_once"; readonly preferredChoice: "allow_once" };

/**
 * Decide from structural card evidence only. No card text, tool arguments, prompt, or integration identity
 * participates in this initial policy. Unknown/ambiguous cards always fail closed.
 */
export function decideChatGptApproval(
  mode: ChatGptApprovalAutomationMode,
  observed: ChatGptApprovalCardObservation,
): ChatGptApprovalDecision {
  if (mode === "off") return Object.freeze({ action: "none", reason: "disabled" });
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
