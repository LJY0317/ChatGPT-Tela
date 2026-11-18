import { expect, test } from "bun:test";
import { approvalControlLabel } from "./approval-label";

test("consent labels ignore shortcut presentation without matching prose or wider grants", () => {
  for (const [input, expected] of [
    ["Allow once\nEnter", "Allow once"],
    ["ALLOW ONCE (Return)", "Allow once"],
    ["Ａｌｌｏｗ　ｏｎｃｅ ↵", "Allow once"],
    ["한\u200b 번만 허용⏎", "Allow once"],
    ["한번만 허용 [Enter]", "Allow once"],
    ["거부Esc", "Deny"],
    ["항상 허용⏎", "Always allow"],
    ["이 대화에서 허용↵", "Allow for this conversation"],
    ["Do not allow once", ""],
    ["Allow once and always allow", ""],
    ["한 번만 허용 방법을 설명해", ""],
    ["Allow once for all accounts", ""],
  ]) expect(approvalControlLabel(input!)).toBe(expected!);
});
