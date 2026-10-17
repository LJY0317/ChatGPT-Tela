import { describe, expect, test } from "bun:test";
import { decideChatGptApproval, MAX_RECOGNIZED_APPROVALS_PER_TURN,
  reviewChatGptApprovalForAgent } from "./approval-policy";

describe("ChatGPT approval automation policy", () => {
  const observed = {
    cardCount: 1,
    denyCount: 1,
    allowCount: 0,
    allowOnceCount: 1,
    alwaysAllowCount: 1,
    unknownCount: 0,
  } as const;

  test("defaults to no automatic action", () => {
    expect(decideChatGptApproval("off", observed)).toEqual({ action: "none", reason: "disabled" });
  });

  test("recognized_once prefers the one-turn approval and never persistent allow", () => {
    expect(decideChatGptApproval("recognized_once", observed)).toEqual({
      action: "approve_once",
      preferredChoice: "allow_once",
    });
  });
  test("explicit conversation preference selects only a current-conversation choice, never Always allow", () => {
    const scoped = { ...observed, alwaysAllowCount: 0, allowConversationCount: 1 };
    expect(decideChatGptApproval("recognized_conversation", scoped)).toEqual({
      action: "approve_conversation", preferredChoice: "allow_conversation",
    });
    expect(reviewChatGptApprovalForAgent("recognized_conversation", scoped)).toMatchObject({
      classification: "eligible_conversation", agentMayApprove: false,
    });
    expect(decideChatGptApproval("recognized_once", scoped)).toEqual({
      action: "approve_once", preferredChoice: "allow_once",
    });
    // No explicit scoped choice: keep making progress with the known one-shot control.
    expect(decideChatGptApproval("recognized_conversation", observed)).toEqual({
      action: "approve_once", preferredChoice: "allow_once",
    });
    expect(decideChatGptApproval("recognized_conversation", {
      ...scoped, requiresManualReview: true, reviewReason: "suspicious_instruction",
    })).toEqual({ action: "none", reason: "manual_review" });
    expect(decideChatGptApproval("recognized_conversation", { ...scoped, allowConversationCount: 2 }))
      .toEqual({ action: "none", reason: "ambiguous" });
  });

  test("a provider warning always requires human review", () => {
    expect(decideChatGptApproval("recognized_once", {...observed, requiresManualReview: true}))
      .toEqual({action: "none", reason: "manual_review"});
  });

  test("unknown or ambiguous cards fail closed", () => {
    expect(decideChatGptApproval("recognized_once", { ...observed, cardCount: 2 })).toEqual({
      action: "none",
      reason: "ambiguous",
    });
    expect(decideChatGptApproval("recognized_once", {
      cardCount: 1,
      denyCount: 1,
      allowCount: 1,
      allowOnceCount: 0,
      alwaysAllowCount: 0,
      unknownCount: 0,
    })).toEqual({ action: "none", reason: "unrecognized" });
    expect(decideChatGptApproval("recognized_once", { ...observed, allowCount: 1 })).toEqual({
      action: "none", reason: "ambiguous",
    });
    expect(decideChatGptApproval("recognized_once", { ...observed, unknownCount: 1 })).toEqual({
      action: "none", reason: "ambiguous",
    });
  });
  test("agent-facing inspection shares policy but grants no independent approval authority", () => {
    expect(reviewChatGptApprovalForAgent("recognized_once", observed)).toEqual({
      contractVersion: 1, classification: "eligible_once",
      nextAction: "existing_owned_turn_automation", agentMayApprove: false,
    });
    expect(reviewChatGptApprovalForAgent("off", observed)).toMatchObject({
      classification: "disabled", nextAction: "human_browser_review", agentMayApprove: false,
    });
    expect(reviewChatGptApprovalForAgent("recognized_once", undefined)).toMatchObject({
      classification: "absent", nextAction: "none", agentMayApprove: false,
    });
    expect(reviewChatGptApprovalForAgent("recognized_once", {
      ...observed, requiresManualReview: true, reviewReason: "provider_warning",
    })).toMatchObject({
      classification: "manual_review", reviewReason: "provider_warning",
      nextAction: "human_browser_review", agentMayApprove: false,
    });
    expect(reviewChatGptApprovalForAgent("off", {
      ...observed, requiresManualReview: true, reviewReason: "suspicious_instruction",
    })).toMatchObject({ classification: "manual_review", reviewReason: "suspicious_instruction" });
    expect(reviewChatGptApprovalForAgent("recognized_once", { ...observed, cardCount: 2 }))
      .toMatchObject({ classification: "ambiguous" });
    expect(reviewChatGptApprovalForAgent("recognized_once", { ...observed, allowOnceCount: 0 }))
      .toMatchObject({ classification: "unrecognized" });
  });
  test("the finite per-turn gate closes rather than expanding agent authority for later cards", () => {
    expect(reviewChatGptApprovalForAgent("recognized_once", observed,
      MAX_RECOGNIZED_APPROVALS_PER_TURN - 1).classification).toBe("eligible_once");
    for (const used of [MAX_RECOGNIZED_APPROVALS_PER_TURN, MAX_RECOGNIZED_APPROVALS_PER_TURN + 30]) {
      expect(reviewChatGptApprovalForAgent("recognized_once", observed, used)).toMatchObject({
        classification: "limit_reached", nextAction: "human_browser_review", agentMayApprove: false,
      });
    }
    expect(() => reviewChatGptApprovalForAgent("recognized_once", observed, -1)).toThrow();
    expect(() => reviewChatGptApprovalForAgent("recognized_once", observed, 1.5)).toThrow();
  });
});
