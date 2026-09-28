import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { safeRelativePath } from "./paths";

const MAX_REVIEW_SERIALIZED_BYTES = 10 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 50;
const MAX_REVIEWS_PER_WORKSPACE = 16;
const MAX_REVIEWS_TOTAL = 64;
const REVIEW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ChatReviewUntrackedSnapshot {
  readonly path: string;
  readonly kind: "file" | "symlink";
  readonly size: number;
  readonly sha256: string;
  readonly encoding: "utf8" | "base64" | "symlink";
  readonly content: string;
}

export interface ChatReviewRecord {
  readonly version: 1;
  readonly reviewRef: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly head?: string;
  readonly status: string;
  readonly patch: string;
  readonly untracked: readonly ChatReviewUntrackedSnapshot[];
}

export interface ChatReviewSummary {
  readonly reviewRef: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly head?: string;
  readonly patchBytes: number;
  readonly untrackedFiles: number;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\u0000")) throw new Error(`${field} is invalid`);
  return value;
}

function reviewRef(value: unknown): string {
  const parsed = text(value, "review reference");
  if (!/^chatreview_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new Error("review reference is invalid");
  }
  return parsed;
}

function parseUntracked(value: unknown, index: number): ChatReviewUntrackedSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`review untracked[${index}] is invalid`);
  const item = value as Record<string, unknown>;
  const kind = item.kind;
  const encoding = item.encoding;
  if (kind !== "file" && kind !== "symlink") throw new Error(`review untracked[${index}].kind is invalid`);
  if (!(encoding === "utf8" || encoding === "base64" || encoding === "symlink")) {
    throw new Error(`review untracked[${index}].encoding is invalid`);
  }
  if (!Number.isSafeInteger(item.size) || (item.size as number) < 0) throw new Error("review untracked size is invalid");
  const sha256 = text(item.sha256, `review untracked[${index}].sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("review untracked sha256 is invalid");
  return Object.freeze({
    path: safeRelativePath(text(item.path, `review untracked[${index}].path`)),
    kind,
    size: item.size as number,
    sha256,
    encoding,
    content: typeof item.content === "string" ? item.content : (() => { throw new Error("review untracked content is invalid"); })(),
  });
}

export function parseChatReviewRecord(value: unknown): ChatReviewRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("review record must be an object");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !Array.isArray(item.untracked)) throw new Error("review record version is invalid");
  const createdAt = text(item.createdAt, "review createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("review createdAt is invalid");
  return Object.freeze({
    version: 1,
    reviewRef: reviewRef(item.reviewRef),
    workspaceId: text(item.workspaceId, "review workspace id"),
    createdAt,
    ...(item.head === undefined ? {} : { head: text(item.head, "review head") }),
    status: typeof item.status === "string" ? item.status : (() => { throw new Error("review status is invalid"); })(),
    patch: typeof item.patch === "string" ? item.patch : (() => { throw new Error("review patch is invalid"); })(),
    untracked: Object.freeze(item.untracked.map(parseUntracked)),
  });
}

function snapshotUntracked(root: string, paths: readonly string[]): readonly ChatReviewUntrackedSnapshot[] {
  if (paths.length > MAX_UNTRACKED_FILES) throw new Error(`review checkpoint has more than ${MAX_UNTRACKED_FILES} untracked files`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const snapshots: ChatReviewUntrackedSnapshot[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const safe = safeRelativePath(path);
    const absolute = resolve(root, safe);
    if (!inside(root, absolute) || !existsSync(absolute)) throw new Error(`untracked review path is no longer available: ${safe}`);
    const realParent = realpathSync(dirname(absolute));
    if (!inside(root, realParent)) throw new Error(`untracked review path resolves outside the workspace: ${safe}`);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      const bytes = Buffer.from(target, "utf8");
      totalBytes += bytes.length;
      if (totalBytes > MAX_UNTRACKED_BYTES) throw new Error("untracked review content exceeds checkpoint byte limit");
      snapshots.push(Object.freeze({
        path: safe,
        kind: "symlink",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        encoding: "symlink",
        content: target,
      }));
      continue;
    }
    if (!stat.isFile()) throw new Error(`untracked review path is not a regular file or symlink: ${safe}`);
    const realFile = realpathSync(absolute);
    if (!inside(root, realFile)) throw new Error(`untracked review file resolves outside the workspace: ${safe}`);
    if (stat.size > MAX_UNTRACKED_FILE_BYTES) throw new Error(`untracked review file exceeds ${MAX_UNTRACKED_FILE_BYTES} bytes: ${safe}`);
    const bytes = readFileSync(absolute);
    totalBytes += bytes.length;
    if (totalBytes > MAX_UNTRACKED_BYTES) throw new Error("untracked review content exceeds checkpoint byte limit");
    let encoding: ChatReviewUntrackedSnapshot["encoding"] = "base64";
    let content = bytes.toString("base64");
    if (!bytes.includes(0)) {
      try {
        content = decoder.decode(bytes);
        encoding = "utf8";
      } catch {
        // Preserve arbitrary bytes losslessly through base64.
      }
    }
    snapshots.push(Object.freeze({
      path: safe,
      kind: "file",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      encoding,
      content,
    }));
  }
  return Object.freeze(snapshots);
}

function summary(record: ChatReviewRecord): ChatReviewSummary {
  return Object.freeze({
    reviewRef: record.reviewRef,
    workspaceId: record.workspaceId,
    createdAt: record.createdAt,
    ...(record.head ? { head: record.head } : {}),
    patchBytes: Buffer.byteLength(record.patch, "utf8"),
    untrackedFiles: record.untracked.length,
  });
}

export class ChatReviewCheckpointStore {
  readonly #root: string;

  constructor(input: { readonly root: string }) {
    this.#root = resolve(input.root);
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
  }

  #path(ref: string): string {
    return join(this.#root, `${reviewRef(ref)}.json`);
  }

  #write(record: ChatReviewRecord): void {
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_REVIEW_SERIALIZED_BYTES) {
      throw new Error(`review checkpoint exceeds ${MAX_REVIEW_SERIALIZED_BYTES} serialized bytes`);
    }
    const path = this.#path(record.reviewRef);
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
    renameSync(temporary, path);
  }

  capture(input: {
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly head?: string;
    readonly status: string;
    readonly patch: string;
    readonly untrackedPaths: readonly string[];
  }): ChatReviewRecord {
    const root = resolve(input.workspaceRoot);
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("review workspace root is unsafe or replaced");
    const record: ChatReviewRecord = Object.freeze({
      version: 1,
      reviewRef: `chatreview_${randomUUID()}`,
      workspaceId: text(input.workspaceId, "review workspace id"),
      createdAt: new Date().toISOString(),
      ...(input.head ? { head: text(input.head, "review head") } : {}),
      status: input.status,
      patch: input.patch,
      untracked: snapshotUntracked(root, input.untrackedPaths),
    });
    this.#write(record);
    this.#prune();
    return record;
  }

  read(workspaceId: string, ref: string): ChatReviewRecord {
    const path = this.#path(ref);
    if (!existsSync(path)) throw new Error(`unknown Tela Chat review reference: ${ref}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("review checkpoint file is unsafe or replaced");
    const record = parseChatReviewRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (record.workspaceId !== workspaceId) throw new Error(`unknown Tela Chat review reference for workspace ${workspaceId}: ${ref}`);
    return record;
  }

  list(workspaceId: string): readonly ChatReviewSummary[] {
    return Object.freeze(this.#records()
      .filter(record => record.workspaceId === workspaceId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(summary));
  }

  #records(): ChatReviewRecord[] {
    const records: ChatReviewRecord[] = [];
    for (const entry of readdirSync(this.#root)) {
      if (!/^chatreview_[0-9a-f-]+\.json$/i.test(entry)) continue;
      const path = join(this.#root, entry);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        records.push(parseChatReviewRecord(JSON.parse(readFileSync(path, "utf8")) as unknown));
      } catch {
        // Corrupt product-owned review state is ignored here and will age out with the enclosing state root.
      }
    }
    return records;
  }

  #prune(): void {
    const now = Date.now();
    const records = this.#records().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const remove = new Set<string>();
    for (const record of records) {
      if (now - Date.parse(record.createdAt) > REVIEW_RETENTION_MS) remove.add(record.reviewRef);
    }
    const byWorkspace = new Map<string, ChatReviewRecord[]>();
    for (const record of records.filter(record => !remove.has(record.reviewRef))) {
      const list = byWorkspace.get(record.workspaceId) ?? [];
      list.push(record);
      byWorkspace.set(record.workspaceId, list);
    }
    for (const list of byWorkspace.values()) {
      while (list.length > MAX_REVIEWS_PER_WORKSPACE) remove.add(list.shift()!.reviewRef);
    }
    const remaining = records.filter(record => !remove.has(record.reviewRef));
    while (remaining.length > MAX_REVIEWS_TOTAL) remove.add(remaining.shift()!.reviewRef);
    for (const ref of remove) rmSync(this.#path(ref), { force: true });

    // Bound ancient corrupt/unknown files too, without touching recent ambiguous state.
    for (const entry of readdirSync(this.#root)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(this.#root, entry);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (now - stat.mtimeMs > REVIEW_RETENTION_MS && !records.some(record => `${record.reviewRef}.json` === entry)) {
          rmSync(path, { force: true });
        }
      } catch { /* best-effort retention cleanup */ }
    }
  }
}
