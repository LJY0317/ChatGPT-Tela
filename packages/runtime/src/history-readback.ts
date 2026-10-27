import { createHash } from "node:crypto";
import type { NativeHistoryPageSelection, projectNativeHistoryReadback } from "@chatgpt-tela/codex";

export interface HistoryReadSelection extends NativeHistoryPageSelection {
  readonly offsetBytes?: number;
  readonly pageDigest?: string;
}

/** Delivery budget, not a history-size rejection or a lossy truncation limit. */
export const HISTORY_READBACK_PAGE_BYTES = 64 * 1024;

export function boundedNativeHistoryReadback(page: ReturnType<typeof projectNativeHistoryReadback>, selection: HistoryReadSelection) {
  // Cursor encoding is provider metadata, not original content; a refreshed cursor
  // must not make an unchanged item's byte range appear to be a different source.
  const { nextCursor, ...original } = page;
  const bytes = Buffer.from(JSON.stringify(original));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const start = selection.offsetBytes ?? 0;
  if (!Number.isSafeInteger(start) || start < 0 || start >= bytes.length
    || (bytes[start]! & 0xc0) === 0x80
    || start > 0 && selection.pageDigest !== digest) throw Error("history range is invalid or its original page changed");
  const boundary = (end: number) => {
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    return end;
  };
  const result = (end: number) => ({
    type: "native_history_page" as const, role: "historical-evidence" as const,
    format: "original-page-json-text" as const,
    range: { unit: "utf8-bytes" as const, start, end, total: bytes.length },
    pageDigest: digest, text: bytes.toString("utf8", start, end),
    continuation: end < bytes.length ? { ...(selection.cursor === undefined ? {} : { cursor: selection.cursor }),
      offset_bytes: end, page_digest: digest } : nextCursor == null ? null : { cursor: nextCursor },
  });
  let low = start, high = Math.min(bytes.length, start + HISTORY_READBACK_PAGE_BYTES), best = start;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), end = boundary(middle);
    if (Buffer.byteLength(JSON.stringify(result(end))) <= HISTORY_READBACK_PAGE_BYTES) {
      best = end; low = middle + 1;
    } else high = middle - 1;
  }
  if (best === start) throw Error("history page metadata exceeds the delivery budget");
  return result(best);
}
