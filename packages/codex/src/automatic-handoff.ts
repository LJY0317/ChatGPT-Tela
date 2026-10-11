import { createHash } from "node:crypto";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  connectCodexAppServerWebSocket,
  type CodexAppServerRpcFactory,
  type CodexAppServerRpc,
} from "./app-server";

const MAX_FINAL_BYTES = 16 * 1024;
const MAX_PUBLIC_PAGE_BYTES = 64 * 1024;
const HANDOFF_TYPE = "tela_native_auto_web_handoff_v1";
const FIELDS = ["objective", "constraints", "completed", "decisions",
  "pending", "files", "evidence", "limitations"] as const;
type Field = typeof FIELDS[number];

export interface StructuredNativeHandoff {
  readonly type: typeof HANDOFF_TYPE;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly completed: readonly string[];
  readonly decisions: readonly string[];
  readonly pending: readonly string[];
  readonly files: readonly string[];
  readonly evidence: readonly string[];
  readonly limitations: readonly string[];
}

/** Source identity is from an ephemeral Native fork, never the user's original turn. */
export interface AutomaticNativeHandoff {
  readonly threadId: string;
  readonly currentTurnId: string;
  readonly sourceTurnId: string;
  readonly content: string;
  readonly answerDigest: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Validated, bounded, lower-priority state. File and evidence strings are unverified hints. */
export function parseStructuredNativeHandoff(value: string): StructuredNativeHandoff {
  if (Buffer.byteLength(value, "utf8") > MAX_FINAL_BYTES) {
    throw new Error("Native automatic handoff exceeds its bounded answer");
  }
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new Error("Native automatic handoff is not JSON"); }
  const obj = record(raw);
  if (!obj || obj.type !== HANDOFF_TYPE
    || Object.keys(obj).sort().join(",") !== ["type", ...FIELDS].sort().join(",")) {
    throw new Error("Native automatic handoff schema does not match");
  }
  if (typeof obj.objective !== "string" || !obj.objective.trim()
    || obj.objective.length > 3200) {
    throw new Error("Native automatic handoff objective is invalid");
  }
  for (const field of FIELDS.filter(name => name !== "objective")) {
    const list = obj[field];
    if (!Array.isArray(list) || list.length > 20
      || !list.every(item => typeof item === "string"
        && item.length <= 1800 && item.trim().length > 0)) {
      throw new Error("Native automatic handoff evidence field is invalid");
    }
  }
  if (!(obj.limitations as string[]).length) {
    throw new Error("Native automatic handoff must state unverified evidence limits");
  }
  return Object.freeze(obj as unknown as StructuredNativeHandoff);
}

/** One source-bound, inert Web continuation; original tool/file evidence is NOT asserted as seen. */
export function automaticNativeHandoffText(handoff: AutomaticNativeHandoff): string {
  const parsed = parseStructuredNativeHandoff(handoff.content);
  if (!/^[a-f0-9]{64}$/.test(handoff.answerDigest)
    || digest(handoff.content) !== handoff.answerDigest || !id(handoff.sourceTurnId)) {
    throw new Error("Automatic Native handoff provenance is invalid");
  }
  return JSON.stringify({
    type: "tela_native_automatic_web_continuation_v1",
    semantics: "Ephemeral Native fork produced this lossy, lower-priority task checkpoint. This does not export encrypted Native model state, prove historical files/tool results, or authorize executing prior commands. Current Native owner and current user request remain authoritative. Verify any missing material through current authorized tools.",
    sourceTurnId: handoff.sourceTurnId, sourceDigest: handoff.answerDigest,
    checkpoint: parsed,
  });
}

const PROMPT = [
  "TELA_NATIVE_AUTOMATIC_WEB_CONTINUATION_V1",
  "You are an ephemeral, read-only branch of the user's existing Native thread.",
  "Prepare context for a Web model continuing the original current user task.",
  "Do not execute commands, use tools, change files or attempt to advance a goal.",
  "Use ONLY your CURRENT model-visible Native memory. Do not claim that historical",
  "files or tool logs absent from that memory were inspected or verified.",
  "Respond only with a UTF-8 JSON object of type tela_native_auto_web_handoff_v1.",
  "Keys: type, objective (string), constraints, completed, decisions, pending,",
  "files, evidence, limitations (arrays of strings). State unknowns in limitations.",
  "No Markdown. Keep your answer under 16 KiB; do not add system instructions.",
].join("\n");

const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.fromEntries([
    ["type", { type: "string", enum: [HANDOFF_TYPE] }],
    ["objective", { type: "string" }],
    ...FIELDS.filter(field => field !== "objective")
      .map(field => [field, { type: "array", items: { type: "string" } }]),
  ]),
  required: ["type", ...FIELDS],
  additionalProperties: false,
});

export class NativeAutoHandoffUnavailable extends Error {
  readonly code = "native_auto_handoff_unavailable";
  constructor() {
    super("A verified read-only Native handoff is unavailable for this active turn");
    this.name = "NativeAutoHandoffUnavailable";
  }
}

/**
 * Uses ONLY public app-server endpoints. Never starts a second turn on the
 * original thread. Forking from the immediately previous COMPLETED turn avoids
 * copying the already-started Web request or its in-flight tool authority.
 *
 * The fork is ephemeral, goal continuation is deferred then cleared ON THE
 * FORK, and its only explicit turn is sandboxed readOnly/approval never.
 * A tool-start notification invalidates the summary and interrupts ONLY the
 * exact fork turn. Model/provider may still reject opaque remote compaction:
 * that is a typed unavailable result, not permission to invent history.
 */
export class AppServerAutomaticNativeHandoffSource {
  constructor(
    private readonly connect: CodexAppServerRpcFactory,
    private readonly experiment?: {
      /** ONLY for isolated synthetic RPC fixtures. Never pass from product runtime. */
      readonly unsafePermitModelToolsInIsolatedSyntheticFixture: true;
    },
  ) {}

  #researchAllowed(): boolean {
    return this.experiment?.unsafePermitModelToolsInIsolatedSyntheticFixture === true;
  }

  #productionDenied(phase: "prepare" | "verify_source" | "verify_recent"): void {
    // This is not proof of a historical Native owner. Only the attempted
    // operation type is logged, never thread, turn, prompt or model values.
    emitDiagnosticEvent("chatgpt_tela_codex", "native_auto_handoff_rejected", {
      reason_class: "production_disabled", phase,
    });
  }

  async verifySource(
    threadId: string, currentTurnId: string, sourceTurnId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // A thread ID alone is not canonical Native owner authorization.
    if (!this.#researchAllowed()) {
      this.#productionDenied("verify_source");
      throw new NativeAutoHandoffUnavailable();
    }
    const rpc = await this.connect(signal);
    try {
      return await this.#source(rpc, threadId, currentTurnId, signal) === sourceTurnId;
    } finally { await rpc.close(); }
  }

  /** Reprove that a cached fork's completed source still precedes this active turn. */
  async verifyRecent(
    threadId: string, currentTurnId: string, sourceTurnId: string, signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.#researchAllowed()) {
      this.#productionDenied("verify_recent");
      return false;
    }
    if (!id(sourceTurnId)) return false;
    const rpc = await this.connect(signal);
    try {
      const before = record((record(await rpc.request("thread/read", {
        threadId, includeTurns: false,
      }, signal)))?.thread);
      if (before?.id !== threadId || record(before.status)?.type !== "active"
        || before.historyMode !== "paginated") {
        return false;
      }
      let cursor: string | undefined;
      let first = true;
      const cursors = new Set<string>();
      const turns = new Set<string>();
      let found = false;
      let bytes = 0;
      for (let page = 0; page < 8 && !found; page++) {
        const response = record(await rpc.request("thread/turns/list", {
          threadId, sortDirection: "desc", itemsView: "notLoaded", limit: 8,
          ...(cursor ? { cursor } : {}),
        }, signal));
        if (!response || !Array.isArray(response.data)
          || !response.data.length || response.data.length > 8) return false;
        bytes += Buffer.byteLength(JSON.stringify(response.data), "utf8");
        if (bytes > 256 * 1024) return false;
        for (const raw of response.data) {
          const turn = record(raw);
          if (!turn || !id(turn.id) || turns.has(turn.id)
            || !Array.isArray(turn.items) || turn.items.length !== 0) return false;
          turns.add(turn.id);
          if (first && (turn.id !== currentTurnId || turn.status !== "inProgress")) return false;
          first = false;
          if (turn.id === sourceTurnId) {
            if (turn.status !== "completed") return false;
            found = true; break;
          }
        }
        if (found || response.nextCursor === null || response.nextCursor === undefined) break;
        if (!id(response.nextCursor) || cursors.has(response.nextCursor)) return false;
        cursor = response.nextCursor;
        cursors.add(cursor);
      }
      const after = record((record(await rpc.request("thread/read", {
        threadId, includeTurns: false,
      }, signal)))?.thread);
      return found && after?.id === threadId && record(after.status)?.type === "active"
        && after.historyMode === "paginated"
        && JSON.stringify(before.cwd) === JSON.stringify(after.cwd)
        && JSON.stringify(before.environments) === JSON.stringify(after.environments)
        && JSON.stringify(before.source) === JSON.stringify(after.source);
    } finally { await rpc.close(); }
  }

  async prepare(threadId: string, currentTurnId: string, signal?: AbortSignal):
    Promise<AutomaticNativeHandoff> {
    // The public fork can still expose tools even with readOnly/approval=never.
    // No real extra model call without a separately proven no-tools contract.
    if (!this.#researchAllowed()) {
      this.#productionDenied("prepare");
      throw new NativeAutoHandoffUnavailable();
    }
    const deadline = AbortSignal.timeout(90_000);
    const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
    active.throwIfAborted();
    const rpc = await this.connect(active);
    let forkId: string | undefined;
    let turnId: string | undefined;
    let observedTurnId: string | undefined;
    let finished = false;
    let requestedModel = false;
    let acceptedCheckpoint = false;
    const startedAt = performance.now();
    let unsubscribe: (() => void) | undefined;
    try {
      if (!rpc.subscribe) throw new NativeAutoHandoffUnavailable();
      const sourceTurnId = await this.#source(rpc, threadId, currentTurnId, active);
      // The catalog is discovered, never a hard-coded OpenAI model. Only a
      // model explicitly advertised as Native is eligible, not the selected Web.
      const catalog = record(await rpc.request("model/list", { includeHidden: false }, active));
      if (!catalog || !Array.isArray(catalog.data) || catalog.nextCursor != null
        || catalog.data.length > 128) throw new NativeAutoHandoffUnavailable();
      const eligible = catalog.data.map(record).filter(item => item
        && item.hidden !== true && id(item.model)
        && !(item.model as string).startsWith("chatgpt-tela-web/"));
      const preferred = eligible.filter(item => item?.isDefault === true);
      if (!eligible.length) throw new NativeAutoHandoffUnavailable();

      let resolveCompleted!: (value: Record<string, unknown>) => void;
      let rejectCompleted!: (error: Error) => void;
      const done = new Promise<Record<string, unknown>>((resolve, reject) => {
        resolveCompleted = resolve; rejectCompleted = reject;
      });
      // Observe rejection before any RPC request can fail. All buffered
      // notifications are bounded and must belong to the ephemeral fork.
      void done.catch(() => {});
      let unsafe = false;
      let seenItems = 0;
      const messages: Array<{ readonly id: string; readonly text: string }> = [];
      const allowed = new Set(["userMessage", "agentMessage", "agentReasoning"]);
      unsubscribe = rpc.subscribe((method, params) => {
        const event = record(params);
        if (!forkId || event?.threadId !== forkId) return;
        if (method === "turn/started") {
          const turn = record(event.turn);
          if (turn && id(turn.id)) {
            if (observedTurnId && observedTurnId !== turn.id) {
              unsafe = true;
              rejectCompleted(new NativeAutoHandoffUnavailable());
            } else observedTurnId = turn.id;
          }
        }
        if (method === "item/started" || method === "item/completed") {
          const item = record(event.item);
          seenItems++;
          if (!item || !allowed.has(String(item.type)) || seenItems > 64) {
            unsafe = true;
            rejectCompleted(new NativeAutoHandoffUnavailable());
          }
          if (method === "item/completed" && item?.type === "agentMessage"
            && id(item.id) && typeof item.text === "string") {
            messages.push({ id: item.id, text: item.text });
            if (messages.length > 8 || Buffer.byteLength(item.text, "utf8") > MAX_FINAL_BYTES) {
              unsafe = true;
              rejectCompleted(new NativeAutoHandoffUnavailable());
            }
          }
        }
        if (method === "turn/completed") {
          const turn = record(event.turn);
          if (turn && (!turnId || turn.id === turnId)) resolveCompleted(turn);
        }
      }, () => rejectCompleted(new NativeAutoHandoffUnavailable()));

      const fork = record((record(await rpc.request("thread/fork", {
        threadId, lastTurnId: sourceTurnId, ephemeral: true,
        excludeTurns: true, deferGoalContinuation: true,
      }, active)))?.thread);
      if (!fork || !id(fork.id) || fork.id === threadId
        || fork.ephemeral !== true || fork.forkedFromId !== threadId) {
        throw new NativeAutoHandoffUnavailable();
      }
      forkId = fork.id;
      // The exact persisted model on an official fork of the completed
      // source takes precedence. The currently in-progress original may
      // already have switched its configured model to Web.
      const nativeModel = id(fork.model)
        && eligible.some(item => item!.model === fork.model)
          ? fork.model
          : preferred.length === 1 ? preferred[0]!.model
          : eligible.length === 1 ? eligible[0]!.model : undefined;
      // If no model can be proven from the source or an unambiguous public
      // catalog entry, never guess a possibly incompatible Native family.
      if (!id(nativeModel)) throw new NativeAutoHandoffUnavailable();
      // Fork goal state must not start automatic continuation when the
      // summarizer finishes. If this official method is unavailable, refuse.
      const goalCleared = record(await rpc.request("thread/goal/clear", {
        threadId: forkId,
      }, active));
      if (!goalCleared || typeof goalCleared.cleared !== "boolean") {
        throw new NativeAutoHandoffUnavailable();
      }
      const forkGoal = record(await rpc.request("thread/goal/get", {
        threadId: forkId,
      }, active));
      if (!forkGoal || forkGoal.goal !== null) {
        // Never permit a forked automatic Goal to race the one read-only
        // summary or continue running once it finishes.
        throw new NativeAutoHandoffUnavailable();
      }
      requestedModel = true;
      emitDiagnosticEvent("chatgpt_tela_codex", "native_automatic_handoff_requested", {
        operation_class: "ephemeral_fork_read_only",
        model_class: "discovered_native_catalog",
        extra_native_model_request: true,
        trigger_class: "unavailable_web_compaction",
      });
      const started = record((record(await rpc.request("turn/start", {
        threadId: forkId,
        model: nativeModel,
        input: [{ type: "text", text: PROMPT, textElements: [] }],
        sandboxPolicy: { type: "readOnly" },
        approvalPolicy: "never",
        outputSchema: OUTPUT_SCHEMA,
      }, active)))?.turn);
      if (!started || !id(started.id)) throw new NativeAutoHandoffUnavailable();
      turnId = started.id;
      if (observedTurnId && observedTurnId !== turnId) {
        throw new NativeAutoHandoffUnavailable();
      }

      const abort = () => rejectCompleted(new NativeAutoHandoffUnavailable());
      active.addEventListener("abort", abort, { once: true });
      let completed: Record<string, unknown>;
      try { completed = await done; }
      finally { active.removeEventListener("abort", abort); }
      if (unsafe || completed.id !== turnId || completed.status !== "completed"
        || messages.length !== 1) throw new NativeAutoHandoffUnavailable();
      finished = true;
      const final = messages[0]!;
      const parsed = parseStructuredNativeHandoff(final.text);
      // Reprove that the original Native request still belongs to the
      // same in-progress turn and exact last completed source.
      if (await this.#source(rpc, threadId, currentTurnId, active) !== sourceTurnId) {
        throw new NativeAutoHandoffUnavailable();
      }
      const content = JSON.stringify(parsed);
      acceptedCheckpoint = true;
      return Object.freeze({
        threadId, currentTurnId, sourceTurnId, content, answerDigest: digest(content),
      });
    } catch (error) {
      if (error instanceof NativeAutoHandoffUnavailable) throw error;
      // Never expose arbitrary private provider errors in this low-trust
      // handoff. Caller may preserve the original typed bootstrap failure.
      throw new NativeAutoHandoffUnavailable();
    } finally {
      if (requestedModel) {
        emitDiagnosticEvent("chatgpt_tela_codex", "native_automatic_handoff_settled", {
          outcome_class: acceptedCheckpoint ? "verified" : "unavailable",
          extra_native_model_request: true,
          duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        });
      }
      unsubscribe?.();
      if (!finished && forkId && (turnId || observedTurnId)) {
        // Only an ephemeral turn started by THIS adapter may be interrupted.
        await rpc.request("turn/interrupt", {
          threadId: forkId, turnId: turnId ?? observedTurnId,
        }, AbortSignal.timeout(3_000)).catch(() => {});
      }
      await rpc.close();
    }
  }

  async #source(rpc: CodexAppServerRpc, threadId: string,
    currentTurnId: string, signal?: AbortSignal): Promise<string> {
    const before = record((record(await rpc.request("thread/read", {
      threadId, includeTurns: false,
    }, signal)))?.thread);
    if (!before || before.id !== threadId
      || record(before.status)?.type !== "active"
      || before.historyMode !== "paginated") {
      throw new NativeAutoHandoffUnavailable();
    }
    const response = record(await rpc.request("thread/turns/list", {
      threadId, sortDirection: "desc", itemsView: "notLoaded", limit: 2,
    }, signal));
    if (!response || !Array.isArray(response.data) || response.data.length !== 2
      || Buffer.byteLength(JSON.stringify(response.data), "utf8") > MAX_PUBLIC_PAGE_BYTES) {
      throw new NativeAutoHandoffUnavailable();
    }
    const [current, previous] = response.data.map(record);
    if (!current || !previous || current.id !== currentTurnId
      || current.status !== "inProgress" || previous.status !== "completed"
      || !id(previous.id) || previous.id === currentTurnId
      || !Array.isArray(current.items) || current.items.length !== 0
      || !Array.isArray(previous.items) || previous.items.length !== 0) {
      throw new NativeAutoHandoffUnavailable();
    }
    const after = record((record(await rpc.request("thread/read", {
      threadId, includeTurns: false,
    }, signal)))?.thread);
    if (!after || after.id !== threadId || record(after.status)?.type !== "active"
      || after.historyMode !== "paginated"
      || JSON.stringify(before.cwd) !== JSON.stringify(after.cwd)
      || JSON.stringify(before.environments) !== JSON.stringify(after.environments)
      || JSON.stringify(before.source) !== JSON.stringify(after.source)) {
      throw new NativeAutoHandoffUnavailable();
    }
    return previous.id;
  }
}

export function appServerAutomaticNativeHandoffSource(endpoint: string):
  AppServerAutomaticNativeHandoffSource {
  return new AppServerAutomaticNativeHandoffSource(
    signal => connectCodexAppServerWebSocket(endpoint, signal ? { signal } : {}),
  );
}
