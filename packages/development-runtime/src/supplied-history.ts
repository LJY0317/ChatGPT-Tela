import { readStoredNativeHistory, NativeHistoryBootstrapRequired, projectNativeHistoryReadback, readIndexedNativeItemsPage,
  type CodexAppServerRpc, type NativeVisibleHistorySnapshot } from "@chatgpt-tela/codex";
import { boundedNativeHistoryReadback, projectNativeHistoryIndex, type HistoryReadSelection, type HistoryReadResult } from "../../runtime/src/history-readback";

export interface SuppliedHistoryIdentity { readonly threadId: string; readonly turnId: string }
export interface SuppliedHistorySource {
  readSeed(identity: SuppliedHistoryIdentity, bodyBytes: number, signal: AbortSignal): Promise<NativeVisibleHistorySnapshot>;
  readPage(identity: SuppliedHistoryIdentity, selection: HistoryReadSelection, signal: AbortSignal): Promise<HistoryReadResult>;
}

/** Profile-fixed stored data, never live Native execution or archive authority. */
export function createSuppliedHistorySource(connect: (threadId: string, signal: AbortSignal) => Promise<CodexAppServerRpc>): SuppliedHistorySource {
  const verify = async (rpc: CodexAppServerRpc, id: SuppliedHistoryIdentity, signal: AbortSignal) => {
    const { thread } = await rpc.request("thread/read", { threadId: id.threadId, includeTurns: false }, signal) as any;
    if (thread?.id !== id.threadId || thread.historyMode !== "paginated") throw new NativeHistoryBootstrapRequired();
    const page = await rpc.request("thread/turns/list", { threadId: id.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }, signal) as any;
    if (page.data?.[0]?.id !== id.turnId) throw Error("Stored history head no longer matches the supplied request");
    return JSON.stringify([thread.id, thread.updatedAt, thread.cwd, thread.environments, thread.source, thread.parentThreadId]);
  };
  return {
    async readSeed(id, bytes, signal) {
      try {
        return await readStoredNativeHistory(s => connect(id.threadId, s ?? signal), id.threadId, id.turnId, signal, bytes);
      } catch (error) {
        if (signal.aborted || error instanceof NativeHistoryBootstrapRequired) throw error;
        throw new NativeHistoryBootstrapRequired("source_unavailable", { cause: error });
      }
    },
    async readPage(id, selection, signal) {
      if (selection.turnId === id.turnId) throw Error("History readback excludes the current supplied turn");
      const rpc = await connect(id.threadId, signal);
      try {
        const before = await verify(rpc, id, signal);
        let result: HistoryReadResult;
        if (selection.turnId === undefined) {
          const page = await rpc.request("thread/turns/list", { threadId: id.threadId, limit: 4, sortDirection: "desc", itemsView: "notLoaded",
            ...(selection.cursor === undefined ? {} : { cursor: selection.cursor }) }, signal) as any;
          if (!Array.isArray(page.data) || page.data.length > 4
            || page.nextCursor != null && typeof page.nextCursor !== "string"
            || page.data.some((t: any) => typeof t.id !== "string" || typeof t.status !== "string" || t.itemsView !== "notLoaded"
              || !Array.isArray(t.items) || t.items.length !== 0)) throw Error("Stored history index is invalid");
          result = projectNativeHistoryIndex({ data: page.data.filter((t: any) => t.id !== id.turnId).map((t: any) => ({ turnId: t.id, status: t.status })), nextCursor: page.nextCursor });
        } else {
          const page = await readIndexedNativeItemsPage(rpc, { threadId: id.threadId, turnId: selection.turnId, limit: 4, sortDirection: "desc",
            ...(selection.cursor === undefined ? {} : { cursor: selection.cursor }) }, signal);
          result = boundedNativeHistoryReadback(projectNativeHistoryReadback(page, id.threadId, id.turnId), selection);
        }
        if (await verify(rpc, id, signal) !== before) throw Error("Stored history changed during readback");
        return result;
      } finally { await rpc.close(); }
    },
  };
}
