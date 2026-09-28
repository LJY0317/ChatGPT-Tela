import { describe, expect, test } from "bun:test";
import { electronProfileIdentity } from "./profile";

describe("Electron profile partitions", () => {
  test("stable local profile ids map to stable persistent partitions", () => {
    const first = electronProfileIdentity("profile-1");
    const replay = electronProfileIdentity("profile-1");
    const other = electronProfileIdentity("profile-2");

    expect(first).toEqual(replay);
    expect(first.partition).toMatch(/^persist:chatgpt-tela-[a-f0-9]{24}$/);
    expect(other.partition).not.toBe(first.partition);
  });

  test("profile display/path hazards never become partition names", () => {
    const identity = electronProfileIdentity("  Work / Profile : 1  ");
    expect(identity.profileId).toBe("Work / Profile : 1");
    expect(identity.partition).not.toContain("Work");
    expect(() => electronProfileIdentity("bad\u0000profile")).toThrow("profile id is invalid");
  });
});
