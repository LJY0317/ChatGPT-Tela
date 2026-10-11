import { expect, test } from "bun:test";
import { restorableWorkProfiles } from "./connection-policy";
import type { CodexProfileStatus } from "./controller";

test("saved intent restores stopped targets only; running, foreign and orphaned routes stay untouched", () => {
  const base: CodexProfileStatus = { slot: 1, targetId: "default", targetDisplayName: "ChatGPT", targetState: "stopped", targetSessionState: "available", controlState: "stopped" };
  const variants: CodexProfileStatus[] = [base,
    { ...base, slot: 2, targetId: "second", targetState: "running", controlState: "restart-required" },
    { ...base, slot: 3, targetId: "third", targetSessionState: "ready" },
    { ...base, slot: 4, targetId: "fourth", controlState: "orphaned" },
    { ...base, slot: 5, targetId: "unselected" }];
  expect(restorableWorkProfiles(variants, ["default", "second", "third", "fourth", "missing"])).toEqual([1]);
  expect(restorableWorkProfiles(variants, [])).toEqual([]);
});
