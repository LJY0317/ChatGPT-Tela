import { expect, test } from "bun:test";
import { userPayload } from "./user-payload";

function bubble(roots: object[]) {
  return { querySelectorAll: () => roots } as unknown as HTMLElement;
}
function chain(texts: string[]) {
  const roots = texts.map(textContent => ({ textContent, contains: (_node: unknown): boolean => false }));
  roots.forEach((root, index) => { root.contains = node => roots.indexOf(node as typeof root) > index; });
  return roots;
}

test("one equivalent containment chain is the same author payload regardless of candidate order", () => {
  for (const count of [2, 3, 64]) {
    const roots = chain(Array(count).fill("한글 😀\r\nexact author text"));
    for (const ordered of [roots, [...roots].reverse()]) {
      expect(userPayload(bubble(ordered))).toEqual({ value: "한글 😀\nexact author text", reason: "author_payload",
        rootCount: count, nestedRoots: true, equivalentRoots: true, outerLength: 23, innerLength: 23 });
    }
  }
});

test("different nested text, sibling duplicates and branching roots cannot supply author proof", () => {
  for (const texts of [["prefix request", "request"], ["request suffix", "request"], [" request", "request"], ["Ａ", "A"]]) {
    expect(userPayload(bubble(chain(texts)))).toMatchObject({ reason: "ambiguous_author_root", rootCount: 2,
      nestedRoots: true, equivalentRoots: false });
  }
  const candidate = () => ({ get textContent(): string { throw Error("must not read separate candidates"); }, contains: () => false });
  const child = candidate(), second = candidate();
  expect(userPayload(bubble([child, second]))).toMatchObject({ reason: "ambiguous_author_root", rootCount: 2, nestedRoots: false });
  const parent = { get textContent(): string { throw Error("must not read branches"); }, contains: (node: unknown) => node === child || node === second };
  expect(userPayload(bubble([parent, child, second]))).toEqual({ reason: "ambiguous_author_root", rootCount: 3, nestedRoots: true });
});

test("single, empty, oversized and missing author payloads preserve their bounds", () => {
  expect(userPayload(bubble([]))).toEqual({ reason: "author_root_missing", rootCount: 0, nestedRoots: false });
  expect(userPayload(bubble(chain(["text"])))).toEqual({ value: "text", reason: "author_payload", rootCount: 1, outerLength: 4 });
  expect(userPayload(bubble(chain(["", ""])))).toMatchObject({ reason: "author_payload_empty" });
  expect(userPayload(bubble(chain(["x".repeat(1_048_577), "text"])))).toMatchObject({ reason: "author_payload_budget" });
});

test("nested proof reads only two endpoint payloads; oversized candidate sets inspect neither structure nor text", () => {
  const roots = chain(Array(64).fill("same payload")); let reads = 0;
  roots.forEach((root, index) => Object.defineProperty(root, "textContent", { get() {
    reads++; if (index !== 0 && index !== roots.length - 1) throw Error("must not materialize each nested payload");
    return "same payload";
  } }));
  expect(userPayload(bubble(roots)).value).toBe("same payload"); expect(reads).toBe(2);
  const many = Array.from({ length: 1000 }, () => ({
    get textContent() { throw Error("must not read ambiguous payload"); },
    contains() { throw Error("must not inspect unbounded pairs"); },
  }));
  expect(userPayload(bubble(many))).toEqual({ reason: "ambiguous_author_root", rootCount: 65 });
});
