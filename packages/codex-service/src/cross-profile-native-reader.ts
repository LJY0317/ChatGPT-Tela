import { createHmac, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { connectCodexAppServerWebSocket, type CodexAppServerRpc } from "@chatgpt-tela/codex";
import type { TrustedNativeProfileSession } from "./cross-profile-account-proof";
import type {
  LocalOriginalThreadOwner, LocalOriginalThreadProof, LocalOriginalThreadRead,
  LocalProfileBinding,
} from "./cross-profile-thread-relay";

/**
 * Research-only, owner-scoped read adapter. Never export its raw RPC socket
 * or attach a second Native writer. The real installed profile controller
 * must supply an independently authenticated owner and exact route session.
 *
 * Only indexed paginated history is supported. An opaque Legacy rollout
 * may be huge even when a public page request appears bounded.
 */
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_PAGE = 4;
const MAX_PAGE_BYTES = 128 * 1024;

type Rpc = Pick<CodexAppServerRpc, "request" | "close">;
type Json = Record<string, unknown>;
function object(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json : undefined;
}

export interface NativeOriginalReaderAdapters {
  readonly sourceSlot: number;
  /** Rechecks the actual signed-in Native owner before and after each call. */
  readonly profile: (slot: number) => Promise<LocalProfileBinding>;
  /** Must be the controller's exact owned runtime, never caller input. */
  readonly resolveOwnedSession: (slot: number) => Promise<TrustedNativeProfileSession>;
  readonly connect?: (endpoint: string, signal: AbortSignal) => Promise<Rpc>;
  /** Independent process-local HMAC domain for workspace/revision evidence. */
  readonly fingerprintKey?: Uint8Array;
}

interface IndexedSnapshot {
  readonly threadId: string;
  readonly workspace: string;
  readonly metadata: string;
  readonly state: "idle" | "active" | "unknown";
  readonly headId: string;
  readonly headState: "completed" | "failed" | "interrupted";
}

async function snapshot(rpc: Rpc, threadId: string, signal: AbortSignal): Promise<IndexedSnapshot> {
  const thread = object(object(await rpc.request("thread/read", {
    threadId, includeTurns: false,
  }, signal))?.thread);
  if (!thread || thread.id !== threadId) {
    throw new Error("Selected original Native thread identity is not proven");
  }
  if (thread.historyMode !== "paginated") {
    throw new Error("Original Native thread has unindexed Legacy history; refusing history replay");
  }
  const status = object(thread.status)?.type;
  if (!["idle", "active", "notLoaded"].includes(String(status))) {
    throw new Error("Original Native thread has unknown current execution state");
  }
  if (typeof thread.cwd !== "string" || !isAbsolute(thread.cwd)
    || !Number.isSafeInteger(thread.updatedAt) || (thread.updatedAt as number) < 1) {
    throw new Error("Original Native thread lacks bounded workspace/revision evidence");
  }
  const page = object(await rpc.request("thread/turns/list", {
    threadId, sortDirection: "desc", itemsView: "notLoaded", limit: 1,
  }, signal));
  if (!page || !Array.isArray(page.data) || page.data.length !== 1
    || Buffer.byteLength(JSON.stringify(page), "utf8") > 4096) {
    throw new Error("Original Native thread has no bounded latest-turn proof");
  }
  const head = object(page.data[0]);
  if (!head || typeof head.id !== "string" || !ID.test(head.id)
    || !["completed", "failed", "interrupted"].includes(String(head.status))
    || head.itemsView !== "notLoaded" || !Array.isArray(head.items) || head.items.length !== 0) {
    throw new Error("Original Native latest turn is not a settled indexed turn");
  }
  return {
    threadId, workspace: thread.cwd,
    metadata: JSON.stringify([thread.updatedAt, thread.cwd, head.id, head.status, status]),
    state: status === "notLoaded" ? "unknown" : status as "idle" | "active",
    headId: head.id,
    headState: head.status as IndexedSnapshot["headState"],
  };
}

function visibleItems(value: unknown): string {
  if (!Array.isArray(value) || value.length > 120) {
    throw new Error("Original Native turn items are not a bounded public summary");
  }
  const lines: string[] = [];
  let omitted = false;
  for (const raw of value) {
    const item = object(raw);
    if (!item || typeof item.type !== "string") {
      throw new Error("Original Native turn contains an unverified item");
    }
    if (item.type === "agentMessage") {
      if (typeof item.text !== "string") throw new Error("Original Native agent summary is malformed");
      lines.push(`Assistant: ${item.text}`);
    } else if (item.type === "userMessage") {
      if (!Array.isArray(item.content) || item.content.length > 32) {
        throw new Error("Original Native user summary is malformed");
      }
      const message: string[] = [];
      for (const input of item.content) {
        const part = object(input);
        if (part?.type === "text" && typeof part.text === "string") message.push(part.text);
        else omitted = true;
      }
      if (message.length) lines.push(`User: ${message.join("\n")}`);
    } else {
      // Never transfer reasoning, tool arguments/results, file paths or
      // attachment handles in a chat preview. Their existence is explicit.
      omitted = true;
    }
  }
  if (omitted) lines.push("[Native tools, private reasoning or attachments omitted from preview]");
  return lines.join("\n");
}

export function createReadOnlyOriginalNativeThreadOwner(
  adapters: NativeOriginalReaderAdapters,
): LocalOriginalThreadOwner {
  const key = adapters.fingerprintKey ?? randomBytes(32);
  if (key.length < 32 || !Number.isSafeInteger(adapters.sourceSlot)
    || adapters.sourceSlot < 1 || adapters.sourceSlot > 99) {
    throw new Error("Original Native reader requires one exact owner and a private hash key");
  }
  const hmac = (domain: string, text: string) =>
    createHmac("sha256", key).update(domain).update("\u0000").update(text).digest("hex");
  const connect = adapters.connect
    ?? ((endpoint: string, signal: AbortSignal) =>
      connectCodexAppServerWebSocket(endpoint, { signal }));

  const withOwner = async <T>(fn: (rpc: Rpc, session: TrustedNativeProfileSession, signal: AbortSignal) => Promise<T>) => {
    const [binding, session] = await Promise.all([
      adapters.profile(adapters.sourceSlot),
      adapters.resolveOwnedSession(adapters.sourceSlot),
    ]);
    const signal = AbortSignal.timeout(15_000);
    const rpc = await connect(session.terminalEndpoint, signal);
    try {
      const result = await fn(rpc, session, signal);
      return { result, binding };
    } finally {
      await rpc.close();
    }
  };

  function proof(s: IndexedSnapshot, binding: LocalProfileBinding): LocalOriginalThreadProof {
    return Object.freeze({
      threadId: s.threadId, owner: binding,
      workspaceFingerprint: hmac("owned-workspace", s.workspace),
      revision: hmac("indexed-original-revision", s.metadata),
      state: s.state,
    });
  }

  return Object.freeze({
    async prove(threadId: string): Promise<LocalOriginalThreadProof> {
      if (!ID.test(threadId)) throw new Error("Original Native reader requires an exact thread UUID");
      const { result, binding } = await withOwner((rpc, _session, signal) => snapshot(rpc, threadId, signal));
      return proof(result, binding);
    },
    async read(threadId: string, maxBytes: number): Promise<LocalOriginalThreadRead> {
      if (!ID.test(threadId) || !Number.isSafeInteger(maxBytes)
        || maxBytes < 128 || maxBytes > MAX_PAGE_BYTES) {
        throw new Error("Original Native selected-thread preview requires bounded admission");
      }
      const { result } = await withOwner(async (rpc, _session, signal) => {
        const before = await snapshot(rpc, threadId, signal);
        const page = object(await rpc.request("thread/turns/list", {
          threadId, sortDirection: "desc", itemsView: "summary", limit: MAX_PAGE,
        }, signal));
        if (!page || !Array.isArray(page.data)
          || page.data.length < 1 || page.data.length > MAX_PAGE
          || Buffer.byteLength(JSON.stringify(page), "utf8") > maxBytes) {
          throw new Error("Original Native selected-thread public preview is unavailable or oversized");
        }
        const turns = page.data.map(raw => {
          const item = object(raw);
          if (!item || typeof item.id !== "string" || !ID.test(item.id)
            || !["completed", "failed", "interrupted"].includes(String(item.status))
            || item.itemsView !== "summary") {
            throw new Error("Original Native selected thread has an incomplete or unverified page");
          }
          return Object.freeze({
            threadId, turnId: item.id,
            state: item.status as "completed" | "failed" | "interrupted",
            text: visibleItems(item.items),
          });
        });
        if (turns[0]?.turnId !== before.headId || turns[0]?.state !== before.headState
          || new Set(turns.map(t => t.turnId)).size !== turns.length
          || (page.nextCursor !== null && typeof page.nextCursor !== "string")) {
          throw new Error("Original Native selected-thread page does not match its latest turn");
        }
        const after = await snapshot(rpc, threadId, signal);
        if (before.metadata !== after.metadata) {
          throw new Error("Original Native thread changed during page capture");
        }
        const preview = {
          threadId, revision: hmac("indexed-original-revision", after.metadata),
          hasMore: typeof page.nextCursor === "string" && page.nextCursor.length > 0,
          turns: Object.freeze(turns.slice().reverse()),
        };
        if (Buffer.byteLength(JSON.stringify(preview), "utf8") > maxBytes) {
          throw new Error("Original Native rendered preview exceeded its response limit");
        }
        return preview;
      });
      // No cached chat history; only this exact selected page leaves owner.
      return Object.freeze(result);
    },
    async continue(): Promise<never> {
      throw new Error("Read-only original Native owner has no verified exclusive writer contract");
    },
  });
}
