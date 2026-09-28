import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChatWorkspaceRegistry } from "./workspaces";
import { resolveWorkspaceDirectory } from "./paths";

const MAX_YIELD_MS = 12_000;
const DEFAULT_YIELD_MS = 10_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_OPERATIONS = 256;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

export type ProcessOperationState =
  | "starting"
  | "running"
  | "exited"
  | "signaled"
  | "spawn_failed"
  | "unknown";

interface DurableOperation {
  readonly operationId: string;
  readonly serverInstanceId: string;
  readonly workspaceId: string;
  readonly sessionId: number;
  readonly pid?: number;
  readonly state: ProcessOperationState;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly signal?: string;
}

interface OperationStore {
  readonly version: 1;
  readonly operations: readonly DurableOperation[];
}

interface LiveSession {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly sessionId: number;
  readonly child: ChildProcessWithoutNullStreams;
  chunks: Buffer[];
  outputBytes: number;
  baseOffset: number;
  readOffset: number;
  truncated: boolean;
}

export interface ChatProcessSnapshot {
  readonly operationId: string;
  readonly serverInstanceId: string;
  readonly workspaceId: string;
  readonly sessionId: number;
  readonly pid?: number;
  readonly state: ProcessOperationState;
  readonly ioAvailable: boolean;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly output: string;
  readonly outputTruncated: boolean;
}

export interface ChatProcessStatus {
  readonly operationId: string;
  readonly serverInstanceId: string;
  readonly workspaceId: string;
  readonly sessionId: number;
  readonly pid?: number;
  readonly state: ProcessOperationState;
  readonly liveness: "alive" | "not_running" | "unknown";
  readonly ioAvailable: boolean;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly signal?: string;
}

function parseStore(value: unknown): OperationStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tela Chat process store must be an object");
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.operations)) throw new Error("Tela Chat process store version is invalid");
  const operations = root.operations.map((entry, index): DurableOperation => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`operation[${index}] is invalid`);
    const row = entry as Record<string, unknown>;
    const text = (field: string): string => {
      const value = row[field];
      if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`operation[${index}].${field} is invalid`);
      return value;
    };
    const state = row.state;
    if (!(["starting", "running", "exited", "signaled", "spawn_failed", "unknown"] as const).includes(state as never)) {
      throw new Error(`operation[${index}].state is invalid`);
    }
    if (!Number.isSafeInteger(row.sessionId) || (row.sessionId as number) < 1) throw new Error("operation session id is invalid");
    if (row.pid !== undefined && (!Number.isSafeInteger(row.pid) || (row.pid as number) < 1)) throw new Error("operation pid is invalid");
    if (row.exitCode !== undefined && !Number.isSafeInteger(row.exitCode)) throw new Error("operation exit code is invalid");
    return Object.freeze({
      operationId: text("operationId"),
      serverInstanceId: text("serverInstanceId"),
      workspaceId: text("workspaceId"),
      sessionId: row.sessionId as number,
      ...(row.pid === undefined ? {} : { pid: row.pid as number }),
      state: state as ProcessOperationState,
      startedAt: text("startedAt"),
      updatedAt: text("updatedAt"),
      ...(row.endedAt === undefined ? {} : { endedAt: text("endedAt") }),
      ...(row.exitCode === undefined ? {} : { exitCode: row.exitCode as number }),
      ...(row.signal === undefined ? {} : { signal: text("signal") }),
    });
  });
  return Object.freeze({ version: 1, operations: Object.freeze(operations) });
}

function shell(command: string): { readonly executable: string; readonly args: readonly string[] } {
  if (process.platform === "win32") {
    return { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { executable: "/bin/sh", args: ["-lc", command] };
}

function yieldMs(value: number | undefined): number {
  const parsed = value ?? DEFAULT_YIELD_MS;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_YIELD_MS) {
    throw new Error(`yieldTime must be an integer from 0 to ${MAX_YIELD_MS}`);
  }
  return parsed;
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("operation id must be a UUID");
  }
  return value;
}

export class ChatProcessManager {
  readonly #workspaces: ChatWorkspaceRegistry;
  readonly #storePath: string;
  readonly #serverInstanceId = randomUUID();
  readonly #operations = new Map<string, DurableOperation>();
  readonly #sessions = new Map<number, LiveSession>();
  #nextSessionId = 1;
  #closed = false;

  constructor(input: { readonly workspaces: ChatWorkspaceRegistry; readonly storePath: string }) {
    this.#workspaces = input.workspaces;
    this.#storePath = resolve(input.storePath);
    if (existsSync(this.#storePath)) {
      const store = parseStore(JSON.parse(readFileSync(this.#storePath, "utf8")) as unknown);
      for (const stored of store.operations) {
        this.#nextSessionId = Math.max(this.#nextSessionId, stored.sessionId + 1);
        const operation = stored.state === "starting" || stored.state === "running"
          ? Object.freeze({ ...stored, state: "unknown" as const, serverInstanceId: this.#serverInstanceId,
              updatedAt: new Date().toISOString() })
          : stored;
        this.#operations.set(operation.operationId, operation);
      }
      this.#prune();
      this.#save();
    }
  }

  #save(): void {
    mkdirSync(dirname(this.#storePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#storePath}.tmp-${process.pid}`;
    const store: OperationStore = { version: 1, operations: Object.freeze([...this.#operations.values()]) };
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, encoding: "utf8" });
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
    renameSync(temporary, this.#storePath);
  }

  #prune(): void {
    const threshold = Date.now() - TERMINAL_RETENTION_MS;
    for (const [id, operation] of this.#operations) {
      if (this.#operations.size < MAX_OPERATIONS) break;
      if (!["exited", "signaled", "spawn_failed", "unknown"].includes(operation.state)) continue;
      if (Date.parse(operation.updatedAt) > threshold) continue;
      this.#operations.delete(id);
    }
  }

  #update(operationId: string, update: Partial<DurableOperation>): DurableOperation {
    const previous = this.#operations.get(operationId);
    if (!previous) throw new Error("unknown process operation");
    const next = Object.freeze({ ...previous, ...update, operationId: previous.operationId,
      updatedAt: update.updatedAt ?? new Date().toISOString() });
    this.#operations.set(operationId, next);
    this.#save();
    return next;
  }

  #append(session: LiveSession, chunk: Buffer): void {
    if (chunk.length === 0) return;
    session.chunks.push(Buffer.from(chunk));
    session.outputBytes += chunk.length;
    while (session.outputBytes > MAX_OUTPUT_BYTES && session.chunks.length > 1) {
      const removed = session.chunks.shift()!;
      session.outputBytes -= removed.length;
      session.baseOffset += removed.length;
      session.truncated = true;
    }
  }

  #output(session: LiveSession): { readonly output: string; readonly truncated: boolean } {
    const buffer = Buffer.concat(session.chunks);
    const localOffset = Math.max(0, session.readOffset - session.baseOffset);
    const output = buffer.subarray(localOffset).toString("utf8");
    session.readOffset = session.baseOffset + buffer.length;
    return { output, truncated: session.truncated && localOffset === 0 };
  }

  async #wait(session: LiveSession, timeout: number): Promise<void> {
    const operation = this.#operations.get(session.operationId);
    if (!operation || !["starting", "running"].includes(operation.state) || timeout === 0) return;
    await new Promise<void>(resolvePromise => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.child.removeListener("close", finish);
        session.child.removeListener("error", finish);
        resolvePromise();
      };
      session.child.once("close", finish);
      session.child.once("error", finish);
      const timer = setTimeout(finish, timeout);
    });
  }

  #snapshot(operation: DurableOperation, consumeOutput: boolean): ChatProcessSnapshot {
    const session = this.#sessions.get(operation.sessionId);
    const output = session && consumeOutput ? this.#output(session) : { output: "", truncated: false };
    return Object.freeze({
      operationId: operation.operationId,
      serverInstanceId: operation.serverInstanceId,
      workspaceId: operation.workspaceId,
      sessionId: operation.sessionId,
      ...(operation.pid === undefined ? {} : { pid: operation.pid }),
      state: operation.state,
      ioAvailable: session !== undefined && ["starting", "running"].includes(operation.state),
      startedAt: operation.startedAt,
      updatedAt: operation.updatedAt,
      ...(operation.endedAt === undefined ? {} : { endedAt: operation.endedAt }),
      ...(operation.exitCode === undefined ? {} : { exitCode: operation.exitCode }),
      ...(operation.signal === undefined ? {} : { signal: operation.signal }),
      output: output.output,
      outputTruncated: output.truncated,
    });
  }

  async exec(input: {
    readonly workspaceId: string;
    readonly command: string;
    readonly workingDirectory?: string;
    readonly operationId?: string;
    readonly yieldTimeMs?: number;
  }): Promise<ChatProcessSnapshot> {
    if (this.#closed) throw new Error("Tela Chat process manager is closed");
    if (typeof input.command !== "string" || !input.command.trim() || input.command.length > 64 * 1024) {
      throw new Error("command is empty or too large");
    }
    const workspace = this.#workspaces.get(input.workspaceId);
    const cwd = resolveWorkspaceDirectory(workspace.root, input.workingDirectory);
    const operationId = input.operationId ? uuid(input.operationId) : randomUUID();
    const existing = this.#operations.get(operationId);
    if (existing) return this.#snapshot(existing, false);
    this.#prune();
    if (this.#operations.size >= MAX_OPERATIONS) {
      throw new Error("Tela Chat process operation registry is at capacity; no process was started");
    }
    const sessionId = this.#nextSessionId++;
    const startedAt = new Date().toISOString();
    const reserved: DurableOperation = Object.freeze({
      operationId,
      serverInstanceId: this.#serverInstanceId,
      workspaceId: workspace.id,
      sessionId,
      state: "starting",
      startedAt,
      updatedAt: startedAt,
    });
    this.#operations.set(operationId, reserved);
    this.#save();
    const invocation = shell(input.command);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(invocation.executable, [...invocation.args], {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.#update(operationId, { state: "spawn_failed", endedAt: new Date().toISOString() });
      throw error;
    }
    const session: LiveSession = {
      operationId,
      workspaceId: workspace.id,
      sessionId,
      child,
      chunks: [],
      outputBytes: 0,
      baseOffset: 0,
      readOffset: 0,
      truncated: false,
    };
    this.#sessions.set(sessionId, session);
    child.stdout.on("data", (chunk: Buffer) => this.#append(session, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#append(session, chunk));
    child.once("spawn", () => {
      this.#update(operationId, { state: "running", ...(child.pid ? { pid: child.pid } : {}) });
    });
    child.once("error", () => {
      const current = this.#operations.get(operationId);
      if (current && ["starting", "running"].includes(current.state)) {
        this.#update(operationId, { state: "spawn_failed", endedAt: new Date().toISOString() });
      }
    });
    child.once("close", (code, signal) => {
      const current = this.#operations.get(operationId);
      if (!current || !["starting", "running"].includes(current.state)) return;
      const endedAt = new Date().toISOString();
      if (signal) this.#update(operationId, { state: "signaled", signal, endedAt });
      else this.#update(operationId, { state: "exited", exitCode: code ?? -1, endedAt });
    });
    await this.#wait(session, yieldMs(input.yieldTimeMs));
    return this.#snapshot(this.#operations.get(operationId)!, true);
  }

  async writeStdin(input: {
    readonly workspaceId: string;
    readonly sessionId: number;
    readonly chars?: string;
    readonly yieldTimeMs?: number;
  }): Promise<ChatProcessSnapshot> {
    this.#workspaces.get(input.workspaceId);
    if (!Number.isSafeInteger(input.sessionId) || input.sessionId < 1) throw new Error("process session id is invalid");
    const session = this.#sessions.get(input.sessionId);
    if (!session || session.workspaceId !== input.workspaceId) throw new Error("process session is not available in this workspace");
    const operation = this.#operations.get(session.operationId)!;
    if (input.chars && ["starting", "running"].includes(operation.state)) session.child.stdin.write(input.chars);
    await this.#wait(session, yieldMs(input.yieldTimeMs));
    return this.#snapshot(this.#operations.get(session.operationId)!, true);
  }

  status(workspaceId: string, operationId: string): ChatProcessStatus {
    this.#workspaces.get(workspaceId);
    const operation = this.#operations.get(uuid(operationId));
    if (!operation || operation.workspaceId !== workspaceId) throw new Error("unknown process operation in this workspace");
    const session = this.#sessions.get(operation.sessionId);
    const ioAvailable = session !== undefined && ["starting", "running"].includes(operation.state);
    const liveness = ioAvailable ? "alive" : ["exited", "signaled", "spawn_failed"].includes(operation.state)
      ? "not_running" : "unknown";
    return Object.freeze({
      operationId: operation.operationId,
      serverInstanceId: operation.serverInstanceId,
      workspaceId: operation.workspaceId,
      sessionId: operation.sessionId,
      ...(operation.pid === undefined ? {} : { pid: operation.pid }),
      state: operation.state,
      liveness,
      ioAvailable,
      startedAt: operation.startedAt,
      updatedAt: operation.updatedAt,
      ...(operation.endedAt === undefined ? {} : { endedAt: operation.endedAt }),
      ...(operation.exitCode === undefined ? {} : { exitCode: operation.exitCode }),
      ...(operation.signal === undefined ? {} : { signal: operation.signal }),
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const live = [...this.#sessions.values()].filter(session => {
      const state = this.#operations.get(session.operationId)?.state;
      return state === "starting" || state === "running";
    });
    for (const session of live) session.child.kill("SIGTERM");
    await Promise.all(live.map(async session => {
      await this.#wait(session, 1_500);
      const state = this.#operations.get(session.operationId)?.state;
      if ((state === "starting" || state === "running") && session.child.exitCode === null) {
        session.child.kill("SIGKILL");
        await this.#wait(session, 500);
      }
    }));
  }
}
