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

export interface CachedContextCheckpoint {
  readonly checkpoint: ContextCheckpoint;
  readonly content: string;
}

export interface ContextCheckpointCache {
  list(nativeTaskId: string): Promise<readonly CachedContextCheckpoint[]>;
  put(input: {
    readonly nativeTaskId: string;
    readonly revisionId: string;
    readonly content: string;
    readonly estimatedTokens: number;
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

function checkpointIdentity(revisionId: string, content: string, estimatedTokens: number): {
  readonly id: string;
  readonly contentHash: string;
  readonly projectionRef: string;
} {
  const revision = validId(revisionId, "checkpoint revision id");
  const tokens = validTokens(estimatedTokens);
  const contentHash = hashHex(content);
  const id = `checkpoint_${hashBase64Url(
    `chatgpt-tela-checkpoint-v1\0${revision}\0${contentHash}\0${tokens}`,
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
    const identity = checkpointIdentity(item.revisionId, item.content, item.estimatedTokens);
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
  }): Promise<CachedContextCheckpoint> {
    const fingerprint = taskFingerprint(input.nativeTaskId);
    validTokens(input.estimatedTokens);
    const identity = checkpointIdentity(input.revisionId, input.content, input.estimatedTokens);
    const next: StoredCheckpoint = Object.freeze({
      id: identity.id,
      revisionId: validId(input.revisionId, "checkpoint revision id"),
      estimatedTokens: input.estimatedTokens,
      projectionRef: identity.projectionRef,
      contentHash: identity.contentHash,
      content: input.content,
    });
    const current = await this.#read(fingerprint);
    const deduped = current.checkpoints.filter(checkpoint => checkpoint.id !== next.id);
    const checkpoints = [...deduped, next].slice(-this.#maxCheckpointsPerTask);
    await this.#write(Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      taskFingerprint: fingerprint,
      checkpoints: Object.freeze(checkpoints),
    }));
    return toCached(next);
  }

  async clear(nativeTaskId: string): Promise<void> {
    const path = this.#path(taskFingerprint(nativeTaskId));
    await rm(path, { force: true });
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
      if (!stat.isFile() || stat.isSymbolicLink()) return empty;
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
