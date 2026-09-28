import { describe, expect, test } from "bun:test";
import { decideChatGptApproval } from "./approval-policy";

describe("ChatGPT approval automation policy", () => {
  const observed = {
    cardCount: 1,
    denyCount: 1,
    allowCount: 0,
    allowOnceCount: 1,
    alwaysAllowCount: 1,
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
    })).toEqual({ action: "none", reason: "unrecognized" });
  });
});
