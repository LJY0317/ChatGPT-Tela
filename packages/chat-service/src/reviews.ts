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
  readonly mode: "100644" | "100755" | "120000";
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

export interface ChatReviewChangeSummary {
  readonly files: number;
  readonly additions: number;
  readonly removals: number;
  readonly trackedFiles: number;
  readonly untrackedFiles: number;
  readonly complete: boolean;
}

export interface ChatReviewSummary {
  readonly reviewRef: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly head?: string;
  readonly patchBytes: number;
  readonly untrackedFiles: number;
  readonly changes: ChatReviewChangeSummary;
}

interface ChatReviewBaselineRecord {
  readonly workspaceId: string;
  readonly openReviewRef: string;
  readonly reviewRef: string;
  readonly updatedAt: string;
}

interface ChatReviewBaselineStore {
  readonly version: 1;
  readonly baselines: readonly ChatReviewBaselineRecord[];
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
  const mode = item.mode;
  if (kind !== "file" && kind !== "symlink") throw new Error(`review untracked[${index}].kind is invalid`);
  if (!(encoding === "utf8" || encoding === "base64" || encoding === "symlink")) {
    throw new Error(`review untracked[${index}].encoding is invalid`);
  }
  if (!(mode === undefined || mode === "100644" || mode === "100755" || mode === "120000")) {
    throw new Error(`review untracked[${index}].mode is invalid`);
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
    mode: mode ?? (kind === "symlink" ? "120000" : "100644"),
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
        mode: "120000",
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
      mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
      content,
    }));
  }
  return Object.freeze(snapshots);
}

function textLineCount(content: string): number {
  if (!content) return 0;
  const newlines = content.match(/\n/g)?.length ?? 0;
  return newlines + (content.endsWith("\n") ? 0 : 1);
}

function trackedPatchCounts(patch: string): {
  readonly files: number;
  readonly additions: number;
  readonly removals: number;
  readonly complete: boolean;
} {
  let files = 0;
  let additions = 0;
  let removals = 0;
  let complete = true;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
    else if (line === "GIT binary patch" || line.startsWith("Binary files ")) complete = false;
  }
  return Object.freeze({ files, additions, removals, complete });
}

export function summarizeChatReview(record: Pick<ChatReviewRecord, "patch" | "untracked">): ChatReviewChangeSummary {
  const tracked = trackedPatchCounts(record.patch);
  let additions = tracked.additions;
  let complete = tracked.complete;
  for (const item of record.untracked) {
    if (item.kind === "symlink") additions += 1;
    else if (item.encoding === "utf8") additions += textLineCount(item.content);
    else complete = false;
  }
  return Object.freeze({
    files: tracked.files + record.untracked.length,
    additions,
    removals: tracked.removals,
    trackedFiles: tracked.files,
    untrackedFiles: record.untracked.length,
    complete,
  });
}

export function summarizeLiveChatChanges(patch: string, untrackedFiles: number): ChatReviewChangeSummary {
  const tracked = trackedPatchCounts(patch);
  return Object.freeze({
    files: tracked.files + untrackedFiles,
    additions: tracked.additions,
    removals: tracked.removals,
    trackedFiles: tracked.files,
    untrackedFiles,
    complete: tracked.complete && untrackedFiles === 0,
  });
}

function summary(record: ChatReviewRecord): ChatReviewSummary {
  return Object.freeze({
    reviewRef: record.reviewRef,
    workspaceId: record.workspaceId,
    createdAt: record.createdAt,
    ...(record.head ? { head: record.head } : {}),
    patchBytes: Buffer.byteLength(record.patch, "utf8"),
    untrackedFiles: record.untracked.length,
    changes: summarizeChatReview(record),
  });
}

function parseBaselineStore(value: unknown): ChatReviewBaselineStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("review baseline store must be an object");
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.baselines)) throw new Error("review baseline store version is invalid");
  const seen = new Set<string>();
  const baselines = root.baselines.map((entry, index): ChatReviewBaselineRecord => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`review baseline[${index}] is invalid`);
    const item = entry as Record<string, unknown>;
    const workspaceId = text(item.workspaceId, `review baseline[${index}].workspaceId`);
    if (seen.has(workspaceId)) throw new Error(`duplicate review baseline workspace id: ${workspaceId}`);
    seen.add(workspaceId);
    const updatedAt = text(item.updatedAt, `review baseline[${index}].updatedAt`);
    if (!Number.isFinite(Date.parse(updatedAt))) throw new Error(`review baseline[${index}].updatedAt is invalid`);
    return Object.freeze({
      workspaceId,
      openReviewRef: item.openReviewRef === undefined ? reviewRef(item.reviewRef) : reviewRef(item.openReviewRef),
      reviewRef: reviewRef(item.reviewRef),
      updatedAt,
    });
  });
  return Object.freeze({ version: 1 as const, baselines: Object.freeze(baselines) });
}

export class ChatReviewCheckpointStore {
  readonly #root: string;
  readonly #baselinePath: string;

  constructor(input: { readonly root: string }) {
    this.#root = resolve(input.root);
    this.#baselinePath = join(this.#root, "baselines-v1.json");
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

  baselineRef(workspaceId: string): string | undefined {
    const parsedWorkspaceId = text(workspaceId, "review baseline workspace id");
    return this.#readBaselines().baselines.find(item => item.workspaceId === parsedWorkspaceId)?.reviewRef;
  }

  openBaselineRef(workspaceId: string): string | undefined {
    const parsedWorkspaceId = text(workspaceId, "review baseline workspace id");
    return this.#readBaselines().baselines.find(item => item.workspaceId === parsedWorkspaceId)?.openReviewRef;
  }

  setBaseline(workspaceId: string, ref: string): void {
    const parsedWorkspaceId = text(workspaceId, "review baseline workspace id");
    const parsedRef = reviewRef(ref);
    this.read(parsedWorkspaceId, parsedRef);
    const store = this.#readBaselines();
    const existing = store.baselines.find(item => item.workspaceId === parsedWorkspaceId);
    const current = store.baselines.filter(item => item.workspaceId !== parsedWorkspaceId);
    current.push(Object.freeze({
      workspaceId: parsedWorkspaceId,
      openReviewRef: existing?.openReviewRef ?? parsedRef,
      reviewRef: parsedRef,
      updatedAt: new Date().toISOString(),
    }));
    this.#writeBaselines(Object.freeze({ version: 1 as const, baselines: Object.freeze(current) }));
  }

  clearBaseline(workspaceId: string): void {
    const parsedWorkspaceId = text(workspaceId, "review baseline workspace id");
    const store = this.#readBaselines();
    const next = store.baselines.filter(item => item.workspaceId !== parsedWorkspaceId);
    if (next.length === store.baselines.length) return;
    this.#writeBaselines(Object.freeze({ version: 1 as const, baselines: Object.freeze(next) }));
  }

  #readBaselines(): ChatReviewBaselineStore {
    if (!existsSync(this.#baselinePath)) return Object.freeze({ version: 1 as const, baselines: Object.freeze([]) });
    const stat = lstatSync(this.#baselinePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("review baseline store is unsafe or replaced");
    return parseBaselineStore(JSON.parse(readFileSync(this.#baselinePath, "utf8")) as unknown);
  }

  #writeBaselines(store: ChatReviewBaselineStore): void {
    const serialized = `${JSON.stringify(store, null, 2)}\n`;
    const temporary = `${this.#baselinePath}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
    renameSync(temporary, this.#baselinePath);
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
    let protectedRefs = new Set<string>();
    try {
      protectedRefs = new Set(this.#readBaselines().baselines.flatMap(item => [item.openReviewRef, item.reviewRef]));
    } catch {
      // Corrupt baseline state cannot become retention authority.
    }
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
      while (list.filter(record => !remove.has(record.reviewRef)).length > MAX_REVIEWS_PER_WORKSPACE) {
        const candidate = list.find(record => !remove.has(record.reviewRef) && !protectedRefs.has(record.reviewRef));
        if (!candidate) break;
        remove.add(candidate.reviewRef);
      }
    }
    const remaining = records.filter(record => !remove.has(record.reviewRef));
    while (remaining.filter(record => !remove.has(record.reviewRef)).length > MAX_REVIEWS_TOTAL) {
      const candidate = remaining.find(record => !remove.has(record.reviewRef) && !protectedRefs.has(record.reviewRef));
      if (!candidate) break;
      remove.add(candidate.reviewRef);
    }
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
