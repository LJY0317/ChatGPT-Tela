import { describe, expect, test } from "bun:test";
import { decideChatGptApproval, reviewChatGptApprovalForAgent } from "./approval-policy";

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

  test("full_access chooses one-shot when conversation access is unavailable", () => {
    expect(decideChatGptApproval("full_access", observed)).toEqual({
      action: "approve_once",
      preferredChoice: "allow_once",
    });
  });

  test("allow_conversation is preferred over allow_once and allow when available", () => {
    const withConversation = {
      ...observed,
      allowConversationCount: 1,
      allowOnceCount: 1,
      allowCount: 1,
    };
    expect(decideChatGptApproval("full_access", withConversation)).toEqual({
      action: "approve_conversation",
      preferredChoice: "allow_conversation",
    });
    expect(reviewChatGptApprovalForAgent("full_access", withConversation)).toMatchObject({
      classification: "eligible_conversation",
      nextAction: "existing_owned_turn_automation",
      agentMayApprove: false,
    });
  });

  test("generic Allow is chosen when Allow once is absent", () => {
    const genericAllow = {
      ...observed,
      allowCount: 1,
      allowOnceCount: 0,
    };
    expect(decideChatGptApproval("full_access", genericAllow)).toEqual({
      action: "approve_once",
      preferredChoice: "allow",
    });
  });

  test("card text and auxiliary controls do not affect the selected choice", () => {
    expect(decideChatGptApproval("full_access", { ...observed, unknownCount: 4 })).toEqual({
      action: "approve_once",
      preferredChoice: "allow_once",
    });
  });

  test("unknown, multiple or ambiguous cards fail closed", () => {
    expect(decideChatGptApproval("full_access", { ...observed, cardCount: 2 })).toEqual({
      action: "none",
      reason: "ambiguous",
    });
    expect(decideChatGptApproval("full_access", { ...observed, cardCount: 0 })).toEqual({
      action: "none",
      reason: "absent",
    });
    // Multiple Deny buttons fail closed
    expect(decideChatGptApproval("full_access", { ...observed, denyCount: 2 })).toEqual({
      action: "none",
      reason: "ambiguous",
    });
    // Multiple Allow buttons of same type fail closed
    expect(decideChatGptApproval("full_access", { ...observed, allowOnceCount: 2 })).toEqual({
      action: "none",
      reason: "ambiguous",
    });
    expect(decideChatGptApproval("full_access", { ...observed, allowCount: 2, allowOnceCount: 0 })).toEqual({
      action: "none",
      reason: "ambiguous",
    });
    // No Allow buttons fail closed
    expect(decideChatGptApproval("full_access", { ...observed, allowOnceCount: 0, allowCount: 0 })).toEqual({
      action: "none",
      reason: "unrecognized",
    });
  });

  test("agent-facing inspection shares policy but grants no independent approval authority", () => {
    expect(reviewChatGptApprovalForAgent("full_access", observed)).toEqual({
      contractVersion: 1,
      classification: "eligible_once",
      nextAction: "existing_owned_turn_automation",
      agentMayApprove: false,
    });
    expect(reviewChatGptApprovalForAgent("off", observed)).toMatchObject({
      classification: "disabled",
      nextAction: "human_browser_review",
      agentMayApprove: false,
    });
    expect(reviewChatGptApprovalForAgent("full_access", undefined)).toMatchObject({
      classification: "absent",
      nextAction: "none",
      agentMayApprove: false,
    });
    expect(reviewChatGptApprovalForAgent("full_access", { ...observed, cardCount: 2 }))
      .toMatchObject({ classification: "ambiguous" });
    expect(reviewChatGptApprovalForAgent("full_access", { ...observed, allowOnceCount: 0 }))
      .toMatchObject({ classification: "unrecognized" });
  });

  test("one unresolved dispatch blocks another while verified approvals have no count limit", () => {
    expect(reviewChatGptApprovalForAgent("full_access", observed, 0).classification).toBe("eligible_once");
    for (const used of [1, 8, 38]) {
      expect(reviewChatGptApprovalForAgent("full_access", observed, used)).toMatchObject({
        classification: "limit_reached",
        nextAction: "human_browser_review",
        agentMayApprove: false,
      });
    }
    expect(() => reviewChatGptApprovalForAgent("full_access", observed, -1)).toThrow();
    expect(() => reviewChatGptApprovalForAgent("full_access", observed, 1.5)).toThrow();
  });
});
