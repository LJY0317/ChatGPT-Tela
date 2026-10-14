import { describe, expect, test } from "bun:test";
import { nativeTextHash, NativeLiveTurnRegistry } from "./native-live-turn";

describe("Native engine acknowledged live turn evidence", () => {
  test("only the exact in-memory accepted owner/turn survives; replacement, finish and close revoke watchers", () => {
    const live = new NativeLiveTurnRegistry();
    const connection = {};
    expect(live.current("thread-a")).toBeUndefined();
    expect(live.accept("thread-a", "turn-1", connection)).toBe(true);
    const original = live.current("thread-a")!;
    let revocations = 0;
    const unsubscribe = live.subscribe(original, () => { revocations++; });
    expect(unsubscribe).toBeDefined();
    expect(live.isCurrent(original)).toBe(true);
    expect(live.accept("thread-a", "turn-2", connection)).toBe(true);
    expect(live.isCurrent(original)).toBe(false);
    expect(revocations).toBe(1);
    expect(live.subscribe(original, () => {})).toBeUndefined();
    const next = live.current("thread-a")!;
    live.retire("thread-a", "turn-1");
    expect(live.isCurrent(next)).toBe(true);
    live.retireOwner(connection);
    expect(live.isCurrent(next)).toBe(false);
    unsubscribe?.();
    expect(revocations).toBe(1);
  });

  test("account invalidation prevents a pending old engine ack from regranting proof", () => {
    const live = new NativeLiveTurnRegistry();
    const previous = live.generation;
    live.clear();
    expect(live.accept("thread", "old", {}, previous)).toBe(false);
    expect(live.current("thread")).toBeUndefined();
    expect(live.accept("thread", "new", {}, live.generation)).toBe(true);
    live.retireThread("thread");
    expect(live.current("thread")).toBeUndefined();
  });

  test("ambiguous duplicate turn acknowledgements on two connections revoke rather than transfer authority", () => {
    const live = new NativeLiveTurnRegistry();
    live.accept("thread", "turn", {});
    const original = live.current("thread")!;
    let revoked = false;
    live.subscribe(original, () => { revoked = true; });
    expect(live.accept("thread", "turn", {})).toBe(false);
    expect(revoked).toBe(true);
    expect(live.current("thread")).toBeUndefined();
  });

  test("missing/invalid identities and a saturated registry fail closed without evicting existing active proof", () => {
    const live = new NativeLiveTurnRegistry();
    expect(live.accept("", "turn", {})).toBe(false);
    expect(live.accept("thread", "turn\nprivate", {})).toBe(false);
    const connection = {};
    for (let n = 0; n < 64; n++) expect(live.accept(`thread-${n}`, `turn-${n}`, connection)).toBe(true);
    const protectedReceipt = live.current("thread-0")!;
    expect(live.accept("extra-thread", "turn", connection)).toBe(false);
    expect(live.isCurrent(protectedReceipt)).toBe(true);
    live.retireOwner(connection);
    expect(live.current("thread-0")).toBeUndefined();
  });
});

test("input provenance stays exact-owner bound, deduplicated and revoked on conflicting events", () => {
  const live = new NativeLiveTurnRegistry(), owner = {}, foreign = {};
  live.accept("thread", "turn", owner);
  const receipt = live.current("thread")!;
  const item = { type: "userMessage", id: "input", content: [{ type: "text", text: "synthetic steering" }] };
  live.observeInput("thread", "turn", foreign, item);
  live.observeInput("thread", "other", owner, item);
  expect(live.inputs(receipt)).toEqual([]);
  live.observeInput("thread", "turn", owner, item);
  live.observeInput("thread", "turn", owner, item);
  expect(live.inputs(receipt)).toEqual([{ id: "input", textHash: nativeTextHash("synthetic steering") }]);
  live.observeInput("thread", "turn", owner, { ...item, content: [{ type: "text", text: "changed" }] });
  expect(live.isCurrent(receipt)).toBe(false);
  expect(live.inputs(receipt)).toEqual([]);
});
