import type { CodexAppServerRpc } from "./app-server";

export interface NativeHistoryPageSelection {
  readonly turnId: string;
  readonly cursor?: string | { readonly type: "item"; readonly itemId: string };
  readonly limit?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** One public indexed page, optionally scoped to a turn/item anchor. No turn replay or encoding. */
export async function readIndexedNativeItemsPage(
  rpc: Pick<CodexAppServerRpc, "request">,
  request: { threadId: string; turnId?: string; cursor?: string | { type: "item"; itemId: string };
    limit?: number; sortDirection?: "asc" | "desc" },
  signal: AbortSignal,
) {
  const limit = request.limit ?? 4;
  const page = record(await rpc.request("thread/items/list", { ...request, limit }, signal));
  if (!page || !Array.isArray(page.data) || page.data.length > limit
    || (page.data.length === 0 && page.nextCursor != null)) {
    throw new Error("Native indexed item page is incomplete");
  }
  const data = page.data.map(raw => {
    const entry = record(raw), item = record(entry?.item);
    if (!entry || typeof entry.turnId !== "string" || !entry.turnId.trim()
      || request.turnId !== undefined && entry.turnId !== request.turnId
      || !item || typeof item.id !== "string" || !item.id.trim()
      || typeof item.type !== "string" || !item.type) {
      throw new Error("Native indexed item page has incomplete or foreign item evidence");
    }
    return { turnId: entry.turnId, item: item as Record<string, unknown> & { id: string; type: string } };
  });
  return { data, nextCursor: page.nextCursor };
}
