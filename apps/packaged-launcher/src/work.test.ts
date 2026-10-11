import { expect, test } from "bun:test";
import { parsePackagedWorkArguments } from "./work";

test("installed Work defaults to the ordinary profile and refuses ambiguous or authority-changing options", () => {
  expect(parsePackagedWorkArguments(["work"])).toEqual({ slot: 1 });
  expect(parsePackagedWorkArguments(["work", "--slot", "2", "--thread", "fixture", "--model", "web/family"]))
    .toEqual({ slot: 2, threadId: "fixture", model: "web/family" });
  for (const args of [
    ["work", "--slot", "2", "--slot", "1"], ["work", "--slot", "1.5"],
    ["work", "--slot", "0"], ["work", "--thread"], ["work", "--model", "--last"],
    ["work", "--sandbox", "danger-full-access"], ["work", "--remote", "ws://example.com/"],
  ]) expect(() => parsePackagedWorkArguments(args)).toThrow();
});
