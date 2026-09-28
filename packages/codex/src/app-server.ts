import { isAbsolute, relative, resolve } from "node:path";
import type { CanonicalCurrentTurnSource } from "./binding";
import type { CanonicalCurrentTurnEvidence } from "./rollout";

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

export interface CodexAppServerRpc {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export type CodexAppServerRpcFactory = (
  signal?: AbortSignal,
) => Promise<CodexAppServerRpc>;

/**
 * Resolve current-turn authority entirely through Codex app-server's public v2 read contract.
 *
 * This is the authority path for managed/multi-profile runtimes where private CODEX_HOME paths stay
 * intentionally hidden. The app-server must prove the thread is active and exactly one newest turn is
 * in progress. Filesystem roots come only from app-server thread/environment state. Sandbox details
 * stay opaque and Native Codex remains the sole executor/enforcer for returned tool calls.
 */
export class AppServerCurrentTurnSource implements CanonicalCurrentTurnSource {
  readonly #connect: CodexAppServerRpcFactory;

  constructor(connect: CodexAppServerRpcFactory) {
    this.#connect = connect;
  }

  async currentTurn(threadId: string): Promise<CanonicalCurrentTurnEvidence | undefined> {
    const expectedThreadId = identifier(threadId, "requested thread id");
    const rpc = await this.#connect();
    try {
      const readResponse = record(await rpc.request("thread/read", {
        threadId: expectedThreadId,
        includeTurns: false,
      }));
      const thread = readResponse ? record(readResponse.thread) : undefined;
      if (!thread) throw new Error("Codex app-server thread/read response is invalid");
      if (identifier(thread.id, "thread id") !== expectedThreadId) {
        throw new Error("Codex app-server returned a different thread");
      }
      const status = record(thread.status);
      if (status?.type !== "active") return undefined;

      const turnsResponse = record(await rpc.request("thread/turns/list", {
        threadId: expectedThreadId,
        limit: 2,
        sortDirection: "desc",
        itemsView: "notLoaded",
      }));
      if (!turnsResponse || !Array.isArray(turnsResponse.data)) {
        throw new Error("Codex app-server thread/turns/list response is invalid");
      }
      const turns = turnsResponse.data.map(value => record(value));
      if (turns.some(value => !value)) {
        throw new Error("Codex app-server returned an invalid turn entry");
      }
      const inProgress = turns
        .filter((value): value is Record<string, unknown> => value !== undefined)
        .filter(value => value.status === "inProgress");
      if (inProgress.length === 0) return undefined;
      if (inProgress.length > 1) {
        throw new Error("Codex app-server reported multiple in-progress turns for one thread");
      }
      if (turns[0] !== inProgress[0]) {
        throw new Error("Codex app-server current turn is not the newest turn");
      }

      const currentTurnId = identifier(inProgress[0]!.id, "current turn id");
      const resolvedEnvironment = environment(thread);
      const resolvedOwner = owner(thread);
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
      if (!message || typeof message.id !== "number") return;
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
      this.#failAll(new Error("Codex app-server WebSocket closed"));
    });
    socket.addEventListener("error", () => {
      this.#failAll(new Error("Codex app-server WebSocket failed"));
    });
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

export function appServerCurrentTurnSource(endpoint: string): AppServerCurrentTurnSource {
  return new AppServerCurrentTurnSource(
    signal => connectCodexAppServerWebSocket(endpoint, { ...(signal ? { signal } : {}) }),
  );
}
