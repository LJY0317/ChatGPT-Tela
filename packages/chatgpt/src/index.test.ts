import { expect, test } from "bun:test";
import { requireProven } from "./index";

test("ambiguous provider observations cannot authorize consequential actions", () => {
  expect(() => requireProven({
    state: "ambiguous",
    candidates: ["composer-a", "composer-b"],
    evidence: ["two candidate composer surfaces"],
  })).toThrow("requires proven state");
});
