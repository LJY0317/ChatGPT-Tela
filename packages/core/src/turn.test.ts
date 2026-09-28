import { expect, test } from "bun:test";
import { mayAutoSubmit, transitionTurn } from "./turn";

test("accepted turns cannot be automatically resubmitted", () => {
  expect(mayAutoSubmit("prepared")).toBe(true);
  expect(mayAutoSubmit("accepted")).toBe(false);
  expect(() => transitionTurn("accepted", "submitted")).toThrow("invalid turn transition");
});
