import { describe, expect, test } from "bun:test";
import { DEFAULT_PROFILE_SLOT, profileSlotFromArguments } from "./profile-selection";

describe("single-profile-first CLI selection", () => {
  test("ordinary setup/start/stop default to the one normal profile", () => {
    expect(DEFAULT_PROFILE_SLOT).toBe(1);
    expect(profileSlotFromArguments(["start"])).toBe(1);
    expect(profileSlotFromArguments(["setup"])).toBe(1);
    expect(profileSlotFromArguments(["stop"])).toBe(1);
  });

  test("advanced multi-profile users can still select an explicit slot", () => {
    expect(profileSlotFromArguments(["start", "--slot", "2"])).toBe(2);
    expect(profileSlotFromArguments(["start", "--slot", "4"])).toBe(4);
  });

  test("ambiguous or invalid slot selection fails closed", () => {
    expect(() => profileSlotFromArguments(["start", "--slot"])).toThrow("requires a value");
    expect(() => profileSlotFromArguments(["start", "--slot", "0"])).toThrow("1 to 99");
    expect(() => profileSlotFromArguments(["start", "--slot", "2", "--slot", "3"]))
      .toThrow("only once");
  });
});
