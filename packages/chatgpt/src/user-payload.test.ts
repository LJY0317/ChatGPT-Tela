import { expect, test } from "bun:test";
import { userPayload } from "./user-payload";

function bubble(roots: object[]) {
  return { querySelectorAll: () => roots } as unknown as HTMLElement;
}

test("nested and separate author candidates remain unproven with content-free structure", () => {
  const child = { textContent: "private authored text", contains: () => false };
  const parent = { textContent: child.textContent, contains: (node: unknown) => node === child };
  expect(userPayload(bubble([parent, child]))).toEqual({
    reason: "ambiguous_author_root", rootCount: 2, nestedRoots: true,
  });
  expect(userPayload(bubble([child, { ...child }]))).toEqual({
    reason: "ambiguous_author_root", rootCount: 2, nestedRoots: false,
  });
  expect(userPayload(bubble([]))).toEqual({ reason: "author_root_missing", rootCount: 0, nestedRoots: false });
});

test("large author candidate sets bound structural inspection and never read their content", () => {
  const roots = Array.from({ length: 1000 }, () => ({
    get textContent() { throw Error("must not read ambiguous payload"); },
    contains() { throw Error("must not inspect unbounded pairs"); },
  }));
  expect(userPayload(bubble(roots))).toEqual({ reason: "ambiguous_author_root", rootCount: 65 });
});
