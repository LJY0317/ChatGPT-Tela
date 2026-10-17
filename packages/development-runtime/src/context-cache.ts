import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ContextCheckpoint } from "@chatgpt-tela/core";

const SCHEMA_VERSION = 1 as const;
const DEFAULT_MAX_CHECKPOINTS_PER_TASK = 8;
// Model summaries are capped at 32 KiB; the typed source/provenance envelope
// needs some room without permitting arbitrarily large cache blobs.
const MAX_CHECKPOINT_CONTENT_BYTES = 40 * 1024;
const MAX_CHECKPOINT_CACHE_FILE_BYTES = 512 * 1024;

// Serializes a single task's read/modify/rename and clear across cache
// instances in this runtime. Independent Native tasks do not block each other.
// The key uses the canonical directory and one-way task fingerprint, never
// stores the raw Native thread ID, and is released even after a failed write.
// Cross-process cache access still requires the existing single-writer owner.
const taskMutations = new Map<string, Promise<void>>();
async function withTaskMutation<T>(path: string, mutation: () => Promise<T>): Promise<T> {
  const predecessor = taskMutations.get(path);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  taskMutations.set(path, current);
  if (predecessor) await predecessor;
  try {
    return await mutation();
  } finally {
    if (taskMutations.get(path) === current) taskMutations.delete(path);
    release();
  }
}

export interface CachedContextCheckpoint {
  readonly checkpoint: ContextCheckpoint;
  readonly content: string;
  /** Account/route/effort/summary-policy proof for maintained working checkpoints. */
  readonly scopeFingerprint?: string;
}

export interface ContextCheckpointCache {
  list(nativeTaskId: string): Promise<readonly CachedContextCheckpoint[]>;
  put(input: {
    readonly nativeTaskId: string;
    readonly revisionId: string;
    readonly content: string;
    readonly estimatedTokens: number;
    readonly scopeFingerprint?: string;
  }): Promise<CachedContextCheckpoint>;
  clear(nativeTaskId: string): Promise<void>;
}

interface StoredCheckpoint {
  readonly id: string;
  readonly revisionId: string;
  readonly estimatedTokens: number;
  readonly projectionRef: string;
  readonly contentHash: string;
  readonly content: string;
  readonly scopeFingerprint?: string;
}

interface StoredTaskCache {
  readonly schemaVersion: 1;
  readonly taskFingerprint: string;
  readonly checkpoints: readonly StoredCheckpoint[];
}

function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBase64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function validId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1024 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function validTokens(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("checkpoint estimatedTokens must be a non-negative safe integer");
  }
  return value;
}

function taskFingerprint(nativeTaskId: string): string {
  return hashHex(`chatgpt-tela-context-task-v1\0${validId(nativeTaskId, "native task id")}`);
}

function checkpointIdentity(revisionId: string, content: string, estimatedTokens: number, scopeFingerprint?: string): {
  readonly id: string;
  readonly contentHash: string;
  readonly projectionRef: string;
} {
  const revision = validId(revisionId, "checkpoint revision id");
  const tokens = validTokens(estimatedTokens);
  if (scopeFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(scopeFingerprint)) {
    throw Error("Invalid checkpoint scope");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_CHECKPOINT_CONTENT_BYTES) {
    throw new Error("checkpoint content exceeds its bounded derived-cache limit");
  }
  const contentHash = hashHex(content);
  const id = `checkpoint_${hashBase64Url(
    scopeFingerprint === undefined
      ? `chatgpt-tela-checkpoint-v1\0${revision}\0${contentHash}\0${tokens}`
      : `chatgpt-tela-checkpoint-v2\0${scopeFingerprint}\0${revision}\0${contentHash}\0${tokens}`,
  ).slice(0, 28)}`;
  return {
    id,
    contentHash,
    projectionRef: `context-cache:${contentHash}`,
  };
}

function parseStoredCheckpoint(value: unknown): StoredCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string"
    || typeof item.revisionId !== "string"
    || typeof item.estimatedTokens !== "number"
    || typeof item.projectionRef !== "string"
    || typeof item.contentHash !== "string"
    || typeof item.content !== "string") return undefined;
  try {
    const identity = checkpointIdentity(item.revisionId, item.content, item.estimatedTokens,
      typeof item.scopeFingerprint === "string" ? item.scopeFingerprint : undefined);
    if (item.scopeFingerprint !== undefined && typeof item.scopeFingerprint !== "string") return undefined;
    if (identity.id !== item.id
      || identity.contentHash !== item.contentHash
      || identity.projectionRef !== item.projectionRef) return undefined;
    return Object.freeze({
      id: item.id,
      revisionId: item.revisionId,
      estimatedTokens: item.estimatedTokens,
      projectionRef: item.projectionRef,
      contentHash: item.contentHash,
      content: item.content,
      ...(item.scopeFingerprint ? { scopeFingerprint: item.scopeFingerprint } : {}),
    });
  } catch {
    return undefined;
  }
}

function toCached(value: StoredCheckpoint): CachedContextCheckpoint {
  return Object.freeze({
    checkpoint: Object.freeze({
      id: value.id,
      revisionId: value.revisionId,
      estimatedTokens: value.estimatedTokens,
      projectionRef: value.projectionRef,
    }),
    content: value.content,
    ...(value.scopeFingerprint ? { scopeFingerprint: value.scopeFingerprint } : {}),
  });
}

/** Rehydrate a journal-published derivative without depending on writable disposable cache. */
export function derivedContextCheckpoint(input: {
  readonly revisionId: string;
  readonly content: string;
  readonly estimatedTokens: number;
  readonly scopeFingerprint?: string;
}): CachedContextCheckpoint {
  const identity = checkpointIdentity(input.revisionId, input.content, input.estimatedTokens, input.scopeFingerprint);
  return toCached({
    id: identity.id,
    revisionId: input.revisionId,
    content: input.content,
    estimatedTokens: input.estimatedTokens,
    contentHash: identity.contentHash,
    projectionRef: identity.projectionRef,
    ...(input.scopeFingerprint ? { scopeFingerprint: input.scopeFingerprint } : {}),
  });
}

/**
 * Small private derived cache for Web-context checkpoints.
 *
 * Native Codex request/history remains authority. Files are addressed by a one-way task fingerprint,
 * cache corruption/missing state degrades to an empty cache, and checkpoint integrity is re-derived
 * from revision/content hashes before use. Deleting this directory can only increase transfer cost.
 */
export class FileContextCheckpointCache implements ContextCheckpointCache {
  readonly #directory: string;
  readonly #maxCheckpointsPerTask: number;

  constructor(input: {
    readonly directory: string;
    readonly maxCheckpointsPerTask?: number;
  }) {
    this.#directory = resolve(input.directory);
    this.#maxCheckpointsPerTask = input.maxCheckpointsPerTask ?? DEFAULT_MAX_CHECKPOINTS_PER_TASK;
    if (!Number.isSafeInteger(this.#maxCheckpointsPerTask) || this.#maxCheckpointsPerTask < 1) {
      throw new Error("maxCheckpointsPerTask must be a positive safe integer");
    }
  }

  async list(nativeTaskId: string): Promise<readonly CachedContextCheckpoint[]> {
    const fingerprint = taskFingerprint(nativeTaskId);
    const stored = await this.#read(fingerprint);
    return Object.freeze(stored.checkpoints.map(toCached));
  }

  async put(input: {
    readonly nativeTaskId: string;
    readonly revisionId: string;
    readonly content: string;
    readonly estimatedTokens: number;
    readonly scopeFingerprint?: string;
  }): Promise<CachedContextCheckpoint> {
    const fingerprint = taskFingerprint(input.nativeTaskId);
    validTokens(input.estimatedTokens);
    const identity = checkpointIdentity(input.revisionId, input.content, input.estimatedTokens, input.scopeFingerprint);
    const next: StoredCheckpoint = Object.freeze({
      id: identity.id,
      revisionId: validId(input.revisionId, "checkpoint revision id"),
      estimatedTokens: input.estimatedTokens,
      projectionRef: identity.projectionRef,
      contentHash: identity.contentHash,
      content: input.content,
      ...(input.scopeFingerprint ? { scopeFingerprint: input.scopeFingerprint } : {}),
    });
    return withTaskMutation(this.#path(fingerprint), async () => {
      const current = await this.#read(fingerprint);
      const deduped = current.checkpoints.filter(checkpoint => checkpoint.id !== next.id);
      const checkpoints = [...deduped, next].slice(-this.#maxCheckpointsPerTask);
      await this.#write(Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        taskFingerprint: fingerprint,
        checkpoints: Object.freeze(checkpoints),
      }));
      return toCached(next);
    });
  }

  async clear(nativeTaskId: string): Promise<void> {
    const path = this.#path(taskFingerprint(nativeTaskId));
    await withTaskMutation(path, () => rm(path, { force: true }));
  }

  #path(fingerprint: string): string {
    return join(this.#directory, `${fingerprint}.json`);
  }

  async #read(fingerprint: string): Promise<StoredTaskCache> {
    const empty = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      taskFingerprint: fingerprint,
      checkpoints: Object.freeze([]) as readonly StoredCheckpoint[],
    });
    const path = this.#path(fingerprint);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()
        || stat.size > MAX_CHECKPOINT_CACHE_FILE_BYTES) return empty;
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
      const value = parsed as Record<string, unknown>;
      if (value.schemaVersion !== SCHEMA_VERSION
        || value.taskFingerprint !== fingerprint
        || !Array.isArray(value.checkpoints)) return empty;
      const checkpoints = value.checkpoints
        .map(parseStoredCheckpoint)
        .filter((checkpoint): checkpoint is StoredCheckpoint => checkpoint !== undefined)
        .slice(-this.#maxCheckpointsPerTask);
      return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        taskFingerprint: fingerprint,
        checkpoints: Object.freeze(checkpoints),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || error instanceof SyntaxError) return empty;
      // A derived cache must never become a prerequisite for Native correctness. Unexpected read
      // failures are treated like a missing cache; future diagnostics can record the efficiency loss.
      return empty;
    }
  }

  async #write(value: StoredTaskCache): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(this.#directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("context checkpoint cache directory is not a safe real directory");
    }
    const path = this.#path(value.taskFingerprint);
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    const content = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_CHECKPOINT_CACHE_FILE_BYTES) {
      throw new Error("checkpoint cache exceeds its bounded on-disk limit");
    }
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        await rename(temporary, path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        await rm(path, { force: true });
        await rename(temporary, path);
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
