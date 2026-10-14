import { expect, test } from "bun:test";
import { selectDelegationWebModel } from "./web-delegation-model";

const row = (label: string, n: number, efforts = ["low", "high", "xhigh", "max"]) => ({
  model: `chatgpt-tela-web/family/${String(n).padStart(20, "0")}`, displayName: `${label} (Web)`, hidden: false,
  supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })),
});
test("latest numeric live release uses Extra high, including new releases without fixed IDs", () => {
  const newer = row("New family 17.2", 2);
  expect(selectDelegationWebModel({ data: [{ ...row("Native 99", 1), model: "native-fixture" }, newer, row("New family 17.10", 3)] })).toMatchObject({ displayName: "New family 17.10 (Web)", effort: "xhigh" });
});
test("missing Extra high falls back only to High on the same latest model", () => {
  expect(selectDelegationWebModel({ data: [row("6", 1, ["low", "high"]), row("5.6", 2)] }).effort).toBe("high");
  expect(() => selectDelegationWebModel({ data: [row("6", 1, ["low", "max"]), row("5.6", 2)] })).toThrow("does not offer");
});
test("unknown labels, tied releases, incomplete catalogs and duplicate identities cannot silently choose a model", () => {
  for (const data of [[row("Latest", 1)], [row("6 Sol", 1), row("6 Astra", 2)], [row("6", 1), row("6", 1)]]) {
    expect(() => selectDelegationWebModel({ data })).toThrow();
  }
  expect(() => selectDelegationWebModel({ data: [row("6", 1)], nextCursor: "next" })).toThrow();
});
