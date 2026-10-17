import { constants } from "node:fs";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { mkdir, lstat, open, unlink } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  NativeVisiblePrefixStageIdentity, NativeVisiblePrefixStageJournal, NativeVisiblePrefixStageReceipt,
  PublishedNativeWorkingCheckpoint,
} from "./native-visible-prefix-checkpoint";

const MAX_BYTES = 16 * 1024 * 1024;
// Reserve the worst JSON-escaped 32 KiB summary for EVERY pending claim.
const MAX_RECORDS = 64;
const RESERVED_ENTRY_BYTES = 32 * 1024 * 6 + 1024;
const RETENTION_MS = 28 * 24 * 60 * 60 * 1000;
const MAX_WORKING_CHECKPOINTS = 32;
const MAX_WORKING_CHECKPOINT_BYTES = 40 * 1024;
const queues = new Map<string, Promise<unknown>>();
interface Entry extends NativeVisiblePrefixStageIdentity {
  status: "pending" | "completed" | "closed";
  ownerFingerprint?: string;
  sourceRootDigest?: string;
  scopeFingerprint?: string;
  reconciliationFingerprint?: string;
  remoteOutcome?: "unknown";
  claimId: string;
  updatedAt: number;
  summary?: string;
}
interface PublishedEntry extends PublishedNativeWorkingCheckpoint {
  readonly contentHash: string;
  readonly updatedAt: number;
}
interface State { version: 1; entries: Entry[]; checkpoints?: PublishedEntry[] }
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function validPublished(input: PublishedNativeWorkingCheckpoint): boolean {
  return /^[a-f0-9]{64}$/.test(input.scopeFingerprint)
    && /^native_[a-zA-Z0-9_-]{20}$/.test(input.revisionId)
    && /^[a-f0-9]{64}$/.test(input.sourceRootDigest)
    && /^native-visible-stage-v2-[a-f0-9]{64}$/.test(input.stageKey)
    && typeof input.content === "string" && !!input.content.trim()
    && Buffer.byteLength(input.content, "utf8") <= MAX_WORKING_CHECKPOINT_BYTES
    && Number.isSafeInteger(input.estimatedTokens) && input.estimatedTokens >= 0
    && input.estimatedTokens === Math.ceil(Buffer.byteLength(input.content, "utf8") / 4);
}
function validIdentity(value: NativeVisiblePrefixStageIdentity): boolean {
  return /^native-visible-stage-(?:v2-)?[a-f0-9]{64}$/.test(value.key)
    && /^[a-f0-9]{64}$/.test(value.sourceDigest) && /^[a-f0-9]{64}$/.test(value.inputDigest);
}
function same(a: NativeVisiblePrefixStageIdentity, b: NativeVisiblePrefixStageIdentity): boolean {
  return a.key === b.key && a.sourceDigest === b.sourceDigest && a.inputDigest === b.inputDigest;
}
function summaryValid(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && Buffer.byteLength(value, "utf8") <= 32 * 1024;
}
function validate(value: unknown): State {
  const state = value as State;
  if (!state || state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > MAX_RECORDS) {
    throw new Error("Invalid Native checkpoint execution journal");
  }
  if (state.checkpoints !== undefined) {
    if (!Array.isArray(state.checkpoints) || state.checkpoints.length > MAX_WORKING_CHECKPOINTS) {
      throw Error("Invalid published Web checkpoint journal");
    }
    const keys = new Set<string>();
    for (const checkpoint of state.checkpoints) {
      const key = JSON.stringify([checkpoint.scopeFingerprint, checkpoint.revisionId]);
      if (!validPublished(checkpoint) || sha(checkpoint.content) !== checkpoint.contentHash
        || !Number.isSafeInteger(checkpoint.updatedAt) || checkpoint.updatedAt < 0
        || keys.has(key)) throw Error("Invalid published Web checkpoint");
      keys.add(key);
    }
  }
  const keys = new Set<string>();
  for (const entry of state.entries) {
    if (!entry || !validIdentity(entry) || keys.has(entry.key)
      || !/^[a-f0-9-]{36}$/.test(entry.claimId) || !Number.isSafeInteger(entry.updatedAt)
      || entry.updatedAt < 0 || !["pending", "completed", "closed"].includes(entry.status)
      || (entry.status === "completed" ? !summaryValid(entry.summary) : entry.summary !== undefined)
      || (entry.ownerFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(entry.ownerFingerprint))
      || (entry.scopeFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(entry.scopeFingerprint))
      || (entry.sourceRootDigest !== undefined && !/^[a-f0-9]{64}$/.test(entry.sourceRootDigest))
      || (entry.key.startsWith("native-visible-stage-v2-") && !entry.sourceRootDigest)
      || (entry.reconciliationFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(entry.reconciliationFingerprint))
      || (entry.remoteOutcome !== undefined && entry.remoteOutcome !== "unknown")
      || (entry.status === "closed" && !entry.ownerFingerprint)) {
      throw new Error("Invalid Native checkpoint execution journal entry");
    }
    keys.add(entry.key);
  }
  return state;
}

/** Account-scoped execution ledger, separate from disposable context caches.
 * Missing/corrupt state and abandoned locks fail closed. Pending submissions are
 * never expired or evicted; only proven completed summaries have bounded retention.
 */
export class FileNativeVisiblePrefixStageJournal implements NativeVisiblePrefixStageJournal {
  readonly directory: string;
  readonly initializationPath: string;
  constructor(input: { directory: string; initializationPath: string }) {
    this.directory = resolve(input.directory);
    this.initializationPath = resolve(input.initializationPath);
    const within = relative(this.directory, this.initializationPath);
    if (!within || !isAbsolute(within) && within !== ".." && !within.startsWith(".." + sep)) {
      throw new Error("Journal initialization receipt must be outside disposable journal storage");
    }
  }

  async #initialize(): Promise<void> {
    // The receipt is separate from browser/cache storage. Losing the whole
    // ledger after first use must never silently create a fresh execution log.
    await this.#mkdirDurable(dirname(this.initializationPath));
    const identity = createHash("sha256").update(this.directory).digest("hex");
    let firstUse = false;
    try {
      const receipt = await open(this.initializationPath, "wx", 0o600);
      firstUse = true;
      try { await receipt.writeFile(identity); await receipt.sync(); } finally { await receipt.close(); }
      await this.#syncDirectory(dirname(this.initializationPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const receipt = await open(this.initializationPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await receipt.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== 64 || await receipt.readFile("utf8") !== identity) {
        throw new Error("Native checkpoint initialization receipt is invalid");
      }
    } finally { await receipt.close(); }
    if (firstUse) {
      await this.#mkdirDurable(dirname(this.directory));
      await mkdir(this.directory, { mode: 0o700 });
      await this.#syncDirectory(dirname(this.directory));
      const handle = await open(resolve(this.directory, "state.json"), "wx", 0o600);
      try { await handle.writeFile("=" + JSON.stringify({ version: 1, entries: [] })); await handle.sync(); }
      finally { await handle.close(); }
      await this.#syncDirectory();
    }
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Native checkpoint journal directory is not owned regular storage");
  }
  async #mkdirDurable(path: string): Promise<void> {
    try { await mkdir(path, { mode: 0o700 }); await this.#syncDirectory(dirname(path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.#mkdirDurable(dirname(path));
        await mkdir(path, { mode: 0o700 }); await this.#syncDirectory(dirname(path));
      } else if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Native checkpoint journal parent is not regular storage");
  }
  async #syncDirectory(path = this.directory): Promise<void> {
    // Windows lacks directory fsync. Authoritative mutations below use one
    // pre-existing file and a flushed invalidation byte, never rename rollback.
    if (process.platform === "win32") return;
    const dir = await open(path, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async #read(): Promise<State> {
    const handle = await open(resolve(this.directory, "state.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error("Native checkpoint journal storage is invalid or oversized");
      const bytes = await handle.readFile("utf8");
      if (!bytes.startsWith("=")) throw new Error("Native checkpoint journal has an interrupted durable write");
      return validate(JSON.parse(bytes.slice(1)));
    } finally { await handle.close(); }
  }
  async #write(state: State): Promise<void> {
    const bytes = JSON.stringify(state);
    if (Buffer.byteLength(bytes, "utf8") > MAX_BYTES) throw new Error("Native checkpoint execution journal byte capacity exhausted");
    const handle = await open(resolve(this.directory, "state.json"), constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      // Flush invalidation BEFORE touching any body byte. Any interrupted body
      // update fails closed; only a fully flushed body can become readable.
      await handle.write(Buffer.from("!"), 0, 1, 0); await handle.sync();
      const body = Buffer.from(bytes, "utf8");
      let written = 0;
      while (written < body.length) {
        const result = await handle.write(body, written, body.length - written, written + 1);
        if (!result.bytesWritten) throw new Error("Native checkpoint journal write made no progress");
        written += result.bytesWritten;
      }
      await handle.truncate(body.length + 1); await handle.sync();
      await handle.write(Buffer.from("="), 0, 1, 0); await handle.sync();
    } finally { await handle.close(); }
  }
  async #transaction<T>(operation: (state: State) => Promise<T>): Promise<T> {
    const previous = queues.get(this.directory) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      await this.#initialize();
      const lockPath = resolve(this.directory, "writer.lock");
      const lock = await open(lockPath, "wx", 0o600);
      try {
        await lock.writeFile(randomUUID()); await lock.sync();
        return await operation(await this.#read());
      } finally {
        const expected = await lock.stat();
        const current = await lstat(lockPath);
        await lock.close();
        if (!current.isFile() || current.ino !== expected.ino || current.dev !== expected.dev) {
          throw new Error("Native checkpoint journal writer ownership changed");
        }
        await unlink(lockPath);
        await this.#syncDirectory();
      }
    });
    queues.set(this.directory, run);
    void run.finally(() => { if (queues.get(this.directory) === run) queues.delete(this.directory); }).catch(() => {});
    return run;
  }
  async completedReceipts(): Promise<readonly NativeVisiblePrefixStageReceipt[]> {
    return this.#transaction(async state => state.entries.filter(entry => entry.status === "completed")
      .map(entry => Object.freeze({ key: entry.key, sourceDigest: entry.sourceDigest,
        inputDigest: entry.inputDigest, status: "completed" as const, summary: entry.summary! })));
  }
  /** Source-bound, durable rolling pointers, published only after a matching model stage completed.
   * These are derived summary data, not execution claims. Old v1 journals remain readable. */
  async publishedCheckpoints(scopeFingerprint: string): Promise<readonly PublishedNativeWorkingCheckpoint[]> {
    if (!/^[a-f0-9]{64}$/.test(scopeFingerprint)) throw Error("Invalid Web checkpoint scope");
    return this.#transaction(async state => Object.freeze((state.checkpoints ?? [])
      .filter(item => item.scopeFingerprint === scopeFingerprint)
      .map(({ scopeFingerprint, revisionId, sourceRootDigest, stageKey, content, estimatedTokens }) =>
        Object.freeze({ scopeFingerprint, revisionId, sourceRootDigest, stageKey, content, estimatedTokens }))));
  }
  async publishCheckpoint(input: PublishedNativeWorkingCheckpoint): Promise<void> {
    if (!validPublished(input)) throw Error("Invalid Web checkpoint publication");
    await this.#transaction(async state => {
      // The caller's summary must be the output of the exact completed owned stage.
      // A pending/closed/foreign stage can never promote source coverage.
      const parsed = JSON.parse(input.content) as Record<string, unknown>;
      const completed = state.entries.find(item => item.key === input.stageKey
        && item.status === "completed" && item.summary === parsed.summary);
      if (!completed || parsed.completedStageKey !== input.stageKey
        || parsed.sourceDigest !== input.sourceRootDigest
        || completed.sourceRootDigest !== input.sourceRootDigest
        || parsed.type !== "tela_native_request_prefix_checkpoint_v1") {
        throw Error("Web checkpoint publication has no matching completed summary");
      }
      const checkpoints = (state.checkpoints ?? []).filter(item =>
        item.scopeFingerprint !== input.scopeFingerprint || item.revisionId !== input.revisionId);
      checkpoints.push({ ...input, contentHash: sha(input.content), updatedAt: Date.now() });
      // Do not evict the only recoverable head of an unrelated active task.
      // Discard an older alternative only where a scope retains a newer
      // checkpoint. If there are too many distinct scopes, refuse publication
      // without altering a completed receipt or the previous published heads.
      while (checkpoints.length > MAX_WORKING_CHECKPOINTS) {
        const counts = new Map<string, number>();
        for (const checkpoint of checkpoints) counts.set(checkpoint.scopeFingerprint,
          (counts.get(checkpoint.scopeFingerprint) ?? 0) + 1);
        const disposable = checkpoints.findIndex(item =>
          (counts.get(item.scopeFingerprint) ?? 0) > 1);
        if (disposable < 0) {
          throw Error("Native checkpoint journal publication capacity exhausted by distinct active scopes");
        }
        checkpoints.splice(disposable, 1);
      }
      state.checkpoints = checkpoints;
      await this.#write(state);
    });
  }
  async claim(identity: NativeVisiblePrefixStageIdentity, ownerFingerprint?: string, sourceRootDigest?: string, scopeFingerprint?: string) {
    if (!validIdentity(identity)) throw new Error("Invalid Native checkpoint stage identity");
    if (ownerFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(ownerFingerprint)) throw Error("Invalid Native checkpoint owner");
    if (scopeFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(scopeFingerprint)) throw Error("Invalid checkpoint execution scope");
    if (sourceRootDigest !== undefined && !/^[a-f0-9]{64}$/.test(sourceRootDigest)) throw Error("Invalid checkpoint source root");
    if (identity.key.startsWith("native-visible-stage-v2-") && !sourceRootDigest) throw Error("Checkpoint v2 requires source-root admission proof");
    return this.#transaction(async state => {
      const entry = state.entries.find(value => value.key === identity.key);
      if (entry && !same(entry, identity)) throw new Error("Native checkpoint stage source changed");
      if (entry?.status === "completed") return { ...identity, status: "completed" as const, summary: entry.summary! };
      if (sourceRootDigest && state.entries.some(entry => entry.status === "pending"
        && !entry.key.startsWith("native-visible-stage-v2-") && entry.sourceDigest === sourceRootDigest)) {
        return { status: "unknown" as const };
      }
      // A released Native owner stays retired even when source/policy changes the stage key.
      if (ownerFingerprint && state.entries.some(value => value.status === "closed"
        && value.ownerFingerprint === ownerFingerprint)) return { status: "unknown" as const };
      // Stable account/thread admission is independent of model, policy, source growth and nonce.
      // Older pending records without this proof cannot be presumed to belong to a foreign task.
      if (scopeFingerprint && state.entries.some(value => value.status === "pending"
        && (value.scopeFingerprint === undefined || value.scopeFingerprint === scopeFingerprint))) {
        return { status: "unknown" as const };
      }
      if (entry) {
        if (entry.status !== "closed" || !ownerFingerprint || entry.ownerFingerprint === ownerFingerprint) return { status: "unknown" as const };
        // Explicitly new Native authority may replace a locally closed, isolated
        // tool-free operation. Pending/legacy unknown records NEVER take this path.
        const claimId = randomUUID();
        Object.assign(entry, { status: "pending", claimId, ownerFingerprint, updatedAt: Date.now(), ...(sourceRootDigest ? { sourceRootDigest } : {}), ...(scopeFingerprint ? { scopeFingerprint } : {}) });
        await this.#write(state);
        return { status: "claimed" as const, claimId };
      }
      const now = Date.now();
      state.entries = state.entries.filter(value => value.status === "pending" || now - value.updatedAt <= RETENTION_MS);
      // Drop only completed receipts for capacity. Unknown submissions retain
      // their identity indefinitely within the fixed admission bound.
      while (state.entries.length >= MAX_RECORDS) {
        const oldest = state.entries.filter(value => value.status !== "pending")
          .sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (!oldest) throw new Error("Native checkpoint execution journal requires pending-stage reconciliation");
        state.entries.splice(state.entries.indexOf(oldest), 1);
      }
      const claimId = randomUUID();
      state.entries.push({ ...identity, claimId, status: "pending", updatedAt: now, ...(ownerFingerprint ? { ownerFingerprint } : {}),
        ...(sourceRootDigest ? { sourceRootDigest } : {}), ...(scopeFingerprint ? { scopeFingerprint } : {}) });
      if (state.entries.length * RESERVED_ENTRY_BYTES > MAX_BYTES) throw new Error("Native checkpoint journal cannot reserve completion capacity");
      await this.#write(state);
      return { status: "claimed" as const, claimId };
    });
  }
  async complete(input: NativeVisiblePrefixStageReceipt & { claimId: string }): Promise<void> {
    if (!validIdentity(input) || !summaryValid(input.summary)) throw new Error("Invalid Native checkpoint stage completion");
    await this.#transaction(async state => {
      const entry = state.entries.find(value => value.key === input.key);
      if (!entry || !same(entry, input) || entry.claimId !== input.claimId || entry.status !== "pending") {
        throw new Error("Native checkpoint stage completion has no matching owned claim");
      }
      entry.status = "completed"; entry.summary = input.summary; entry.updatedAt = Date.now();
      await this.#write(state);
    });
  }
  async settleClosed(input: NativeVisiblePrefixStageIdentity & { claimId: string; ownerFingerprint: string }): Promise<void> {
    if (!validIdentity(input) || !/^[a-f0-9]{64}$/.test(input.ownerFingerprint)) throw Error("Invalid checkpoint closure");
    await this.#transaction(async state => {
      const entry = state.entries.find(value => value.key === input.key);
      if (!entry || !same(entry, input) || entry.status !== "pending" || entry.claimId !== input.claimId
        || entry.ownerFingerprint !== input.ownerFingerprint) throw Error("Checkpoint closure has no matching owned claim");
      entry.status = "closed"; entry.updatedAt = Date.now();
      await this.#write(state);
    });
  }
  /** Bounded maintenance metadata only; never returns derived summary contents. */
  async pendingOperations(): Promise<readonly (NativeVisiblePrefixStageIdentity & { claimId: string; updatedAt: number; legacy: boolean; ownerFingerprint?: string })[]> {
    return this.#transaction(async state => state.entries.filter(entry => entry.status === "pending").map(entry => ({
      key: entry.key, sourceDigest: entry.sourceDigest, inputDigest: entry.inputDigest,
      claimId: entry.claimId, updatedAt: entry.updatedAt, legacy: entry.ownerFingerprint === undefined,
      ...(entry.ownerFingerprint ? { ownerFingerprint: entry.ownerFingerprint } : {}),
    })));
  }
  /** Maintenance-only settlement after the exact original physical owner was released.
   * A verified owned lifecycle cutover may prove release for an earlier generation;
   * mere inactivity, elapsed time, current readiness or a changed nonce cannot.
   * Legacy records require whole-generation quiescence because their turn owner is absent.
   * Remote outcome remains unknown; no summary or inference is manufactured. */
  async reconcileReleasedOperation(input: NativeVisiblePrefixStageIdentity & {
    claimId: string;
    expectedOwnerFingerprint: string | null;
    retiredOwnerFingerprint: string;
    reconciliationFingerprint: string;
    assertReleased: () => Promise<void>;
  }): Promise<void> {
    if (!validIdentity(input) || !/^[a-f0-9]{64}$/.test(input.retiredOwnerFingerprint)
      || !/^[a-f0-9]{64}$/.test(input.reconciliationFingerprint)
      || (input.expectedOwnerFingerprint !== null && (!/^[a-f0-9]{64}$/.test(input.expectedOwnerFingerprint)
        || input.expectedOwnerFingerprint !== input.retiredOwnerFingerprint))) {
      throw Error("Invalid checkpoint reconciliation owner identity");
    }
    await this.#transaction(async state => {
      await input.assertReleased();
      const entry = state.entries.find(value => value.key === input.key);
      if (!entry || !same(entry, input) || entry.claimId !== input.claimId) throw Error("Checkpoint reconciliation selection changed");
      if (entry.status === "closed" && entry.reconciliationFingerprint === input.reconciliationFingerprint
        && entry.ownerFingerprint === input.retiredOwnerFingerprint) return;
      if (entry.status !== "pending" || (entry.ownerFingerprint ?? null) !== input.expectedOwnerFingerprint) {
        throw Error("Checkpoint reconciliation original owner changed");
      }
      await input.assertReleased();
      entry.status = "closed";
      entry.ownerFingerprint = input.retiredOwnerFingerprint;
      entry.reconciliationFingerprint = input.reconciliationFingerprint;
      entry.remoteOutcome = "unknown";
      entry.updatedAt = Date.now();
      await this.#write(state);
      emitDiagnosticEvent("chatgpt_tela_codex", "native_checkpoint_operation_reconciled", {
        stage_fingerprint: createHash("sha256").update(entry.key).digest("hex").slice(0, 24),
        owner_kind: input.expectedOwnerFingerprint === null ? "legacy_generation" : "native_turn",
        disposition: "released_locally", remote_outcome: "unknown", model_calls: 0,
      });
    });
  }
}
