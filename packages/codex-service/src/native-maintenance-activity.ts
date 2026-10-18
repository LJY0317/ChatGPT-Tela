import type { CodexAppServerRpc } from "@chatgpt-tela/codex";

/** Read-only, bounded Native activity census for official service maintenance.
 * A loaded thread is not evidence of a running turn; status comes from the
 * authoritative app-server, not a window count or cached Tela conversation.
 *
 * No Legacy turn paging, rollout files, thread resume, fork or mutation.
 * An unknown/incomplete census throws and callers must deny shutdown.
 */
export async function inspectLoadedNativeActivity(
  rpc: Pick<CodexAppServerRpc, "request">,
  signal?: AbortSignal,
): Promise<{ readonly loadedCount: number; readonly activeThreadCount: number }> {
  const threads = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let finished = false;
  for (let page = 0; page < 4; page++) {
    signal?.throwIfAborted();
    const raw = await rpc.request("thread/loaded/list", {
      limit: 32, ...(cursor ? { cursor } : {}),
    }, signal);
    const list = object(raw);
    if (!list || !Array.isArray(list.data) || list.data.length > 32
      || boundedBytes(raw, 16 * 1024) === false) throw Error("Native maintenance inventory is not bounded");
    for (const item of list.data) {
      const id = identifier(item);
      if (!id || threads.has(id)) throw Error("Native maintenance inventory is ambiguous");
      threads.add(id);
    }
    if (list.nextCursor === null || list.nextCursor === undefined) { finished = true; break; }
    cursor = identifier(list.nextCursor);
    if (!cursor || cursors.has(cursor)) throw Error("Native maintenance inventory cursor is ambiguous");
    cursors.add(cursor);
  }
  if (!finished) throw Error("Native maintenance inventory is incomplete");

  let activeThreadCount = 0;
  for (const threadId of threads) {
    signal?.throwIfAborted();
    const response = await rpc.request("thread/read", { threadId, includeTurns: false }, signal);
    if (!boundedBytes(response, 32 * 1024)) throw Error("Native maintenance metadata is too large");
    const thread = object(object(response)?.thread);
    if (thread?.id !== threadId) throw Error("Native maintenance thread owner is uncertain");
    const state = object(thread.status)?.type;
    if (state === "active") activeThreadCount++;
    else if (state !== "idle") throw Error("Native maintenance thread activity is unknown");
  }
  return Object.freeze({ loadedCount: threads.size, activeThreadCount });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length >= 1 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
function boundedBytes(value: unknown, limit: number): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= limit; }
  catch { return false; }
}
