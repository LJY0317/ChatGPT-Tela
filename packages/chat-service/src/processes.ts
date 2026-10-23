import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { CURRENT_CHAT_PROCESS_STORE_COMPATIBILITY } from "@chatgpt-tela/product-lifecycle/chat-process-storage";
import { diagnosticContext, diagnosticDurationMs, diagnosticFailureClass, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChatWorkspaceRegistry } from "./workspaces";
import { resolveWorkspaceDirectory } from "./paths";
import { readBoundedProcessState, replaceProcessState, writeExclusiveProcessState } from "./process-state";
import { appendProcessOutput, consumeProcessOutput, PROCESS_OUTPUT_LIMIT } from "./process-output";
import { ProcessExecutionJournal } from "./process-execution-journal";
import { ProcessRetirement, type RetirementArtifactProof } from "./process-retirement";
import { ProcessCompletionArchive } from "./process-completion-archive";
import { callProcessOwner, type ProcessOwnerRequest } from "./process-owner";
import { windowsCommandLine } from "./windows-command";

const MAX_YIELD_MS = 12_000;
const DEFAULT_YIELD_MS = 10_000;
const MAX_OUTPUT_BYTES = PROCESS_OUTPUT_LIMIT;
// Hot reservations primarily protect unfinished/uncertain executions.
// Authenticated completed receipts are independently bounded in SQLite;
// archive failure preserves the original hot reservation and may still
// exhaust this cap. 1,024 is an engineering guard, not an industry standard.
// The 1 MiB hot JSON budget remains independently enforced.
const MAX_OPERATIONS = 1024;
const MAX_COMPLETED_ARCHIVE = 50_000;
const MAX_STORE_BYTES = 1024 * 1024;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Capacity-only, read-only outlook. Never promises successful archival, disk
 * persistence or a new execution: those require the real admission path.
 */
export function processAdmissionOutlook(capacity: {
  readonly registryCount: number;
  readonly registryLimit: number;
  readonly terminalRecentCount: number;
  readonly terminalExpiredCount: number;
  readonly archivedTerminalCount: number;
  readonly archiveLimit: number;
}): "slot_available" | "on_demand_reclaim_candidate" | "archive_capacity_uncertain" | "no_terminal_candidate" {
  if (capacity.registryCount < capacity.registryLimit) return "slot_available";
  // Expired terminal-marked reservations can be retired without using the
  // completion archive. The actual owner proof/store operations may still fail.
  if (capacity.terminalExpiredCount > 0) return "on_demand_reclaim_candidate";
  // Recent terminal reservations are safely moved to the archive on demand.
  if (capacity.terminalRecentCount > 0 && capacity.archivedTerminalCount < capacity.archiveLimit) {
    return "on_demand_reclaim_candidate";
  }
  // A full archive may have expired receipts eligible for retirement, but this
  // snapshot deliberately does not perform retirement or attest its success.
  if (capacity.terminalRecentCount > 0) return "archive_capacity_uncertain";
  return "no_terminal_candidate";
}

/** Never log the attempted command, executable, cwd, stderr or raw error. */
export function safeProcessSpawnFailure(error: unknown): {
  readonly error_class: "bad_file_descriptor" | "resource_exhausted"
    | "permission_denied" | "missing_executable" | "unknown";
  readonly runtime_class: "bun" | "node" | "other";
  readonly platform_class: "darwin" | "linux" | "win32" | "other";
} {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code : undefined;
  const error_class = code === "EBADF" ? "bad_file_descriptor"
    : code === "EAGAIN" || code === "EMFILE" || code === "ENFILE" || code === "ENOMEM"
      ? "resource_exhausted"
    : code === "EACCES" || code === "EPERM" ? "permission_denied"
    : code === "ENOENT" ? "missing_executable" : "unknown";
  return {
    error_class,
    runtime_class: typeof process.versions.bun === "string" ? "bun"
      : typeof process.versions.node === "string" ? "node" : "other",
    platform_class: process.platform === "darwin" || process.platform === "linux"
      || process.platform === "win32" ? process.platform : "other",
  };
}

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
  readonly requestFingerprint?: string;
  readonly executionMode?: "owned-worker-v1";
  readonly resultFingerprint?: string;
  readonly resultTruncated?: boolean;
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
  readonly version: typeof CURRENT_CHAT_PROCESS_STORE_COMPATIBILITY.writeVersion;
  readonly requestKey?: string;
  readonly operations: readonly DurableOperation[];
  readonly nextSessionId: number;
}

/** Internal candidate admission. Caller must supply a package-verified Chat executable. */
export interface OwnedProcessWorkerConfig {
  readonly executable: string;
  readonly workspaceStorePath: string;
  readonly approvedRootsPath: string;
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
  closed: boolean;
}

/** Lightweight same-instance output cursor retained after process close.
 * Command/output bytes are not held in memory once signed result storage
 * has been committed; restart intentionally recovers the full verified tail.
 */
interface CompletedSessionCursor {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly baseOffset: number;
  readOffset: number;
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
  readonly outputRecovered: boolean;
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
  if (![1, 2].includes(root.version as number) || !Array.isArray(root.operations)) throw new Error("Tela Chat process store version is invalid");
  // Version 2 makes the monotonic counter authoritative. A version-1 writer must
  // refuse rather than discard it after terminal retirement and reuse an id.
  if (root.version === 2 && (root.nextSessionId === undefined || root.requestKey === undefined)) {
    throw new Error("Tela Chat process store durable identity is missing");
  }
  if (root.operations.length > MAX_OPERATIONS) throw new Error("process operation store exceeds capacity");
  if (root.requestKey !== undefined && (typeof root.requestKey !== "string" || !/^[a-f0-9]{64}$/.test(root.requestKey))) {
    throw new Error("process request identity key is invalid");
  }
  const operationIds = new Set<string>();
  const sessionIds = new Set<number>();
  const operations = root.operations.map((entry, index): DurableOperation => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`operation[${index}] is invalid`);
    const row = entry as Record<string, unknown>;
    const text = (field: string): string => {
      const value = row[field];
      if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`operation[${index}].${field} is invalid`);
      return value;
    };
    if (row.executionMode !== undefined && row.executionMode !== "owned-worker-v1") throw new Error("invalid process execution mode");
    const state = row.state;
    if (!(["starting", "running", "exited", "signaled", "spawn_failed", "unknown"] as const).includes(state as never)) {
      throw new Error(`operation[${index}].state is invalid`);
    }
    if (!Number.isSafeInteger(row.sessionId) || (row.sessionId as number) < 1 || row.sessionId === Number.MAX_SAFE_INTEGER) throw new Error("operation session id is invalid");
    const operationId = uuid(text("operationId"));
    if (operationIds.has(operationId.toLowerCase()) || sessionIds.has(row.sessionId as number)) {
      throw new Error("process operation store contains duplicate execution identities");
    }
    operationIds.add(operationId.toLowerCase());
    sessionIds.add(row.sessionId as number);
    if (row.pid !== undefined && (!Number.isSafeInteger(row.pid) || (row.pid as number) < 1)) throw new Error("operation pid is invalid");
    if (row.exitCode !== undefined && !Number.isSafeInteger(row.exitCode)) throw new Error("operation exit code is invalid");
    if (row.requestFingerprint !== undefined && (root.requestKey === undefined || typeof row.requestFingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(row.requestFingerprint))) throw new Error("operation request identity is invalid");
    if (row.resultFingerprint !== undefined && (typeof row.resultFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.resultFingerprint)
      || root.requestKey === undefined || typeof row.resultTruncated !== "boolean"
      || !["exited", "signaled"].includes(state as string))) throw new Error("operation result identity is invalid");
    return Object.freeze({
      operationId,
      serverInstanceId: text("serverInstanceId"),
      workspaceId: text("workspaceId"),
      ...(row.requestFingerprint === undefined ? {} : { requestFingerprint: row.requestFingerprint as string }),
      ...(row.executionMode === undefined ? {} : { executionMode: "owned-worker-v1" as const }),
      ...(row.resultFingerprint === undefined ? {} : { resultFingerprint: row.resultFingerprint as string, resultTruncated: row.resultTruncated as boolean }),
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
  const minimumNext = Math.max(1, ...operations.map(operation => operation.sessionId + 1));
  if (root.nextSessionId !== undefined && (!Number.isSafeInteger(root.nextSessionId)
    || (root.nextSessionId as number) < minimumNext || (root.nextSessionId as number) >= Number.MAX_SAFE_INTEGER)) throw new Error("process session high-water mark is invalid");
  return Object.freeze({ version: CURRENT_CHAT_PROCESS_STORE_COMPATIBILITY.writeVersion, nextSessionId: (root.nextSessionId as number | undefined) ?? minimumNext,
    ...(root.requestKey === undefined ? {} : { requestKey: root.requestKey as string }),
    operations: Object.freeze(operations) });
}

function shell(command: string): { readonly executable: string; readonly args: readonly string[] } {
  if (process.platform === "win32") {
    return { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", windowsCommandLine(command)] };
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
  readonly #requestKey: string;
  readonly #ownerWorker: OwnedProcessWorkerConfig | undefined;
  readonly #archive: ProcessCompletionArchive<DurableOperation>;
  readonly #operations = new Map<string, DurableOperation>();
  readonly #sessions = new Map<number, LiveSession>();
  readonly #completedSessions = new Map<number, CompletedSessionCursor>();
  #nextSessionId = 1;
  #closed = false;

  constructor(input: { readonly workspaces: ChatWorkspaceRegistry; readonly storePath: string; readonly ownerWorker?: OwnedProcessWorkerConfig }) {
    this.#workspaces = input.workspaces;
    this.#storePath = resolve(input.storePath);
    this.#ownerWorker = input.ownerWorker;
    let recoveryPhase: "read" | "retire" | "write" = "read";
    try {
      if (existsSync(this.#storePath)) {
        const store = parseStore(JSON.parse(readBoundedProcessState(this.#storePath, MAX_STORE_BYTES).toString("utf8")) as unknown);
        this.#requestKey = store.requestKey ?? randomBytes(32).toString("hex");
        this.#nextSessionId = store.nextSessionId!;
        for (const stored of store.operations) {
          this.#nextSessionId = Math.max(this.#nextSessionId, stored.sessionId + 1);
          const operation = stored.state === "starting" || stored.state === "running"
            ? Object.freeze({ ...stored, state: "unknown" as const,
                updatedAt: new Date().toISOString() })
            : stored;
          this.#operations.set(operation.operationId, operation);
        }
        this.#archive = new ProcessCompletionArchive(`${this.#storePath}.completed.sqlite`, this.#requestKey, MAX_COMPLETED_ARCHIVE);
        recoveryPhase = "retire";
        this.#prune();
        // Completed receipts have an independent bounded SQLite owner.
        // Drain pre-existing hot receipts on service startup, even if no
        // subsequent command happens to arrive. This is not a background
        // timer. Any archive failure leaves the original hot evidence intact.
        try { this.#archiveCompleted([...this.#operations.values()]); }
        catch (error) {
          emitDiagnosticEvent("chatgpt_tela_chat", "process_completion_archive_failed", {
            reason_class: diagnosticFailureClass(error),
            registry_count: this.#operations.size, archive_limit: MAX_COMPLETED_ARCHIVE,
          });
        }
        recoveryPhase = "write";
        this.#save();
      } else {
        this.#requestKey = randomBytes(32).toString("hex");
        this.#archive = new ProcessCompletionArchive(`${this.#storePath}.completed.sqlite`, this.#requestKey, MAX_COMPLETED_ARCHIVE);
      }
    } catch (error) {
      emitDiagnosticEvent("chatgpt_tela_chat", "process_recovery_failed", {
        phase: recoveryPhase,
        reason_class: diagnosticFailureClass(error),
        registry_count: this.#operations.size,
        registry_limit: MAX_OPERATIONS,
      });
      throw error;
    }
    this.#workspaces.registerRemovalGuard(ids => {
      for (const operation of this.#operations.values()) {
        if (ids.has(operation.workspaceId)
          && !["exited", "signaled", "spawn_failed"].includes(operation.state)) {
          throw new Error("workspace has an active or unresolved process operation");
        }
      }
    });
  }

  #save(): void {
    mkdirSync(dirname(this.#storePath), { recursive: true, mode: 0o700 });
    const store: OperationStore = { version: CURRENT_CHAT_PROCESS_STORE_COMPATIBILITY.writeVersion, requestKey: this.#requestKey,
      nextSessionId: this.#nextSessionId,
      operations: Object.freeze([...this.#operations.values()]) };
    const contents = `${JSON.stringify(store, null, 2)}\n`;
    const bytes = Buffer.byteLength(contents, "utf8");
    if (bytes > MAX_STORE_BYTES) {
      emitDiagnosticEvent("chatgpt_tela_chat", "process_state_storage_failed", {
        reason_class: "storage_capacity", store_bytes: bytes, store_limit_bytes: MAX_STORE_BYTES,
        registry_count: this.#operations.size,
      });
      throw new Error("process operation store exceeds its byte limit");
    }
    try {
      replaceProcessState(this.#storePath, contents);
    } catch (error) {
      emitDiagnosticEvent("chatgpt_tela_chat", "process_state_storage_failed", {
        reason_class: diagnosticFailureClass(error) === "storage_capacity" ? "storage_capacity" : "storage_failure",
        store_bytes: bytes, store_limit_bytes: MAX_STORE_BYTES,
        registry_count: this.#operations.size,
      });
      throw error;
    }
  }

  /** Content-free, read-only admission diagnostics even when exec is full.
   * This is service-wide aggregate occupancy, never operation identities,
   * commands, workspace paths or proof that a PID has stopped.
   */
  #capacitySnapshot() {
    let unknownCount = 0, activeCount = 0;
    let terminalRecentCount = 0, terminalExpiredCount = 0;
    const cutoff = Date.now() - TERMINAL_RETENTION_MS;
    for (const operation of this.#operations.values()) {
      if (operation.state === "unknown") unknownCount++;
      else if (operation.state === "running" || operation.state === "starting") activeCount++;
      else if (Number.isFinite(Date.parse(operation.updatedAt))
        && Date.parse(operation.updatedAt) <= cutoff) terminalExpiredCount++;
      else terminalRecentCount++;
    }
    const capacity = {
      registryCount: this.#operations.size,
      registryLimit: MAX_OPERATIONS,
      availableSlots: Math.max(0, MAX_OPERATIONS - this.#operations.size),
      unknownCount, activeCount, terminalRecentCount, terminalExpiredCount,
      archivedTerminalCount: this.#archive.count(),
      archiveLimit: MAX_COMPLETED_ARCHIVE,
    };
    return Object.freeze({ ...capacity, admissionOutlook: processAdmissionOutlook(capacity) });
  }

  /** Durable handoff: commit authenticated archive first, then remove hot
   * terminal reservations in one synchronized state publication. A crash
   * between the two leaves both copies, with hot remaining authoritative.
   */
  #archiveCompleted(candidates: readonly DurableOperation[]): void {
    const completed = candidates.filter(operation =>
      ["exited", "signaled", "spawn_failed"].includes(operation.state)
      && this.#operations.get(operation.operationId) === operation);
    if (!completed.length) return;
    this.#archive.saveMany(completed);
    for (const operation of completed) this.#operations.delete(operation.operationId);
    try { this.#save(); }
    catch (error) {
      for (const operation of completed) this.#operations.set(operation.operationId, operation);
      throw error;
    }
    // Ordinary completions are not incidents. Keep this structural receipt
    // for a one-off legacy backlog drain, not every short shell command.
    if (completed.length > 1) emitDiagnosticEvent("chatgpt_tela_chat", "process_completion_archived", {
      registry_count: this.#operations.size, archived_count: this.#archive.count(),
      archive_limit: MAX_COMPLETED_ARCHIVE,
    });
  }

  #archiveCompletedSafely(operation: DurableOperation): void {
    try { this.#archiveCompleted([operation]); }
    catch (error) {
      // The command has already completed. Failed completion archival
      // cannot revoke its committed hot receipt or authorize replay.
      emitDiagnosticEvent("chatgpt_tela_chat", "process_completion_archive_failed", {
        reason_class: diagnosticFailureClass(error),
        registry_count: this.#operations.size, archive_limit: MAX_COMPLETED_ARCHIVE,
      });
    }
  }

  #prune(allowArchival = false): void {
    const retirement = new ProcessRetirement({ storePath: this.#storePath, key: this.#requestKey });
    const commit = (value: unknown): void => {
      const retired = parseStore({ version: 1, requestKey: this.#requestKey, operations: [value] }).operations[0]!;
      if (!["exited", "signaled", "spawn_failed"].includes(retired.state)) throw new Error("retirement is not terminal");
      const current = this.#operations.get(retired.operationId);
      const archived = this.#archive.get(retired.operationId);
      const canonical = (row: DurableOperation) => JSON.stringify(Object.entries(row).sort(([left], [right]) => left.localeCompare(right)));
      if (current && canonical(current) !== canonical(retired)) throw new Error("retirement reservation changed");
      if (archived && canonical(archived) !== canonical(retired)) throw new Error("archived retirement reservation changed");
      this.#nextSessionId = Math.max(this.#nextSessionId, retired.sessionId + 1);
      if (current) {
        this.#operations.delete(retired.operationId);
        try {
          this.#save(); // Commit authoritative removal/high-water mark before deleting any output.
        } catch (error) {
          this.#operations.set(retired.operationId, current);
          throw error;
        }
      }
      // A crash between these two commits is resumed by the signed retirement
      // plan. Neither uncertainty nor a partially completed archive move can
      // grant a second execution of the same operation ID.
      if (archived) this.#archive.remove(retired);
      this.#sessions.delete(retired.sessionId);
      this.#completedSessions.delete(retired.sessionId);
    };
    retirement.resume(commit);
    const threshold = Date.now() - TERMINAL_RETENTION_MS;
    const retire = (operation: DurableOperation): void => {
      const artifacts: RetirementArtifactProof[] = [];
      if (operation.resultFingerprint !== undefined) {
        this.#recoverOutput(operation, digest => artifacts.push({ kind: "result", digest }));
      }
      if (operation.executionMode === "owned-worker-v1") {
        const { journal, claim } = this.#ownedEvidence(operation, digest => artifacts.push({ kind: "claim", digest }));
        const completed = journal.readCompletion(claim, digest => artifacts.push({ kind: "completed", digest }));
        if (completed.state !== operation.state || completed.endedAt !== operation.endedAt
          || completed.exitCode !== operation.exitCode || completed.signal !== operation.signal
          || completed.resultFingerprint !== operation.resultFingerprint || completed.resultTruncated !== operation.resultTruncated) throw new Error("retirement completion does not match reservation");
        if (existsSync(`${this.#storePath}.executions/${operation.operationId}.live.json`)) {
          journal.readLive(claim, digest => artifacts.push({ kind: "live", digest }));
        }
      }
      retirement.prepare(operation, artifacts);
      retirement.resume(commit);
    };
    for (const operation of this.#operations.values()) {
      if (this.#operations.size < MAX_OPERATIONS) break;
      // Unknown execution may still be live. Preserve its reservation until resolved.
      if (!["exited", "signaled", "spawn_failed"].includes(operation.state)) continue;
      const updated = Date.parse(operation.updatedAt);
      if (!Number.isFinite(updated) || updated > threshold) continue;
      retire(operation);
    }
    // Expired archive receipts are retired with the same authenticated plan,
    // before admitting another terminal receipt. This remains demand-driven.
    for (let count = 0; count < 8; count++) {
      const expired = this.#archive.oldestExpired(new Date(threshold).toISOString());
      if (!expired) break;
      retire(expired);
    }
    // Fallback for terminal hot receipts left behind by failed archive
    // publication: never evict active/uncertain work just to admit a command.
    if (allowArchival && this.#operations.size >= MAX_OPERATIONS) {
      const completed = [...this.#operations.values()].find(operation =>
        ["exited", "signaled", "spawn_failed"].includes(operation.state));
      if (completed) {
        this.#archiveCompleted([completed]);
      }
    }
  }

  #update(operationId: string, update: Partial<DurableOperation>): DurableOperation {
    const previous = this.#operations.get(operationId);
    if (!previous) throw new Error("unknown process operation");
    const next = Object.freeze({ ...previous, ...update, operationId: previous.operationId,
      updatedAt: update.updatedAt ?? new Date().toISOString() });
    this.#operations.set(operationId, next);
    try { this.#save(); }
    catch (error) { this.#operations.set(operationId, previous); throw error; }
    return next;
  }

  /** Child events must not crash the service or publish an uncommitted outcome. */
  #recordTransition(operationId: string, update: Partial<DurableOperation>): boolean {
    try {
      const committed = this.#update(operationId, update);
      if (["exited", "signaled", "spawn_failed"].includes(committed.state)) this.#archiveCompletedSafely(committed);
      return true;
    }
    catch {
      const previous = this.#operations.get(operationId);
      if (previous) this.#operations.set(operationId, Object.freeze({ ...previous,
        state: "unknown" as const, updatedAt: new Date().toISOString() }));
      return false;
    }
  }

  #directIoAvailable(operation: DurableOperation, session: LiveSession | undefined): boolean {
    return session !== undefined && ["starting", "running", "unknown"].includes(operation.state)
      && session.child.pid !== undefined && session.child.exitCode === null
      && session.child.signalCode === null && !session.child.stdin.destroyed && !session.child.stdin.writableEnded;
  }

  #ownedEvidence(operation: DurableOperation, authenticatedDigest?: (digest: string) => void) {
    const journal = new ProcessExecutionJournal({ root: `${this.#storePath}.executions`, key: this.#requestKey });
    const claim = journal.readClaim(operation.operationId, authenticatedDigest);
    if (claim.workspaceId !== operation.workspaceId || claim.launchingServerId !== operation.serverInstanceId
      || claim.requestFingerprint !== operation.requestFingerprint) throw new Error("execution owner does not match process reservation");
    return { journal, claim };
  }

  #reconcileOwnedCompletion(operation: DurableOperation): DurableOperation {
    // An async owner observation may have started before another request
    // committed and archived its completion. Always use the current durable
    // receipt rather than updating a stale hot-record object.
    const current = this.#operations.get(operation.operationId) ?? this.#archive.get(operation.operationId);
    if (!current || current.workspaceId !== operation.workspaceId) throw new Error("process owner reservation changed");
    if (current.executionMode !== "owned-worker-v1"
      || ["exited", "signaled", "spawn_failed"].includes(current.state)) return current;
    const { journal, claim } = this.#ownedEvidence(current);
    if (!existsSync(`${this.#storePath}.executions/${current.operationId}.completed.json`)) return current;
    const completion = journal.readCompletion(claim);
    const committed = this.#update(current.operationId, { ...completion, updatedAt: completion.endedAt });
    this.#archiveCompletedSafely(committed);
    return committed;
  }

  async #observeOwned(operation: DurableOperation, request: ProcessOwnerRequest): Promise<ChatProcessSnapshot> {
    const completed = this.#reconcileOwnedCompletion(operation);
    if (["exited", "signaled", "spawn_failed"].includes(completed.state)) {
      if (request.action === "stdin") throw new Error("process input is no longer available");
      return this.#snapshot(completed, false);
    }
    const { journal, claim } = this.#ownedEvidence(completed);
    const descriptor = journal.readLive(claim);
    const result = await callProcessOwner(descriptor, request) as ChatProcessSnapshot;
    if (!result || result.operationId !== operation.operationId || result.workspaceId !== operation.workspaceId
      || result.serverInstanceId !== operation.serverInstanceId || result.sessionId !== operation.sessionId
      || result.startedAt !== operation.startedAt || typeof result.output !== "string"
      || Buffer.byteLength(result.output) > MAX_OUTPUT_BYTES || typeof result.outputTruncated !== "boolean"
      || typeof result.ioAvailable !== "boolean" || typeof result.outputRecovered !== "boolean"
      || !Number.isFinite(Date.parse(result.updatedAt))
      || (result.pid !== undefined && (!Number.isSafeInteger(result.pid) || result.pid < 1))
      || !["starting", "running", "exited", "signaled", "spawn_failed", "unknown"].includes(result.state)) {
      throw new Error("execution owner snapshot does not match process reservation");
    }
    this.#reconcileOwnedCompletion(completed);
    return Object.freeze(result);
  }

  async #launchOwner(operation: DurableOperation, command: string, workingDirectory: string | undefined, interactive: boolean): Promise<void> {
    const config = this.#ownerWorker!;
    let child: ChildProcess;
    try {
      // Independent owner lifetime; manager death must not close command pipes or authorize replay.
      child = spawn(config.executable, ["--tela-operation-owner-v1"], {
        detached: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
      });
    } catch (error) {
      this.#update(operation.operationId, { state: "spawn_failed", endedAt: new Date().toISOString() });
      throw error;
    }
    const ready = new Promise<void>((resolveReady, reject) => {
      let bytes = 0, text = "", settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout!.removeListener("data", received);
        child.removeListener("exit", exited);
        child.removeListener("error", failed);
        // No ongoing observation pipes or event-loop ownership in the manager.
        if (!error) child.stdout!.destroy();
        else {
          child.stdout!.resume();
          (child.stdout as typeof child.stdout & { unref?: () => void })?.unref?.();
        }
        child.unref();
        error ? reject(error) : resolveReady();
      };
      const received = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024) { finish(new Error("process owner readiness exceeded its bound")); return; }
        text += chunk.toString("utf8");
        if (text === "TELA_OPERATION_READY\n") finish();
      };
      const failed = () => finish(new Error("process owner could not start; inspect execution evidence before retrying"));
      const exited = () => finish(new Error("process owner exited before readiness; inspect execution evidence"));
      const timer = setTimeout(() => finish(new Error("process owner readiness is uncertain; execution was not retried")), MAX_YIELD_MS);
      child.stdout!.on("data", received);
      child.once("exit", exited); child.once("error", failed);
      child.stdin!.once("error", failed);
    });
    // Key remains in the private reservation store, never in argv or this ephemeral command payload.
    child.stdin!.end(JSON.stringify({ version: 1, operationId: operation.operationId, storePath: this.#storePath,
      workspaceStorePath: config.workspaceStorePath, approvedRootsPath: config.approvedRootsPath, command,
      ...(workingDirectory === undefined ? {} : { workingDirectory }), interactive }));
    try { await ready; }
    catch (error) {
      this.#update(operation.operationId, { state: "unknown" });
      throw error;
    }
  }

  #append(session: LiveSession, chunk: Buffer): void {
    appendProcessOutput(session, chunk);
  }

  #resultPath(operationId: string): string {
    return resolve(`${this.#storePath}.results`, `${uuid(operationId)}.bin`);
  }

  #resultFingerprint(operation: DurableOperation, output: Buffer): string {
    return createHmac("sha256", Buffer.from(this.#requestKey, "hex"))
      .update(JSON.stringify(["tela-chat-result-v1", operation.operationId, operation.workspaceId]))
      .update(output).digest("hex");
  }

  #retainOutput(operation: DurableOperation, session: LiveSession): Partial<DurableOperation> {
    const output = Buffer.concat(session.chunks);
    const path = this.#resultPath(operation.operationId);
    const root = dirname(path);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink()) throw new Error("process result directory must not be a symlink");
    // One immutable file per reservation; exclusive creation refuses replaced evidence.
    writeExclusiveProcessState(path, output);
    return { resultFingerprint: this.#resultFingerprint(operation, output), resultTruncated: session.truncated };
  }

  #verifiedOutputBytes(operation: DurableOperation, authenticatedDigest?: (digest: string) => void): Buffer {
    const path = this.#resultPath(operation.operationId);
    if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("process result directory must not be a symlink");
    const output = readBoundedProcessState(path, MAX_OUTPUT_BYTES);
    if (this.#resultFingerprint(operation, output) !== operation.resultFingerprint) throw new Error("process retained result does not match its reservation");
    authenticatedDigest?.(createHash("sha256").update(output).digest("hex"));
    return output;
  }

  #recoverOutput(operation: DurableOperation, authenticatedDigest?: (digest: string) => void): { output: string; truncated: boolean } {
    const output = this.#verifiedOutputBytes(operation, authenticatedDigest);
    return { output: output.toString("utf8"), truncated: operation.resultTruncated ?? false };
  }

  #output(session: LiveSession): { readonly output: string; readonly truncated: boolean } {
    return consumeProcessOutput(session);
  }

  async #wait(session: LiveSession, timeout: number): Promise<void> {
    const operation = this.#operations.get(session.operationId);
    if (!operation || session.closed || !["starting", "running", "unknown"].includes(operation.state) || timeout === 0) return;
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
    const terminalCursor = this.#completedSessions.get(operation.sessionId);
    const recovered = session === undefined && terminalCursor === undefined && operation.resultFingerprint !== undefined;
    let output: { output: string; truncated: boolean };
    if (terminalCursor && operation.resultFingerprint !== undefined) {
      // Match the old direct-process read-once semantics even though the
      // completed process and all its buffered chunks have been released.
      // A new service instance has no cursor, so it recovers the full tail.
      const verified = this.#verifiedOutputBytes(operation);
      const offset = Math.max(0, terminalCursor.readOffset - terminalCursor.baseOffset);
      output = consumeOutput
        ? { output: verified.subarray(offset).toString("utf8"),
          truncated: (operation.resultTruncated ?? false) && offset === 0 }
        : { output: "", truncated: false };
      if (consumeOutput) terminalCursor.readOffset = terminalCursor.baseOffset + verified.length;
    } else {
      output = recovered ? this.#recoverOutput(operation)
        : session && consumeOutput ? this.#output(session) : { output: "", truncated: false };
    }
    return Object.freeze({
      operationId: operation.operationId,
      serverInstanceId: operation.serverInstanceId,
      workspaceId: operation.workspaceId,
      sessionId: operation.sessionId,
      ...(operation.pid === undefined ? {} : { pid: operation.pid }),
      state: operation.state,
      ioAvailable: this.#directIoAvailable(operation, session),
      startedAt: operation.startedAt,
      updatedAt: operation.updatedAt,
      ...(operation.endedAt === undefined ? {} : { endedAt: operation.endedAt }),
      ...(operation.exitCode === undefined ? {} : { exitCode: operation.exitCode }),
      ...(operation.signal === undefined ? {} : { signal: operation.signal }),
      output: output.output,
      outputTruncated: output.truncated,
      outputRecovered: recovered,
    });
  }

  async exec(input: {
    readonly workspaceId: string;
    readonly command: string;
    readonly workingDirectory?: string;
    readonly operationId?: string;
    readonly yieldTimeMs?: number;
    readonly interactive?: boolean;
  }): Promise<ChatProcessSnapshot> {
    if (this.#closed) throw new Error("Tela Chat process manager is closed");
    if (typeof input.command !== "string" || !input.command.trim() || input.command.includes("\0")
      || Buffer.byteLength(input.command, "utf8") > 64 * 1024) {
      throw new Error("command is empty or too large");
    }
    const workspace = this.#workspaces.get(input.workspaceId);
    if (this.#ownerWorker && workspace.kind !== "user") throw new Error("owner-worker managed workspace admission is not yet supported");
    if (input.interactive !== undefined && typeof input.interactive !== "boolean") throw new Error("interactive must be a boolean");
    const cwd = resolveWorkspaceDirectory(workspace.root, input.workingDirectory);
    const waitTime = yieldMs(input.yieldTimeMs);
    const requestFingerprint = createHmac("sha256", Buffer.from(this.#requestKey, "hex"))
      .update(JSON.stringify(["tela-chat-exec-v1", workspace.id, cwd, input.command, input.interactive === true])).digest("hex");
    const operationId = input.operationId ? uuid(input.operationId) : randomUUID();
    const existing = this.#operations.get(operationId) ?? this.#archive.get(operationId);
    if (existing) {
      if (existing.workspaceId !== workspace.id) throw new Error("process operation belongs to another workspace");
      if (existing.requestFingerprint === undefined) throw new Error("process operation request identity is unavailable; inspect its status instead");
      if (existing.requestFingerprint !== requestFingerprint) throw new Error("process operation request does not match its reserved command and directory");
      if (existing.executionMode === "owned-worker-v1") return this.#observeOwned(existing, { action: "wait", yieldTimeMs: waitTime });
      return this.#snapshot(existing, false);
    }
    try {
      this.#prune(true);
    } catch (error) {
      emitDiagnosticEvent("chatgpt_tela_chat", "process_retirement_failed", {
        reason_class: diagnosticFailureClass(error), registry_count: this.#operations.size,
        registry_limit: MAX_OPERATIONS,
      });
      throw error;
    }
    if (this.#operations.size >= MAX_OPERATIONS) {
      const occupancy = this.#capacitySnapshot();
      withDiagnosticContext({
        operation_fingerprint: diagnosticFingerprint(operationId),
        scope_fingerprint: diagnosticFingerprint(workspace.id),
      }, () => emitDiagnosticEvent("chatgpt_tela_chat", "process_capacity_rejected", {
        reason_class: "capacity_exhausted", registry_count: occupancy.registryCount,
        registry_limit: occupancy.registryLimit, unknown_count: occupancy.unknownCount,
        active_count: occupancy.activeCount,
        terminal_recent_count: occupancy.terminalRecentCount,
        terminal_expired_count: occupancy.terminalExpiredCount,
        archived_terminal_count: this.#archive.count(),
        archive_limit: MAX_COMPLETED_ARCHIVE,
      }));
      throw new Error("Tela Chat process operation registry is at capacity; no process was started");
    }
    if (this.#nextSessionId >= Number.MAX_SAFE_INTEGER) throw new Error("process session identity capacity exhausted");
    const sessionId = this.#nextSessionId++;
    const startedAt = new Date().toISOString();
    const diagnosticOrigin = { ...diagnosticContext(), operation_fingerprint: diagnosticFingerprint(operationId), scope_fingerprint: diagnosticContext().scope_fingerprint ?? diagnosticFingerprint(workspace.id) };
    const processDiagnostic = (stage: string, fields: Record<string, string | number | boolean> = {}) => withDiagnosticContext(diagnosticOrigin, () => emitDiagnosticEvent("chatgpt_tela_chat", stage, {
      duration_ms: diagnosticDurationMs(Date.parse(startedAt)), ...fields,
    }));
    const reserved: DurableOperation = Object.freeze({
      operationId,
      serverInstanceId: this.#serverInstanceId,
      workspaceId: workspace.id,
      requestFingerprint,
      ...(this.#ownerWorker ? { executionMode: "owned-worker-v1" as const } : {}),
      sessionId,
      state: "starting",
      startedAt,
      updatedAt: startedAt,
    });
    this.#operations.set(operationId, reserved);
    this.#save();
    if (this.#ownerWorker) {
      await this.#launchOwner(reserved, input.command, input.workingDirectory, input.interactive === true);
      return this.#observeOwned(reserved, { action: "wait", yieldTimeMs: waitTime });
    }
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
      processDiagnostic("process_spawn_failed", safeProcessSpawnFailure(error));
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
      closed: false,
    };
    this.#sessions.set(sessionId, session);
    child.stdout.on("data", (chunk: Buffer) => this.#append(session, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#append(session, chunk));
    if (!input.interactive) child.stdin.end();
    child.once("spawn", () => {
      processDiagnostic("process_started");
      if (!this.#recordTransition(operationId, { state: "running", ...(child.pid ? { pid: child.pid } : {}) })) {
        processDiagnostic("process_state_storage_failed");
      }
    });
    child.once("error", error => {
      const current = this.#operations.get(operationId);
      if (current && ["starting", "running"].includes(current.state)) {
        processDiagnostic("process_spawn_failed", safeProcessSpawnFailure(error));
        if (!this.#recordTransition(operationId, { state: child.pid === undefined ? "spawn_failed" : "unknown",
          endedAt: new Date().toISOString() })) processDiagnostic("process_state_storage_failed");
      }
    });
    child.once("close", (code, signal) => {
      session.closed = true;
      const current = this.#operations.get(operationId) ?? this.#archive.get(operationId);
      if (!current) return;
      if (current.state === "spawn_failed") {
        // A child with an emitted spawn error can still deliver a 'close'
        // event. Its already-committed terminal receipt must not retain a
        // dead ChildProcess or its output buffers indefinitely.
        this.#completedSessions.set(sessionId, {
          operationId, workspaceId: workspace.id,
          baseOffset: session.baseOffset, readOffset: session.readOffset,
        });
        this.#sessions.delete(sessionId);
        return;
      }
      if (!["starting", "running", "unknown"].includes(current.state)) return;
      const endedAt = new Date().toISOString();
      let result: Partial<DurableOperation>;
      try {
        result = this.#retainOutput(current, session);
      } catch (error) {
        // Preserve uncertain/partial evidence and its capacity reservation, without replay.
        processDiagnostic("process_result_retention_failed", {
          reason_class: diagnosticFailureClass(error),
        });
        if (!this.#recordTransition(operationId, { state: "unknown", endedAt, ...(code === null ? {} : { exitCode: code }) })) {
          processDiagnostic("process_state_storage_failed");
        }
        return;
      }
      const committed = this.#recordTransition(operationId, signal
        ? { state: "signaled", signal, endedAt, ...result }
        : { state: "exited", exitCode: code ?? -1, endedAt, ...result });
      if (committed) {
        // The archived receipt authenticates the complete bounded tail.
        // Preserve only the byte cursor needed for remaining incremental
        // reads; never retain up to 512 KiB per completed child in RAM.
        this.#completedSessions.set(sessionId, {
          operationId, workspaceId: workspace.id,
          baseOffset: session.baseOffset, readOffset: session.readOffset,
        });
        this.#sessions.delete(sessionId);
        processDiagnostic("process_settled", { exit_code: code ?? -1, signaled: signal !== null, result_bytes: session.outputBytes, truncated: session.truncated });
      }
      else processDiagnostic("process_completion_storage_failed", { result_bytes: session.outputBytes, truncated: session.truncated });
    });
    await this.#wait(session, waitTime);
    return this.#snapshot((this.#operations.get(operationId) ?? this.#archive.get(operationId))!, true);
  }

  async writeStdin(input: {
    readonly workspaceId: string;
    readonly sessionId: number;
    readonly chars?: string;
    readonly yieldTimeMs?: number;
  }): Promise<ChatProcessSnapshot> {
    this.#workspaces.get(input.workspaceId);
    if (!Number.isSafeInteger(input.sessionId) || input.sessionId < 1) throw new Error("process session id is invalid");
    const waitTime = yieldMs(input.yieldTimeMs);
    const owned = [...this.#operations.values()].find(operation => operation.sessionId === input.sessionId
      && operation.workspaceId === input.workspaceId && operation.executionMode === "owned-worker-v1")
      ?? (() => {
        const archived = this.#archive.getBySessionId(input.sessionId);
        return archived?.workspaceId === input.workspaceId && archived.executionMode === "owned-worker-v1"
          ? archived : undefined;
      })();
    if (owned) {
      if (["exited", "signaled", "spawn_failed"].includes(owned.state)) {
        if (input.chars) throw new Error("process input is no longer available");
        return this.#snapshot(owned, false);
      }
      if (input.chars) await this.#observeOwned(owned, { action: "stdin", chars: input.chars });
      return this.#observeOwned((this.#operations.get(owned.operationId) ?? this.#archive.get(owned.operationId))!,
        { action: "wait", yieldTimeMs: waitTime });
    }
    const session = this.#sessions.get(input.sessionId);
    if (!session) {
      const finished = this.#completedSessions.get(input.sessionId);
      if (!finished || finished.workspaceId !== input.workspaceId) throw new Error("process session is not available in this workspace");
      const terminal = this.#operations.get(finished.operationId) ?? this.#archive.get(finished.operationId);
      if (!terminal) throw new Error("completed process receipt is no longer available");
      return this.#snapshot(terminal, true);
    }
    if (session.workspaceId !== input.workspaceId) throw new Error("process session is not available in this workspace");
    const operation = this.#operations.get(session.operationId) ?? this.#archive.get(session.operationId);
    if (!operation) throw new Error("process reservation is no longer available");
    if (input.chars) {
      if (!this.#directIoAvailable(operation, session)) throw new Error("process input is no longer available");
      session.child.stdin.write(input.chars);
    }
    await this.#wait(session, waitTime);
    return this.#snapshot((this.#operations.get(session.operationId) ?? this.#archive.get(session.operationId))!, true);
  }

  status(workspaceId: string, operationId: string): ChatProcessStatus {
    this.#workspaces.get(workspaceId);
    const stored = this.#operations.get(uuid(operationId)) ?? this.#archive.get(operationId);
    if (!stored || stored.workspaceId !== workspaceId) throw new Error("unknown process operation in this workspace");
    return this.#statusSnapshot(this.#reconcileOwnedCompletion(stored));
  }

  #statusSnapshot(operation: DurableOperation): ChatProcessStatus {
    const session = this.#sessions.get(operation.sessionId);
    const ioAvailable = this.#directIoAvailable(operation, session);
    const liveness = session && session.child.pid !== undefined && session.child.exitCode === null
      && session.child.signalCode === null ? "alive" : ["exited", "signaled", "spawn_failed"].includes(operation.state)
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

  /** Maintenance uses the same hot unresolved reservations that block shutdown.
   * Workspace directories may have disappeared; their reservations still count. */
  maintenanceUnresolved(): readonly ChatProcessStatus[] {
    return Object.freeze([...this.#operations.values()].map(operation =>
      this.#reconcileOwnedCompletion(operation)).filter(operation =>
      !["exited", "signaled", "spawn_failed"].includes(operation.state))
      .map(operation => this.#statusSnapshot(operation)));
  }

  /** Bounded registry discovery only: no owner probes, output consumption or execution replay. */
  list(input: { readonly workspaceId: string; readonly afterSessionId?: number;
    readonly limit?: number; readonly includeCompleted?: boolean }) {
    this.#workspaces.get(input.workspaceId);
    const after = input.afterSessionId ?? 0;
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("after_session_id must be a nonnegative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be between 1 and 50");
    if (input.includeCompleted !== undefined && typeof input.includeCompleted !== "boolean") {
      throw new Error("include_completed must be a boolean");
    }
    // An interrupted hot-to-archive publication can temporarily have both
    // authenticated copies; the hot record remains canonical until committed.
    const archived = input.includeCompleted ? this.#archive.page(input.workspaceId, after, limit + 1)
      .filter(operation => !this.#operations.has(operation.operationId)) : [];
    const matching = [...this.#operations.values(), ...archived].filter(operation => operation.workspaceId === input.workspaceId
      && operation.sessionId > after && (input.includeCompleted
        || !["exited", "signaled", "spawn_failed"].includes(operation.state)))
      .sort((left, right) => left.sessionId - right.sessionId);
    const page = matching.slice(0, limit);
    return Object.freeze({ observation: "registry" as const,
      capacity: this.#capacitySnapshot(),
      processes: Object.freeze(page.map(operation => this.#statusSnapshot(operation))),
      nextAfterSessionId: matching.length > limit ? page.at(-1)!.sessionId : null });
  }

  /** Public on-demand observation and explicit cancellation share one authenticated owner exchange. */
  async inspect(workspaceId: string, operationId: string): Promise<ChatProcessStatus> {
    return this.#observeProcess(workspaceId, operationId, "status");
  }

  async #observeProcess(workspaceId: string, operationId: string, action: "status" | "cancel"): Promise<ChatProcessStatus> {
    const known = this.status(workspaceId, operationId);
    const operation = this.#operations.get(known.operationId);
    if (!operation || ["exited", "signaled", "spawn_failed"].includes(known.state)) return known;
    if (operation.executionMode !== "owned-worker-v1") {
      if (action === "cancel") throw new Error("execution has no verified owner cancellation authority; inspect its original lifecycle");
      return known;
    }
    const observed = await this.#observeOwned(operation, { action });
    const settled = this.status(workspaceId, operationId);
    // A signed terminal journal wins if the owner completed while replying.
    if (["exited", "signaled", "spawn_failed"].includes(settled.state)) return settled;
    return Object.freeze({ ...settled,
      state: observed.state, ioAvailable: observed.ioAvailable, updatedAt: observed.updatedAt,
      ...(observed.pid === undefined ? {} : { pid: observed.pid }),
      liveness: ["starting", "running"].includes(observed.state) ? "alive" as const
        : ["exited", "signaled", "spawn_failed"].includes(observed.state) ? "not_running" as const : "unknown" as const,
    });
  }

  /** Explicit workspace-owned cancellation only; update readiness never invokes it. */
  async cancel(workspaceId: string, operationId: string): Promise<ChatProcessStatus> {
    return this.#observeProcess(workspaceId, operationId, "cancel");
  }

  /** Shutdown cannot substitute for unproved process-tree cancellation. */
  assertCanClose(): void {
    for (const operation of this.#operations.values()) {
      const reconciled = this.#reconcileOwnedCompletion(operation);
      if (!["exited", "signaled", "spawn_failed"].includes(reconciled.state)) {
        throw new Error("Tela Chat still has an unresolved execution; complete it before normal shutdown");
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.assertCanClose();
    this.#closed = true;
    this.#archive.close();
  }
}
