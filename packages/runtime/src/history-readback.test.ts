import { expect, test } from "bun:test";
import { boundedNativeHistoryReadback, HISTORY_READBACK_PAGE_BYTES } from "./history-readback";

test("an oversized original item is delivered as explicit lossless UTF-8 ranges within the result budget", () => {
  const page = { type: "native_history_page" as const, role: "historical-evidence" as const,
    data: [{ turnId: "old", item: { type: "agentMessage", id: "large", text: '한글🙂\\\"\n'.repeat(15_000) } }], references: [], nextCursor: "after-page" };
  const pieces: string[] = [];
  let offsetBytes = 0, pageDigest: string | undefined;
  for (;;) {
    const result = boundedNativeHistoryReadback(page, { turnId: "old", cursor: { type: "item", itemId: "before" },
      offsetBytes, ...(pageDigest ? { pageDigest } : {}) });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(HISTORY_READBACK_PAGE_BYTES);
    expect(result.range.start).toBe(offsetBytes);
    expect(result.range.end).toBeGreaterThan(offsetBytes);
    expect(result.text).not.toContain("\ufffd");
    pieces.push(result.text);
    if (result.range.end === result.range.total) {
      expect(result.continuation).toEqual({ cursor: "after-page" });
      break;
    }
    expect(result.continuation).toMatchObject({ cursor: { type: "item", itemId: "before" },
      offset_bytes: result.range.end, page_digest: result.pageDigest });
    offsetBytes = result.range.end; pageDigest = result.pageDigest;
  }
  expect(pieces.length).toBeGreaterThan(1);
  const { nextCursor, ...original } = page;
  expect(pieces.join("")).toBe(JSON.stringify(original));
});

test("a partial read never stitches a changed original page or an invalid byte boundary", () => {
  const page = { type: "native_history_page" as const, role: "historical-evidence" as const,
    data: [{ turnId: "old", item: { type: "agentMessage", id: "large", text: "🙂".repeat(30_000) } }], references: [], nextCursor: null };
  const first = boundedNativeHistoryReadback(page, { turnId: "old" });
  expect(() => boundedNativeHistoryReadback({ ...page,
    data: [{ ...page.data[0]!, item: { ...page.data[0]!.item, text: "changed original" } }] }, {
    turnId: "old", offsetBytes: first.range.end, pageDigest: first.pageDigest,
  })).toThrow("original page changed");
  expect(boundedNativeHistoryReadback({ ...page, nextCursor: "refreshed-cursor" }, {
    turnId: "old", offsetBytes: first.range.end, pageDigest: first.pageDigest,
  }).range.start).toBe(first.range.end);
  expect(() => boundedNativeHistoryReadback(page, { turnId: "old", offsetBytes: 1 })).toThrow("invalid");
});
