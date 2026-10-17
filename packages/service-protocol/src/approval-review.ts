/**
 * One bounded and payload-free review contract shared by the browser preview
 * and the Native Work inspector. This reports eligibility; it grants no input,
 * Native-turn, or host-platform approval authority.
 */
export type CodexAgentApprovalReviewContract = Readonly<{
  readonly contractVersion: 1;
  readonly classification: "eligible_once" | "eligible_conversation" | "manual_review" | "disabled"
    | "ambiguous" | "unrecognized" | "limit_reached";
  readonly nextAction: "existing_owned_turn_automation" | "human_browser_review";
  readonly agentMayApprove: false;
  readonly reviewReason?: "tool_description_policy_directive" | "suspicious_instruction" | "provider_warning";
}>;

export function parseCodexAgentApprovalReview(value: unknown): CodexAgentApprovalReviewContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid agent approval review");
  }
  const item = value as Record<string, unknown>;
  const classification = item.classification;
  if (item.contractVersion !== 1 || item.agentMayApprove !== false
    || !["eligible_once", "eligible_conversation", "manual_review", "disabled", "ambiguous", "unrecognized", "limit_reached"].includes(String(classification))
    || item.nextAction !== (classification === "eligible_once" || classification === "eligible_conversation"
      ? "existing_owned_turn_automation" : "human_browser_review")
    || (item.reviewReason !== undefined
      && (classification !== "manual_review"
        || !["tool_description_policy_directive", "suspicious_instruction", "provider_warning"].includes(String(item.reviewReason))))) {
    throw new Error("unrecognized agent approval review");
  }
  return Object.freeze({
    contractVersion: 1,
    classification: classification as CodexAgentApprovalReviewContract["classification"],
    nextAction: item.nextAction as CodexAgentApprovalReviewContract["nextAction"],
    agentMayApprove: false,
    ...(item.reviewReason ? { reviewReason: item.reviewReason as NonNullable<CodexAgentApprovalReviewContract["reviewReason"]> } : {}),
  });
}
