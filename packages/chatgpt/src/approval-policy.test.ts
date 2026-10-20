import { describe, expect, test } from "bun:test";
import { decideChatGptApproval } from "./approval-policy";

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

  test("card count does not block an individually resolved approval", () => {
    expect(decideChatGptApproval("full_access", { ...observed, cardCount: 2 })).toEqual({
      action: "approve_once", preferredChoice: "allow_once",
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

});
