import { isAbsolute, relative, resolve } from "node:path";
import type { CanonicalCurrentTurnSource } from "./binding";
import type { CanonicalCurrentTurnEvidence } from "./rollout";
import { capturePrivateDiagnosticValue, diagnosticContext, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";
import { NativeHistoryBootstrapRequired } from "./history-bootstrap-error";

const CLIENT_NAME = "chatgpt-tela";
const CLIENT_VERSION = "0.0.0";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Codex app-server returned invalid ${field}`);
  }
  const normalized = value.trim();
  if (normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Codex app-server returned invalid ${field}`);
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`Codex app-server returned invalid ${field}`);
  }
  return resolve(value);
}

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function environment(thread: Record<string, unknown>): {
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
} {
  const fallbackCwd = absolutePath(thread.cwd, "thread cwd");
  const environments = Array.isArray(thread.environments) ? thread.environments : undefined;
  const primary = environments?.length ? record(environments[0]) : undefined;
  const cwd = primary ? absolutePath(primary.cwd, "primary environment cwd") : fallbackCwd;
  const rawRoots = primary && Array.isArray(primary.runtimeWorkspaceRoots)
    ? primary.runtimeWorkspaceRoots
    : [cwd];
  const workspaceRoots = Object.freeze([...new Set(rawRoots.map(value => (
    absolutePath(value, "runtime workspace root")
  ))) ]);
  if (workspaceRoots.length === 0 || !workspaceRoots.some(root => contains(root, cwd))) {
    throw new Error("Codex app-server cwd is outside runtime workspace roots");
  }
  return Object.freeze({ cwd, workspaceRoots });
}

function owner(thread: Record<string, unknown>): {
  readonly parentThreadId?: string;
  readonly agentName?: string;
} {
  const parentThreadId = optionalString(thread.parentThreadId);
  const source = record(thread.source);
  const subAgent = source ? record(source.subAgent) : undefined;
  const spawn = subAgent ? record(subAgent.thread_spawn) : undefined;
  const sourceParent = spawn ? optionalString(spawn.parent_thread_id) : undefined;
  if (parentThreadId && sourceParent && parentThreadId !== sourceParent) {
    throw new Error("Codex app-server thread lineage is internally inconsistent");
  }
  const agentName = spawn ? optionalString(spawn.agent_path) : undefined;
  return Object.freeze({
    ...(parentThreadId || sourceParent ? { parentThreadId: parentThreadId ?? sourceParent! } : {}),
    ...(agentName ? { agentName } : {}),
  });
}

/**
 * The public turns/list contract can return the newest turn without exporting
 * the entire Native rollout over the WebSocket. On legacy stores the Native
 * server may still replay its history internally; this only bounds Tela's
 * transfer/materialization, not the server's storage cost.
 *
 * Never fall back to includeTurns:true on a malformed/unavailable paging API:
 * doing so would reintroduce the unbounded multi-MiB transfer this path prevents.
 */
async function readBoundedNewestTurn(
  rpc: CodexAppServerRpc, threadId: string, signal?: AbortSignal,
): Promise<{ readonly thread: Record<string, unknown>; readonly newest?: Record<string, unknown> }> {
  const rejected = (reason: "unindexed_history" | "public_page_unavailable"
    | "invalid_page" | "invalid_turn" | "source_changed" | "owner_changed"): void => {
    withDiagnosticContext({ scope_fingerprint: diagnosticFingerprint(threadId) }, () =>
      emitDiagnosticEvent("chatgpt_tela_codex", "native_current_turn_rejected", {
        reason_class: reason,
        route_kind: "public_paginated_metadata",
      }));
  };
  const status = record(await rpc.request("thread/read", {
    threadId, includeTurns: false,
  }, signal));
  const thread = record(status?.thread);
  if (!thread || identifier(thread.id, "thread id") !== threadId) {
    throw new Error("Native current-turn metadata does not match the requested thread");
  }
  if (record(thread.status)?.type !== "active") return { thread };
  // itemsView:notLoaded bounds the WebSocket payload, not the Native
  // server's internal work. A Legacy page may replay a huge rollout.
  // Unknown or missing modes are not proof that indexed paging is safe.
  if (thread.historyMode !== "paginated") {
    rejected("unindexed_history");
    throw new NativeHistoryBootstrapRequired("unindexed_history");
  }
  let response: Record<string, unknown> | undefined;
  try {
    response = record(await rpc.request("thread/turns/list", {
      threadId, limit: 2, sortDirection: "desc", itemsView: "notLoaded",
    }, signal));
  } catch {
    rejected("public_page_unavailable");
    throw new Error("Native public paginated current-turn proof is unavailable; full history was not read");
  }
  if (!response || !Array.isArray(response.data)
    || response.data.length < 1 || response.data.length > 2) {
    rejected("invalid_page");
    throw new Error("Native paginated current-turn proof is malformed");
  }
  const entries = response.data.map(record);
  const newest = entries[0];
  if (!newest || !newest.id || typeof newest.status !== "string"
    || (newest.itemsView !== "notLoaded" && newest.itemsView !== undefined)
    || !Array.isArray(newest.items) || newest.items.length !== 0
    || entries.some(entry => !entry || !entry.id)
    || entries.length === 2 && entries[1]!.id === newest.id) {
    rejected("invalid_turn");
    throw new Error("Native paginated current-turn identity is invalid");
  }
  // Reconfirm after paging. A turn stopping while a page was being assembled
  // must not grant authority for the next Web request.
  const after = record(await rpc.request("thread/read", {
    threadId, includeTurns: false,
  }, signal));
  const fresh = record(after?.thread);
  if (!fresh || identifier(fresh.id, "thread id") !== threadId
    || record(fresh.status)?.type !== "active"
    || fresh.historyMode !== "paginated") {
    rejected("source_changed");
    throw new Error("Native active turn changed during paginated owner proof");
  }
  if (JSON.stringify(owner(thread)) !== JSON.stringify(owner(fresh))
    || JSON.stringify(environment(thread)) !== JSON.stringify(environment(fresh))) {
    rejected("owner_changed");
    throw new Error("Native owner or environment changed during paginated turn proof");
  }
  return { thread: fresh, newest };
}

export interface CodexAppServerRpc {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
  subscribe?(notification: (method: string, params: unknown) => void, disconnected: () => void): () => void;
}

export type CodexAppServerRpcFactory = (
  signal?: AbortSignal,
) => Promise<CodexAppServerRpc>;

/**
 * Gracefully interrupt only the exact currently-running turns loaded by one
 * Native app-server before an explicit Desktop restart/stop.
 *
 * This is deliberately a public-protocol operation rather than a process
 * signal. It discovers loaded thread identities, proves each newest turn is
 * currently in progress, then interrupts only those exact thread/turn pairs.
 * Prompt/item payloads are never returned by this API surface or logged by
 * the caller. Any malformed/ambiguous discovery fails before the first
 * interrupt so a lifecycle action cannot partially guess its owners.
 */
export async function interruptLoadedAppServerTurns(
  endpoint: string,
  options: {
    readonly signal?: AbortSignal;
    readonly connect?: CodexAppServerRpcFactory;
  } = {},
): Promise<number> {
  const connect = options.connect
    ?? (signal => connectCodexAppServerWebSocket(endpoint, { ...(signal ? { signal } : {}) }));
  const rpc = await connect(options.signal);
  try {
    const loaded: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const response = record(await rpc.request("thread/loaded/list", {
        limit: 64,
        ...(cursor ? { cursor } : {}),
      }, options.signal));
      if (!response || !Array.isArray(response.data)) {
        throw new Error("Codex app-server loaded-thread response is invalid");
      }
      for (const raw of response.data) {
        const threadId = identifier(raw, "loaded thread id");
        if (seen.has(threadId)) throw new Error("Codex app-server loaded-thread identity is duplicated");
        seen.add(threadId);
        loaded.push(threadId);
      }
      const next = response.nextCursor;
      if (next === null || next === undefined) {
        cursor = undefined;
        break;
      }
      cursor = identifier(next, "loaded thread cursor");
      if (page === 7) throw new Error("Codex app-server loaded-thread list exceeds the bounded lifecycle scan");
    }

    const active: Array<{ readonly threadId: string; readonly turnId: string }> = [];
    for (const threadId of loaded) {
      // Idle loaded conversations can have large histories. Status alone is sufficient to skip
      // them; retrieve turn history only when Native reports an active thread.
      const statusResponse = record(await rpc.request("thread/read", {
        threadId, includeTurns: false,
      }, options.signal));
      const statusThread = statusResponse ? record(statusResponse.thread) : undefined;
      if (!statusThread || identifier(statusThread.id, "thread id") !== threadId) {
        throw new Error("Codex app-server returned a different loaded thread");
      }
      if (record(statusThread.status)?.type !== "active") continue;
      // A shallow Legacy turns/list can still reconstruct the entire rollout
      // inside the Native app-server. An includeTurns:true compatibility
      // fallback is worse: it transfers the same unbounded private history.
      // Interrupt nothing unless the active thread explicitly advertises
      // indexed Paginated history and its newest turn can be re-proved.
      if (statusThread.historyMode !== "paginated") {
        throw new Error("Native lifecycle cannot safely prove an unindexed active turn; no history was read or turn interrupted");
      }
      const bounded = await readBoundedNewestTurn(rpc, threadId, options.signal);
      if (bounded.thread.historyMode !== "paginated"
        || record(bounded.thread.status)?.type !== "active"
        || JSON.stringify(owner(statusThread)) !== JSON.stringify(owner(bounded.thread))
        || JSON.stringify(environment(statusThread)) !== JSON.stringify(environment(bounded.thread))) {
        throw new Error("Native paginated lifecycle ownership changed during current-turn proof");
      }
      const newest = bounded.newest;
      if (!newest || newest.status !== "inProgress") continue;
      active.push(Object.freeze({ threadId, turnId: identifier(newest.id, "active turn id") }));
    }

    for (const item of active) {
      await rpc.request("turn/interrupt", {
        threadId: item.threadId,
        turnId: item.turnId,
      }, options.signal);
    }
    return active.length;
  } finally {
    await rpc.close();
  }
}

/**
 * Resolve current-turn authority entirely through Codex app-server's public v2 read contract.
 *
 * This is the authority path for managed/multi-profile runtimes where private CODEX_HOME paths stay
 * intentionally hidden. The app-server must prove the thread is active and its newest turn is
 * in progress. Historical turns can retain an unfinished status after interruption. Filesystem roots
 * come only from app-server thread/environment state. Sandbox details stay opaque and Native Codex remains the sole executor/enforcer for returned tool calls.
 */
export class AppServerCurrentTurnSource implements CanonicalCurrentTurnSource {
  readonly #connect: CodexAppServerRpcFactory;
  readonly #includeNativeGoal: boolean;
  readonly #preferBoundedTurnProof: boolean;

  constructor(connect: CodexAppServerRpcFactory, options: {
    readonly includeNativeGoal?: boolean;
    readonly preferBoundedTurnProof?: boolean;
  } = {}) {
    this.#connect = connect;
    this.#includeNativeGoal = options.includeNativeGoal === true;
    this.#preferBoundedTurnProof = options.preferBoundedTurnProof === true;
  }

  async watchTurn(threadId: string, turnId: string, signal?: AbortSignal) {
    identifier(threadId, "watched thread id");
    identifier(turnId, "watched turn id");
    signal?.throwIfAborted();
    const origin = { ...diagnosticContext(), scope_fingerprint: diagnosticFingerprint(threadId),
      turn_fingerprint: diagnosticFingerprint(turnId) };
    const rpc = await this.#connect(signal);
    const controller = new AbortController();
    let unsubscribe: (() => void) | undefined;
    let closing = false;
    const terminate = (reason: string, error: unknown) => {
      if (closing || controller.signal.aborted) return;
      withDiagnosticContext(origin, () => emitDiagnosticEvent("chatgpt_tela_codex", "native_watch_terminated", {
        reason_class: reason,
      }));
      controller.abort(error);
    };
    const abort = () => terminate("runtime_cancelled", signal?.reason);
    const close = async () => {
      closing = true;
      signal?.removeEventListener("abort", abort);
      unsubscribe?.();
      await rpc.close();
    };
    try {
      if (!rpc.subscribe) throw new Error("Native lifecycle notifications unavailable");
      unsubscribe = rpc.subscribe((method, params) => {
        if (method !== "turn/completed") return;
        const event = record(params);
        const turn = record(event?.turn);
        if (event?.threadId !== threadId || turn?.id !== turnId) return;
        if (turn.status === "interrupted" || turn.status === "failed") {
          if (turn.status === "failed" && !closing && !controller.signal.aborted) {
            withDiagnosticContext(origin, () => capturePrivateDiagnosticValue("native_turn_failure", {
              error: turn.error, reason: "native_failed",
            }));
          }
          terminate(turn.status === "interrupted" ? "native_interrupted" : "native_failed",
            new Error("Native turn terminated"));
        }
      }, () => terminate("observer_disconnected", new Error("Native lifecycle observation disconnected")));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      // Do not return an open but already-cancelled observer. The catch path
      // closes this connection and releases its notification subscription.
      signal?.throwIfAborted();
      // Observing a Native turn must not implicitly load an old Legacy
      // rollout merely to attach the notification stream. On indexed
      // product targets, prove both the active turn and the storage mode
      // BEFORE thread/resume, which can otherwise initiate server-side
      // reconstruction despite excludeTurns:true.
      if (this.#preferBoundedTurnProof && !controller.signal.aborted) {
        const initial = await readBoundedNewestTurn(rpc, threadId, signal);
        if (record(initial.thread.status)?.type !== "active"
          || initial.newest?.id !== turnId || initial.newest.status !== "inProgress") {
          terminate("snapshot_inactive", new Error("Native turn no longer active"));
        }
      }
      signal?.throwIfAborted();
      if (controller.signal.aborted) return { signal: controller.signal, close };
      // Public resume attaches this connection to the loaded thread's notifications.
      // No model/config overrides: Native keeps its existing runtime and authority.
      await rpc.request("thread/resume", { threadId, excludeTurns: true }, signal);
      // Reprove after attaching; a turn ending between preflight and resume
      // cannot obtain a watcher for the old active Native authority.
      const bounded = this.#preferBoundedTurnProof
        ? await readBoundedNewestTurn(rpc, threadId, signal) : undefined;
      const snapshot = bounded ? undefined
        : record(await rpc.request("thread/read", { threadId, includeTurns: true }, signal));
      const thread = bounded?.thread ?? record(snapshot?.thread);
      const newest = bounded?.newest
        ?? (Array.isArray(thread?.turns) ? record(thread.turns.at(-1)) : undefined);
      if (thread?.id !== threadId || record(thread.status)?.type !== "active"
        || newest?.id !== turnId || newest.status !== "inProgress") {
        terminate("snapshot_inactive", new Error("Native turn no longer active"));
      }
      return { signal: controller.signal, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  async currentTurn(threadId: string): Promise<CanonicalCurrentTurnEvidence | undefined> {
    const expectedThreadId = identifier(threadId, "requested thread id");
    const rpc = await this.#connect();
    try {
      const bounded = this.#preferBoundedTurnProof
        ? await readBoundedNewestTurn(rpc, expectedThreadId) : undefined;
      const readResponse = bounded ? undefined : record(await rpc.request("thread/read", {
        threadId: expectedThreadId, includeTurns: true,
      }));
      const thread = bounded?.thread ?? (readResponse ? record(readResponse.thread) : undefined);
      if (!thread) throw new Error("Codex app-server thread/read response is invalid");
      if (identifier(thread.id, "thread id") !== expectedThreadId) {
        throw new Error("Codex app-server returned a different thread");
      }
      const status = record(thread.status);
      if (status?.type !== "active") return undefined;

      // thread/read is the established public API on shipped Desktop runtimes. The newer
      // thread/turns/list method can be advertised while still returning "not supported yet".
      // Keep one authority path: the same snapshot supplies environment, lineage and turns.
      if (!bounded && !Array.isArray(thread.turns)) {
        throw new Error("Codex app-server thread/read omitted requested turns");
      }
      const turns = bounded ? (bounded.newest ? [bounded.newest] : [])
        : (thread.turns as unknown[]).map(value => record(value));
      if (turns.some(value => !value)) {
        throw new Error("Codex app-server returned an invalid turn entry");
      }
      // Public history reconstruction preserves an older InProgress status when a process
      // exits before TurnComplete/TurnAborted. A later TurnStarted closes that history
      // entry without changing its status; only the newest entry can own this request.
      const newest = turns.at(-1);
      if (!newest || newest.status !== "inProgress") {
        if (turns.some(value => value?.status === "inProgress")) {
          throw new Error("Codex app-server current turn is not the newest turn");
        }
        return undefined;
      }
      const currentTurnId = identifier(newest.id, "current turn id");
      if (turns.filter(value => value?.id === currentTurnId).length !== 1) {
        throw new Error("Codex app-server current turn identity is ambiguous");
      }
      const resolvedEnvironment = environment(thread);
      const resolvedOwner = owner(thread);
      let nativeGoal: CanonicalCurrentTurnEvidence["nativeGoal"];
      let nativeGoalState: CanonicalCurrentTurnEvidence["nativeGoalState"];
      if (this.#includeNativeGoal) {
        // Exact current active-turn owner is proved before any goal observation.
        // A genuinely unsupported optional feature must not fail normal Web
        // text/media turns. Do not swallow permission, transport or malformed
        // ownership failures; those still fail closed.
        let response: Record<string, unknown> | undefined;
        try {
          response = record(await rpc.request("thread/goal/get", {
            threadId: expectedThreadId,
          }));
        } catch (error) {
          const reason = error instanceof Error ? error.message.trim().toLowerCase() : "";
          if (reason === "goals feature is disabled" || reason === "method not found") {
            nativeGoalState = "unavailable";
            emitDiagnosticEvent("chatgpt_tela_codex", "native_goal_unavailable", {
              reason_class: reason === "method not found" ? "public_method_absent" : "feature_disabled",
            });
          } else {
            throw error;
          }
        }
        if (!nativeGoalState && (!response || !Object.hasOwn(response, "goal")
          || response.goal === undefined)) {
          throw new Error("Native public goal response is malformed");
        }
        if (response?.goal === null) nativeGoalState = "absent";
        if (response?.goal !== undefined && response?.goal !== null) {
          const goal = record(response.goal);
          const statuses = new Set(["active", "paused", "blocked", "usageLimited",
            "usage_limited", "budgetLimited", "budget_limited", "complete"]);
          const validNumber = (number: unknown) => Number.isSafeInteger(number) && (number as number) >= 0;
          if (!goal || goal.threadId !== expectedThreadId || typeof goal.objective !== "string"
            || goal.objective.length > 8192 || !goal.objective.trim()
            || !statuses.has(String(goal.status))
            || (goal.tokenBudget !== null && !validNumber(goal.tokenBudget))
            || !validNumber(goal.tokensUsed) || !validNumber(goal.timeUsedSeconds)
            || !validNumber(goal.updatedAt)) {
            throw new Error("Native public goal ownership or status is invalid");
          }
          nativeGoal = Object.freeze({
            threadId: expectedThreadId, objective: goal.objective,
            status: goal.status as string, tokenBudget: goal.tokenBudget as number | null,
            tokensUsed: goal.tokensUsed as number, timeUsedSeconds: goal.timeUsedSeconds as number,
            updatedAt: goal.updatedAt as number,
          });
        }
      }
      return Object.freeze({
        threadId: expectedThreadId,
        turnId: currentTurnId,
        ...(resolvedOwner.parentThreadId ? { parentThreadId: resolvedOwner.parentThreadId } : {}),
        ...(resolvedOwner.agentName ? { agentName: resolvedOwner.agentName } : {}),
        cwd: resolvedEnvironment.cwd,
        workspaceRoots: resolvedEnvironment.workspaceRoots,
        sandbox: Object.freeze({ kind: "native-enforced" as const }),
        proof: "app-server-active-turn" as const,
        environmentSourceTurnId: currentTurnId,
        ...(nativeGoal ? { nativeGoal } : {}),
        ...(nativeGoalState ? { nativeGoalState } : {}),
      });
    } finally {
      await rpc.close();
    }
  }
}

interface WebSocketLike extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface CodexAppServerWebSocketOptions {
  readonly createWebSocket?: (url: string) => WebSocketLike;
  readonly signal?: AbortSignal;
}

function validateLoopbackWebSocket(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "ws:") throw new Error("Codex app-server endpoint must use ws://");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Codex app-server endpoint must be loopback-only");
  }
  if (url.username || url.password) throw new Error("Codex app-server endpoint must not contain credentials");
  return url;
}

function abortError(): DOMException {
  return new DOMException("Codex app-server operation aborted", "AbortError");
}

class WebSocketCodexAppServerRpc implements CodexAppServerRpc {
  readonly #socket: WebSocketLike;
  readonly #pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  readonly #subscriptions = new Set<{
    notification: (method: string, params: unknown) => void;
    disconnected: () => void;
  }>();
  #nextId = 1;
  #closed = false;

  constructor(socket: WebSocketLike) {
    this.#socket = socket;
    socket.addEventListener("message", event => {
      const raw = (event as MessageEvent<unknown>).data;
      if (typeof raw !== "string") return;
      let message: Record<string, unknown> | undefined;
      try {
        message = record(JSON.parse(raw));
      } catch {
        this.#failAll(new Error("Codex app-server sent invalid JSON"));
        return;
      }
      if (!message) return;
      if (message.id === undefined && typeof message.method === "string") {
        for (const listener of this.#subscriptions) listener.notification(message.method, message.params);
        return;
      }
      if (typeof message.id !== "number") return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      const error = record(message.error);
      if (error) {
        pending.reject(new Error(
          typeof error.message === "string" ? error.message : "Codex app-server request failed",
        ));
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener("close", () => {
      this.#closed = true;
      for (const listener of this.#subscriptions) listener.disconnected();
      this.#subscriptions.clear();
      this.#failAll(new Error("Codex app-server WebSocket closed"));
    });
    socket.addEventListener("error", () => {
      for (const listener of this.#subscriptions) listener.disconnected();
      this.#failAll(new Error("Codex app-server WebSocket failed"));
    });
  }

  subscribe(notification: (method: string, params: unknown) => void, disconnected: () => void): () => void {
    if (this.#closed) throw new Error("Native lifecycle connection closed");
    const listener = { notification, disconnected };
    this.#subscriptions.add(listener);
    return () => { this.#subscriptions.delete(listener); };
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Codex app-server RPC is closed"));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id);
        reject(abortError());
      };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        resolve: value => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: error => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      try {
        this.#socket.send(JSON.stringify({
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        }));
      } catch (error) {
        this.#pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) throw new Error("Codex app-server RPC is closed");
    this.#socket.send(JSON.stringify({ method, ...(params !== undefined ? { params } : {}) }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close(1000, "ChatGPT Tela app-server observation complete");
    this.#failAll(new Error("Codex app-server RPC closed"));
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

async function waitForOpen(socket: WebSocketLike, signal?: AbortSignal): Promise<void> {
  if (socket.readyState === 1) return;
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const open = () => finish(resolvePromise);
    const error = () => finish(() => rejectPromise(new Error("Codex app-server WebSocket failed to open")));
    const close = () => finish(() => rejectPromise(new Error("Codex app-server WebSocket closed before opening")));
    const abort = () => finish(() => rejectPromise(abortError()));
    const finish = (complete: () => void) => {
      socket.removeEventListener("open", open);
      socket.removeEventListener("error", error);
      socket.removeEventListener("close", close);
      signal?.removeEventListener("abort", abort);
      complete();
    };
    socket.addEventListener("open", open, { once: true });
    socket.addEventListener("error", error, { once: true });
    socket.addEventListener("close", close, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function connectCodexAppServerWebSocket(
  endpoint: string,
  options: CodexAppServerWebSocketOptions = {},
): Promise<CodexAppServerRpc> {
  const url = validateLoopbackWebSocket(endpoint);
  const createWebSocket = options.createWebSocket
    ?? (value => new WebSocket(value) as unknown as WebSocketLike);
  const socket = createWebSocket(url.href);
  await waitForOpen(socket, options.signal);
  const rpc = new WebSocketCodexAppServerRpc(socket);
  try {
    await rpc.request("initialize", {
      clientInfo: {
        name: CLIENT_NAME,
        title: "ChatGPT Tela",
        version: CLIENT_VERSION,
      },
      capabilities: {
        experimentalApi: true,
      },
    }, options.signal);
    rpc.notify("initialized");
    return rpc;
  } catch (error) {
    await rpc.close().catch(() => {});
    throw error;
  }
}

export function appServerCurrentTurnSource(
  endpoint: string, options: {
    readonly includeNativeGoal?: boolean;
    readonly preferBoundedTurnProof?: boolean;
  } = {},
): AppServerCurrentTurnSource {
  return new AppServerCurrentTurnSource(
    signal => connectCodexAppServerWebSocket(endpoint, { ...(signal ? { signal } : {}) }),
    options,
  );
}
