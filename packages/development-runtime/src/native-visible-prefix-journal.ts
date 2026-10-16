import { constants } from "node:fs";
import { mkdir, lstat, open, unlink } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  NativeVisiblePrefixStageIdentity, NativeVisiblePrefixStageJournal, NativeVisiblePrefixStageReceipt,
} from "./native-visible-prefix-checkpoint";

const MAX_BYTES = 16 * 1024 * 1024;
// Reserve the worst JSON-escaped 32 KiB summary for EVERY pending claim.
const MAX_RECORDS = 64;
const RESERVED_ENTRY_BYTES = 32 * 1024 * 6 + 1024;
const RETENTION_MS = 28 * 24 * 60 * 60 * 1000;
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
interface State { version: 1; entries: Entry[] }
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
  async pendingOperations(): Promise<readonly (NativeVisiblePrefixStageIdentity & { claimId: string; updatedAt: number; legacy: boolean })[]> {
    return this.#transaction(async state => state.entries.filter(entry => entry.status === "pending").map(entry => ({
      key: entry.key, sourceDigest: entry.sourceDigest, inputDigest: entry.inputDigest,
      claimId: entry.claimId, updatedAt: entry.updatedAt, legacy: entry.ownerFingerprint === undefined,
    })));
  }
  /** Maintenance-only legacy recovery. The authenticated owner adapter must stop
   * the exact profile, prove all its Native work idle and original physical owners
   * absent. Logs/timeouts/changed nonces are NOT quiescence proof. No model is sent.
   * The original unknown remote outcome and claim remain preserved. */
  async reconcileQuiescentLegacy(input: NativeVisiblePrefixStageIdentity & {
    claimId: string;
    terminalOwnerFingerprint: string;
    reconciliationFingerprint: string;
    assertQuiescent: () => Promise<void>;
  }): Promise<void> {
    if (!validIdentity(input) || !/^[a-f0-9]{64}$/.test(input.terminalOwnerFingerprint)
      || !/^[a-f0-9]{64}$/.test(input.reconciliationFingerprint)) throw Error("Invalid checkpoint reconciliation identity");
    await this.#transaction(async state => {
      await input.assertQuiescent();
      const entry = state.entries.find(value => value.key === input.key);
      if (!entry || !same(entry, input) || entry.claimId !== input.claimId) throw Error("Checkpoint reconciliation selection changed");
      if (entry.status === "closed" && entry.reconciliationFingerprint === input.reconciliationFingerprint
        && entry.ownerFingerprint === input.terminalOwnerFingerprint) return;
      if (entry.status !== "pending" || entry.ownerFingerprint !== undefined) throw Error("Checkpoint reconciliation requires an unchanged legacy pending operation");
      // Recheck immediately before the durable mutation, under the writer lock.
      await input.assertQuiescent();
      entry.status = "closed";
      entry.ownerFingerprint = input.terminalOwnerFingerprint;
      entry.reconciliationFingerprint = input.reconciliationFingerprint;
      entry.remoteOutcome = "unknown";
      entry.updatedAt = Date.now();
      await this.#write(state);
    });
  }
}
