import { createHash } from "node:crypto";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  connectCodexAppServerWebSocket,
  type CodexAppServerRpc, type CodexAppServerRpcFactory,
} from "./app-server";
import { NativeHistoryBootstrapRequired } from "./compaction-history";

/**
 * Explicit Native-owned final-answer handoff. It is an observed answer to the
 * user's own Native turn, NOT Codex's encrypted compaction state.
 * Tela never silently creates that turn or grants tools on its behalf.
 */
export const NATIVE_WEB_HANDOFF_PROMPT = [
  "TELA_NATIVE_WEB_HANDOFF_V1",
  "I explicitly request a one-time, read-only handoff for continuing this exact conversation using a Web model.",
  "Do not run tools, edit files, or change task state for this handoff.",
  "Using only your current Native context, summarize the current objective, constraints, confirmed work, unresolved failures, pending tasks, and which old original evidence remains unverified.",
  "Do not imply complete access to historical evidence lost during Native compaction.",
  "Respond as a single plain JSON object without markdown fences, with keys:",
  '{"type":"tela_native_web_handoff_v1","summary":"bounded task-continuation summary","limitations":"what was not independently reverified"}',
  "Keep the JSON response within 16 KiB UTF-8. This is a lossy Web-only context handoff, not a new action request.",
].join("\n");

const MAX_HANDOFF_BYTES = 16 * 1024;
const MAX_PAGE_BYTES = 128 * 1024;
const MAX_PROMPT_BYTES = 4 * 1024;

export interface NativeWebHandoff {
  readonly threadId: string;
  readonly currentTurnId: string;
  readonly handoffTurnId: string;
  readonly handoffItemId: string;
  readonly answerDigest: string;
  readonly summary: string;
  readonly limitations: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function sourceDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function checkId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 512;
}

/** Public evidence of the current turn's input, never proof of later tool effects. */
function hasNoCurrentTurnActivity(turn: Record<string, unknown>): boolean {
  return Array.isArray(turn.items) && turn.items.length <= 1
    && turn.items.every(item => record(item)?.type === "userMessage");
}

function rejectVisibleHandoffActivity(
  phase: "source_turn" | "current_turn",
): never {
  // No raw thread/turn, item types, prompts, tool output, command or paths.
  // A summary page is not a durable engine tool-free execution certificate.
  emitDiagnosticEvent("chatgpt_tela_codex", "native_manual_handoff_rejected", {
    phase, reason_class: "unexpected_visible_activity",
  });
  throw new Error(phase === "source_turn"
    ? "Native handoff turn contains unexpected activity"
    : "Native handoff current Web turn already contains activity");
}

async function reproveCurrentHandoffTurn(
  rpc: CodexAppServerRpc, threadId: string, currentTurnId: string, signal?: AbortSignal,
): Promise<void> {
  // Metadata-only indexed paging is safe ONLY after verifying Paginated in
  // thread/read. Its limit bounds the server-side indexed store access too.
  // Reprove at admission time: thread/read(status=active) alone cannot tell
  // whether the previous Web turn was replaced while the summary was read.
  const response = record(await rpc.request("thread/turns/list", {
    threadId, sortDirection: "desc", itemsView: "notLoaded", limit: 1,
  }, signal));
  const rows = response?.data;
  const current = Array.isArray(rows) && rows.length === 1 ? record(rows[0]) : undefined;
  if (!current || !checkId(current.id) || typeof current.status !== "string"
    || current.itemsView !== "notLoaded" || !Array.isArray(current.items)
    || current.items.length !== 0
    || Buffer.byteLength(JSON.stringify(rows), "utf8") > 8 * 1024) {
    emitDiagnosticEvent("chatgpt_tela_codex", "native_manual_handoff_rejected", {
      phase: "current_turn", reason_class: "invalid_indexed_head",
    });
    throw new Error("Native handoff newest current turn proof is unavailable");
  }
  if (current.id !== currentTurnId || current.status !== "inProgress") {
    emitDiagnosticEvent("chatgpt_tela_codex", "native_manual_handoff_rejected", {
      phase: "current_turn", reason_class: "current_turn_changed",
    });
    throw new Error("Native handoff newest current turn changed during public source read");
  }
}

function parseHandoff(turn: Record<string, unknown>, threadId: string, currentTurnId: string):
  NativeWebHandoff | undefined {
  if (!checkId(turn.id) || turn.status !== "completed"
    || turn.itemsView !== "summary" || !Array.isArray(turn.items)) {
    throw new Error("Native handoff requires a complete public summary of a finished turn");
  }
  const user = turn.items.find(value => record(value)?.type === "userMessage");
  const requested = record(user);
  if (!requested || !Array.isArray(requested.content) || requested.content.length !== 1) return undefined;
  const text = record(requested.content[0]);
  if (text?.type !== "text" || typeof text.text !== "string") return undefined;
  if (Buffer.byteLength(text.text, "utf8") > MAX_PROMPT_BYTES
    || text.text.trim() !== NATIVE_WEB_HANDOFF_PROMPT) return undefined;
  // The user requested a read-only SUMMARY, not another task. Once that
  // explicit request is recognized, never overlook a command, file change,
  // tool, plan, second user input, extra assistant message or unknown item
  // merely because the final JSON looks like a valid handoff. Reasoning is
  // inert but any other item type fails closed. Public summary views are not
  // an engine attestation that hidden tools could never have executed.
  const items = turn.items.map(record);
  if (items.some(item => !item || !["userMessage", "agentMessage", "agentReasoning"]
    .includes(String(item.type)))
    || items.filter(item => item?.type === "userMessage").length !== 1
    || items.filter(item => item?.type === "agentMessage").length !== 1
    || items[0] !== requested
    || items[items.length - 1]?.type !== "agentMessage") {
    rejectVisibleHandoffActivity("source_turn");
  }
  const answer = record([...turn.items].reverse().find(item =>
    record(item)?.type === "agentMessage"));
  if (!answer || !checkId(answer.id) || typeof answer.text !== "string"
    || (answer.phase !== undefined && answer.phase !== null && answer.phase !== "finalAnswer")) {
    throw new Error("Native explicitly requested handoff has no verified final answer");
  }
  if (Buffer.byteLength(answer.text, "utf8") > MAX_HANDOFF_BYTES) {
    throw new Error("Native handoff final answer exceeds its bounded source limit");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(answer.text); }
  catch { throw new Error("Native handoff final answer is not the exact JSON contract"); }
  const data = record(parsed);
  if (!data || Object.keys(data).sort().join(",") !== "limitations,summary,type"
    || data.type !== "tela_native_web_handoff_v1"
    || typeof data.summary !== "string" || !data.summary.trim()
    || typeof data.limitations !== "string" || !data.limitations.trim()) {
    throw new Error("Native handoff final answer does not describe an explicit limited summary");
  }
  return Object.freeze({
    threadId, currentTurnId, handoffTurnId: turn.id, handoffItemId: answer.id,
    answerDigest: sourceDigest(answer.text),
    summary: data.summary, limitations: data.limitations,
  });
}

/**
 * The two latest public Native turns are enough to prove a user-initiated
 * handoff immediately preceding the next Web request. If no handoff was
 * requested, return undefined without any model action or historical scan.
 */
export class AppServerNativeHandoffSource {
  constructor(private readonly connect: CodexAppServerRpcFactory) {}

  async latest(threadId: string, currentTurnId: string, signal?: AbortSignal):
    Promise<NativeWebHandoff | undefined> {
    const active = signal ?? AbortSignal.timeout(30_000);
    const rpc = await this.connect(active);
    try {
      const before = record(await rpc.request("thread/read", {
        threadId, includeTurns: false,
      }, active));
      const metadata = record(before?.thread);
      if (metadata?.id !== threadId || record(metadata.status)?.type !== "active") {
        throw new Error("Native handoff requires the active exact thread");
      }
      // Even limit:2, itemsView:summary may internally replay the entire
      // Legacy rollout. A user-requested summary does not grant permission
      // to trigger that hidden unbounded operation.
      if (metadata.historyMode !== "paginated") {
        throw new NativeHistoryBootstrapRequired("unindexed_history");
      }
      const response = record(await rpc.request("thread/turns/list", {
        threadId, sortDirection: "desc", itemsView: "summary", limit: 2,
      }, active));
      if (!response || !Array.isArray(response.data)
        || response.data.length < 1 || response.data.length > 2
        || Buffer.byteLength(JSON.stringify(response.data), "utf8") > MAX_PAGE_BYTES) {
        throw new Error("Native handoff page is missing or oversized");
      }
      const current = record(response.data[0]);
      if (!current || current.id !== currentTurnId || current.status !== "inProgress"
        || current.itemsView !== "summary" || !Array.isArray(current.items)) {
        throw new Error("Native handoff page belongs to another current turn");
      }
      if (!hasNoCurrentTurnActivity(current)) {
        rejectVisibleHandoffActivity("current_turn");
      }
      const prior = record(response.data[1]);
      const handoff = prior ? parseHandoff(prior, threadId, currentTurnId) : undefined;
      if (handoff && !checkId(handoff.handoffTurnId)) {
        throw new Error("Native handoff has an invalid source turn");
      }
      const after = record(await rpc.request("thread/read", {
        threadId, includeTurns: false,
      }, active));
      const updated = record(after?.thread);
      if (updated?.id !== threadId || record(updated.status)?.type !== "active"
        || updated.historyMode !== "paginated") {
        throw new Error("Native handoff source thread is no longer active or paginated");
      }
      if (handoff) await reproveCurrentHandoffTurn(rpc, threadId, currentTurnId, active);
      return handoff;
    } finally { await rpc.close(); }
  }

  /**
   * Re-verify an already accepted handoff after a fresh Web browser/process
   * starts. Enumerate only a bounded recent public summary window. The model
   * answer must still match the original exact Native final-answer digest.
   * Older handoffs outside this window need another explicit Native request.
   */
  async verifyRecent(
    threadId: string, currentTurnId: string, handoffTurnId: string,
    answerDigest: string, signal?: AbortSignal,
  ): Promise<NativeWebHandoff | undefined> {
    if (!checkId(handoffTurnId) || !/^[a-f0-9]{64}$/.test(answerDigest)) {
      throw new Error("Native handoff verification has an invalid source identity");
    }
    const active = signal ?? AbortSignal.timeout(30_000);
    const rpc = await this.connect(active);
    try {
      const before = record(await rpc.request("thread/read", {
        threadId, includeTurns: false,
      }, active));
      const metadata = record(before?.thread);
      if (metadata?.id !== threadId || record(metadata.status)?.type !== "active") {
        throw new Error("Native handoff verification requires the active exact thread");
      }
      if (metadata.historyMode !== "paginated") {
        throw new NativeHistoryBootstrapRequired("unindexed_history");
      }
      let cursor: string | undefined;
      let discovered = false;
      const cursors = new Set<string>();
      const seenTurns = new Set<string>();
      let bytes = 0;
      let verified: NativeWebHandoff | undefined;
      for (let page = 0; page < 8 && !discovered; page += 1) {
        const response = record(await rpc.request("thread/turns/list", {
          threadId, sortDirection: "desc", itemsView: "summary", limit: 8,
          ...(cursor ? { cursor } : {}),
        }, active));
        if (!response || !Array.isArray(response.data)
          || response.data.length < 1 || response.data.length > 8) {
          throw new Error("Native handoff verification page is incomplete");
        }
        bytes += Buffer.byteLength(JSON.stringify(response.data), "utf8");
        if (bytes > 256 * 1024) {
          throw new Error("Native handoff verification exceeded the bounded visible source budget");
        }
        for (const raw of response.data) {
          const turn = record(raw);
          if (!turn || !checkId(turn.id) || seenTurns.has(turn.id)
            || turn.itemsView !== "summary" || !Array.isArray(turn.items)) {
            throw new Error("Native handoff verification has duplicate or malformed turns");
          }
          seenTurns.add(turn.id);
          if (!discovered && page === 0 && seenTurns.size === 1
            && (turn.id !== currentTurnId || turn.status !== "inProgress")) {
            throw new Error("Native handoff verification belongs to another active turn");
          }
          if (page === 0 && seenTurns.size === 1 && !hasNoCurrentTurnActivity(turn)) {
            rejectVisibleHandoffActivity("current_turn");
          }
          if (turn.id === handoffTurnId) {
            discovered = true;
            verified = parseHandoff(turn, threadId, currentTurnId);
            if (!verified || verified.answerDigest !== answerDigest) {
              throw new Error("Native handoff cache has no matching authenticated public source");
            }
            break;
          }
        }
        if (discovered || response.nextCursor == null) break;
        if (typeof response.nextCursor !== "string" || !response.nextCursor
          || response.nextCursor.length > 1024 || cursors.has(response.nextCursor)) {
          throw new Error("Native handoff verification has an invalid cursor");
        }
        cursor = response.nextCursor;
        cursors.add(cursor);
      }
      const after = record(await rpc.request("thread/read", {
        threadId, includeTurns: false,
      }, active));
      const fresh = record(after?.thread);
      if (fresh?.id !== threadId || record(fresh.status)?.type !== "active"
        || fresh.historyMode !== "paginated") {
        throw new Error("Native handoff source thread is no longer active or paginated");
      }
      if (verified) await reproveCurrentHandoffTurn(rpc, threadId, currentTurnId, active);
      return verified;
    } finally { await rpc.close(); }
  }
}

export function appServerNativeHandoffSource(endpoint: string): AppServerNativeHandoffSource {
  return new AppServerNativeHandoffSource(
    signal => connectCodexAppServerWebSocket(endpoint, signal ? { signal } : {}),
  );
}
