import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  readOwnershipManifest,
  registerOwnedResource,
  unregisterOwnedResource,
  type OwnedResource,
  type OwnershipManifest,
  type OwnershipObservation,
  type UninstallObserver,
} from "@chatgpt-tela/product-lifecycle";
import { ChatWorkspaceRegistry, type ChatWorkspace } from "./workspaces";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const WORKTREE_MARKER = "chatgpt-tela-owner-v1.json";

type WorktreeLifecycle = "provisioning" | "active" | "removing";

export interface ManagedChatWorktreeRecord {
  readonly id: string;
  readonly resourceId: string;
  readonly workspaceId: string;
  readonly sourceWorkspaceId: string;
  readonly sourceRoot: string;
  readonly path: string;
  readonly repositoryIdentity: string;
  readonly baseSha: string;
  readonly installId: string;
  readonly lifecycle: WorktreeLifecycle;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface WorktreeStore {
  readonly version: 1;
  readonly worktrees: readonly ManagedChatWorktreeRecord[];
}

interface WorktreeMarker {
  readonly version: 1;
  readonly installId: string;
  readonly worktreeId: string;
  readonly resourceId: string;
  readonly repositoryIdentity: string;
  readonly worktreePath: string;
  readonly baseSha: string;
}

export type ManagedChatWorktreeState =
  | "owned-clean"
  | "owned-missing-registration"
  | "dirty"
  | "head-drift"
  | "missing"
  | "source-missing"
  | "ownership-drift"
  | "unsafe";

export interface ManagedChatWorktreeInspection {
  readonly id: string;
  readonly resourceId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly sourceRoot: string;
  readonly state: ManagedChatWorktreeState;
  readonly removable: boolean;
  readonly detail: string;
  readonly headSha?: string;
}

export interface ManagedChatWorktreeRemoval {
  readonly id: string;
  readonly removed: boolean;
  readonly preserved: boolean;
  readonly detail: string;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function singleLine(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function sha(value: unknown, field: string): string {
  const parsed = singleLine(value, field);
  if (!/^[a-f0-9]{40,64}$/i.test(parsed)) throw new Error(`${field} is not a Git object id`);
  return parsed.toLowerCase();
}

function canonicalDirectory(path: string, field: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${field} does not exist`);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${field} must be a real directory, not a symlink`);
  return realpathSync(absolute);
}

function sameDirectory(left: string, right: string): boolean {
  const a = statSync(left, { bigint: true });
  const b = statSync(right, { bigint: true });
  return a.dev === b.dev && a.ino === b.ino;
}

function sameResolvedPath(left: string, right: string): boolean {
  const comparable = (input: string): { readonly ancestor: string; readonly suffix: readonly string[] } => {
    let current = resolve(input);
    const missingSuffix: string[] = [];
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) break;
      missingSuffix.unshift(basename(current));
      current = parent;
    }
    return Object.freeze({
      ancestor: existsSync(current) ? realpathSync(current) : current,
      suffix: Object.freeze(missingSuffix),
    });
  };
  const a = comparable(left);
  const b = comparable(right);
  if (existsSync(a.ancestor) && existsSync(b.ancestor)) {
    if (!sameDirectory(a.ancestor, b.ancestor)) return false;
  } else {
    const leftAncestor = process.platform === "win32" ? a.ancestor.toLowerCase() : a.ancestor;
    const rightAncestor = process.platform === "win32" ? b.ancestor.toLowerCase() : b.ancestor;
    if (leftAncestor !== rightAncestor) return false;
  }
  if (a.suffix.length !== b.suffix.length) return false;
  return a.suffix.every((component, index) => {
    const other = b.suffix[index]!;
    return process.platform === "win32"
      ? component.toLowerCase() === other.toLowerCase()
      : component === other;
  });
}

function parseRecord(value: unknown, index: number): ManagedChatWorktreeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`worktree[${index}] is invalid`);
  const item = value as Record<string, unknown>;
  const lifecycle = item.lifecycle;
  if (!(lifecycle === "provisioning" || lifecycle === "active" || lifecycle === "removing")) {
    throw new Error(`worktree[${index}].lifecycle is invalid`);
  }
  const path = singleLine(item.path, `worktree[${index}].path`);
  const sourceRoot = singleLine(item.sourceRoot, `worktree[${index}].sourceRoot`);
  if (!isAbsolute(path) || !isAbsolute(sourceRoot)) throw new Error(`worktree[${index}] paths must be absolute`);
  return Object.freeze({
    id: singleLine(item.id, `worktree[${index}].id`),
    resourceId: singleLine(item.resourceId, `worktree[${index}].resourceId`),
    workspaceId: singleLine(item.workspaceId, `worktree[${index}].workspaceId`),
    sourceWorkspaceId: singleLine(item.sourceWorkspaceId, `worktree[${index}].sourceWorkspaceId`),
    sourceRoot,
    path,
    repositoryIdentity: singleLine(item.repositoryIdentity, `worktree[${index}].repositoryIdentity`),
    baseSha: sha(item.baseSha, `worktree[${index}].baseSha`),
    installId: singleLine(item.installId, `worktree[${index}].installId`),
    lifecycle,
    createdAt: singleLine(item.createdAt, `worktree[${index}].createdAt`),
    updatedAt: singleLine(item.updatedAt, `worktree[${index}].updatedAt`),
  });
}

function parseStore(value: unknown): WorktreeStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tela Chat worktree store must be an object");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !Array.isArray(item.worktrees)) throw new Error("Tela Chat worktree store version is invalid");
  const worktrees = item.worktrees.map(parseRecord);
  const ids = new Set<string>();
  const resources = new Set<string>();
  for (const record of worktrees) {
    if (ids.has(record.id) || resources.has(record.resourceId)) throw new Error("Tela Chat worktree store contains duplicate identity");
    ids.add(record.id);
    resources.add(record.resourceId);
  }
  return Object.freeze({ version: 1, worktrees: Object.freeze(worktrees) });
}

function parseMarker(value: unknown): WorktreeMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tela Chat worktree ownership marker is invalid");
  const item = value as Record<string, unknown>;
  if (item.version !== 1) throw new Error("Tela Chat worktree ownership marker version is invalid");
  const worktreePath = singleLine(item.worktreePath, "worktree marker path");
  if (!isAbsolute(worktreePath)) throw new Error("worktree marker path must be absolute");
  return Object.freeze({
    version: 1,
    installId: singleLine(item.installId, "worktree marker install id"),
    worktreeId: singleLine(item.worktreeId, "worktree marker id"),
    resourceId: singleLine(item.resourceId, "worktree marker resource id"),
    repositoryIdentity: singleLine(item.repositoryIdentity, "worktree marker repository identity"),
    worktreePath,
    baseSha: sha(item.baseSha, "worktree marker base sha"),
  });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    env: { ...process.env, GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "", GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return result.stdout;
}

async function repositoryIdentity(sourceRoot: string): Promise<{ readonly identity: string; readonly commonGitDir: string }> {
  const top = canonicalDirectory((await git(sourceRoot, ["rev-parse", "--show-toplevel"])).trim(), "Git root");
  if (!sameDirectory(top, sourceRoot)) {
    throw new Error("managed worktrees require the approved workspace to be the exact Git repository root");
  }
  const rawCommon = (await git(sourceRoot, ["rev-parse", "--git-common-dir"])).trim();
  const commonGitDir = canonicalDirectory(resolve(sourceRoot, rawCommon), "Git common directory");
  const identity = createHash("sha256").update(JSON.stringify({ sourceRoot, commonGitDir })).digest("hex");
  return Object.freeze({ identity, commonGitDir });
}

async function worktreeGitDir(worktreePath: string): Promise<string> {
  const raw = (await git(worktreePath, ["rev-parse", "--git-dir"])).trim();
  return canonicalDirectory(resolve(worktreePath, raw), "managed worktree Git directory");
}

function markerPath(gitDir: string): string {
  return join(gitDir, WORKTREE_MARKER);
}

function findAdminMarker(
  commonGitDir: string,
  record: ManagedChatWorktreeRecord,
): {
  readonly registrationMatchCount: number;
  readonly matchCount: number;
  readonly expectedGitDirMatch: boolean;
} {
  const worktreesRoot = join(commonGitDir, "worktrees");
  if (!existsSync(worktreesRoot)) {
    return { registrationMatchCount: 0, matchCount: 0, expectedGitDirMatch: false };
  }
  const rootStat = lstatSync(worktreesRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Git worktree administration directory is unsafe or replaced");
  }
  let registrationMatchCount = 0;
  let matchCount = 0;
  let expectedGitDirMatch = false;
  for (const entry of readdirSync(worktreesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const adminDir = join(worktreesRoot, entry.name);
    const gitdirPath = join(adminDir, "gitdir");
    let exactRegistration = false;
    if (existsSync(gitdirPath)) {
      const gitdirStat = lstatSync(gitdirPath);
      if (gitdirStat.isFile() && !gitdirStat.isSymbolicLink()) {
        const pointed = readFileSync(gitdirPath, "utf8").trim();
        exactRegistration = sameResolvedPath(pointed, join(record.path, ".git"));
        if (exactRegistration) registrationMatchCount += 1;
      }
    }
    const ownerPath = markerPath(adminDir);
    if (!existsSync(ownerPath)) continue;
    const ownerStat = lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) continue;
    let marker: WorktreeMarker;
    try { marker = parseMarker(JSON.parse(readFileSync(ownerPath, "utf8")) as unknown); }
    catch { continue; }
    if (!sameMarker(marker, record)) continue;
    matchCount += 1;
    if (exactRegistration) expectedGitDirMatch = true;
  }
  return { registrationMatchCount, matchCount, expectedGitDirMatch };
}

function sameMarker(marker: WorktreeMarker, record: ManagedChatWorktreeRecord): boolean {
  return marker.installId === record.installId
    && marker.worktreeId === record.id
    && marker.resourceId === record.resourceId
    && marker.repositoryIdentity === record.repositoryIdentity
    && marker.worktreePath === record.path
    && marker.baseSha === record.baseSha;
}

function resourceFor(record: ManagedChatWorktreeRecord): OwnedResource {
  return Object.freeze({ kind: "managed-worktree" as const, id: record.resourceId, owner: "chat" as const,
    path: record.path, repositoryIdentity: record.repositoryIdentity });
}

export class ChatManagedWorktreeManager {
  readonly #workspaces: ChatWorkspaceRegistry | undefined;
  readonly #managedRoot: string;
  readonly #storePath: string;
  readonly #ownershipManifestPath: string;
  readonly #installId: string;
  readonly #productVersion: string;
  readonly #records = new Map<string, ManagedChatWorktreeRecord>();

  constructor(input: {
    readonly workspaces?: ChatWorkspaceRegistry;
    readonly managedRoot: string;
    readonly storePath: string;
    readonly ownershipManifestPath: string;
    readonly installId: string;
    readonly productVersion: string;
    readonly createManagedRoot?: boolean;
  }) {
    this.#workspaces = input.workspaces;
    const managedRoot = resolve(input.managedRoot);
    if (input.createManagedRoot !== false) mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
    this.#managedRoot = existsSync(managedRoot)
      ? canonicalDirectory(managedRoot, "Tela Chat managed worktree root")
      : managedRoot;
    this.#storePath = resolve(input.storePath);
    this.#ownershipManifestPath = resolve(input.ownershipManifestPath);
    this.#installId = singleLine(input.installId, "Tela install id");
    this.#productVersion = singleLine(input.productVersion, "Tela product version");
    if (existsSync(this.#storePath)) {
      const store = parseStore(JSON.parse(readFileSync(this.#storePath, "utf8")) as unknown);
      for (const record of store.worktrees) this.#records.set(record.id, record);
    }
  }

  #save(): void {
    mkdirSync(dirname(this.#storePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#storePath}.tmp-${process.pid}`;
    const store: WorktreeStore = { version: 1, worktrees: Object.freeze([...this.#records.values()]) };
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, encoding: "utf8" });
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
    renameSync(temporary, this.#storePath);
  }

  #set(record: ManagedChatWorktreeRecord): void {
    const previous = this.#records.get(record.id);
    this.#records.set(record.id, Object.freeze(record));
    try {
      this.#save();
    } catch (error) {
      if (previous) this.#records.set(record.id, previous);
      else this.#records.delete(record.id);
      throw error;
    }
  }

  #delete(id: string): void {
    const previous = this.#records.get(id);
    if (!previous) return;
    this.#records.delete(id);
    try {
      this.#save();
    } catch (error) {
      this.#records.set(id, previous);
      throw error;
    }
  }

  #record(id: string): ManagedChatWorktreeRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`unknown Tela Chat managed worktree: ${id}`);
    if (record.installId !== this.#installId) throw new Error("managed worktree belongs to a different Tela install instance");
    return record;
  }

  async #writeMarker(record: ManagedChatWorktreeRecord): Promise<void> {
    const gitDir = await worktreeGitDir(record.path);
    const path = markerPath(gitDir);
    const marker: WorktreeMarker = {
      version: 1,
      installId: record.installId,
      worktreeId: record.id,
      resourceId: record.resourceId,
      repositoryIdentity: record.repositoryIdentity,
      worktreePath: record.path,
      baseSha: record.baseSha,
    };
    writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }

  async #manifestHasExactResource(record: ManagedChatWorktreeRecord): Promise<boolean> {
    const manifest = readOwnershipManifest(this.#ownershipManifestPath);
    if (!manifest || manifest.installId !== this.#installId) return false;
    const resource = manifest.resources.find(item => item.id === record.resourceId);
    return resource !== undefined && JSON.stringify(resource) === JSON.stringify(resourceFor(record));
  }

  async create(input: { readonly sourceWorkspaceId: string; readonly baseRef?: string }): Promise<{
    readonly worktree: ManagedChatWorktreeRecord;
    readonly workspace: ChatWorkspace;
  }> {
    if (!this.#workspaces) throw new Error("managed worktree creation is unavailable in inspection-only mode");
    const source = this.#workspaces.get(input.sourceWorkspaceId);
    if (source.kind !== "user") throw new Error("managed worktrees can only be created from a user-owned source workspace");
    const repo = await repositoryIdentity(source.root);
    const baseRef = input.baseRef ?? "HEAD";
    if (typeof baseRef !== "string" || !baseRef.trim() || baseRef.length > 512 || /[\u0000\r\n]/.test(baseRef)) {
      throw new Error("managed worktree base ref is invalid");
    }
    const baseSha = sha((await git(source.root, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`])).trim(), "base commit");
    const id = `chatwt_${randomUUID()}`;
    const resourceId = `chat-managed-worktree:${id}`;
    const path = resolve(this.#managedRoot, id);
    if (!inside(this.#managedRoot, path) || existsSync(path)) throw new Error("managed worktree target path is not available");
    let workspace: ChatWorkspace | undefined;
    const now = new Date().toISOString();
    let record: ManagedChatWorktreeRecord = Object.freeze({
      id,
      resourceId,
      workspaceId: "pending",
      sourceWorkspaceId: source.id,
      sourceRoot: source.root,
      path,
      repositoryIdentity: repo.identity,
      baseSha,
      installId: this.#installId,
      lifecycle: "provisioning",
      createdAt: now,
      updatedAt: now,
    });
    this.#set(record);
    try {
      await registerOwnedResource({
        path: this.#ownershipManifestPath,
        installId: this.#installId,
        productVersion: this.#productVersion,
        resource: resourceFor(record),
      });
    } catch (error) {
      this.#delete(id);
      throw error;
    }
    try {
      await git(source.root, ["worktree", "add", "--detach", path, baseSha]);
      record = Object.freeze({ ...record, path: canonicalDirectory(path, "new managed worktree"),
        updatedAt: new Date().toISOString() });
      this.#set(record);
      await this.#writeMarker(record);
      workspace = this.#workspaces.openManaged(record.path);
      record = Object.freeze({ ...record, workspaceId: workspace.id, lifecycle: "active",
        updatedAt: new Date().toISOString() });
      this.#set(record);
      return Object.freeze({ worktree: record, workspace });
    } catch (error) {
      if (workspace) this.#workspaces.forget(workspace.id, "managed");
      if (existsSync(path)) {
        try { await git(source.root, ["worktree", "remove", "--force", path]); }
        catch (cleanupError) {
          // Keep provisioning record + manifest intent so reconciliation/uninstall can see the preserved path.
          throw new AggregateError([error, cleanupError], `managed worktree provisioning failed and ${path} was preserved`);
        }
      }
      await unregisterOwnedResource({ path: this.#ownershipManifestPath, installId: this.#installId,
        productVersion: this.#productVersion, resourceId });
      this.#delete(id);
      throw error;
    }
  }

  async inspect(id: string, options: { readonly requireManifest?: boolean } = {}): Promise<ManagedChatWorktreeInspection> {
    const record = this.#record(id);
    if (!inside(this.#managedRoot, record.path)) {
      return Object.freeze({ ...this.#inspectionBase(record), state: "unsafe", removable: false,
        detail: "recorded managed worktree path is outside the Tela-owned root" });
    }
    if (!existsSync(record.path)) return this.#inspectMissing(record, options);
    let worktreeRoot: string;
    try { worktreeRoot = canonicalDirectory(record.path, "managed worktree path"); }
    catch (error) {
      return Object.freeze({ ...this.#inspectionBase(record), state: "unsafe", removable: false,
        detail: error instanceof Error ? error.message : String(error) });
    }
    if (!sameDirectory(worktreeRoot, record.path)) {
      return Object.freeze({ ...this.#inspectionBase(record), state: "ownership-drift", removable: false,
        detail: "managed worktree canonical path changed" });
    }
    if (!existsSync(record.sourceRoot)) {
      return Object.freeze({ ...this.#inspectionBase(record), state: "source-missing", removable: false,
        detail: "source repository is missing; preserving the worktree" });
    }
    try {
      const sourceRoot = canonicalDirectory(record.sourceRoot, "source repository");
      const repo = await repositoryIdentity(sourceRoot);
      if (!sameDirectory(sourceRoot, record.sourceRoot) || repo.identity !== record.repositoryIdentity) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "ownership-drift", removable: false,
          detail: "source repository identity no longer matches Tela ownership" });
      }
      const top = canonicalDirectory((await git(record.path, ["rev-parse", "--show-toplevel"])).trim(), "managed worktree Git root");
      if (!sameDirectory(top, record.path)) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "ownership-drift", removable: false,
          detail: "managed worktree Git root no longer matches the recorded path" });
      }
      const worktreeCommonRaw = (await git(record.path, ["rev-parse", "--git-common-dir"])).trim();
      const worktreeCommon = canonicalDirectory(resolve(record.path, worktreeCommonRaw), "managed worktree common Git directory");
      if (!sameDirectory(worktreeCommon, repo.commonGitDir)) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "ownership-drift", removable: false,
          detail: "managed worktree points at a different Git repository" });
      }
      const gitDir = await worktreeGitDir(record.path);
      const ownerPath = markerPath(gitDir);
      if (!existsSync(ownerPath)) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "ownership-drift", removable: false,
          detail: "managed worktree ownership marker is missing" });
      }
      const markerStat = lstatSync(ownerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "unsafe", removable: false,
          detail: "managed worktree ownership marker is unsafe or replaced" });
      }
      const marker = parseMarker(JSON.parse(readFileSync(ownerPath, "utf8")) as unknown);
      if (!sameMarker(marker, record)) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "ownership-drift", removable: false,
          detail: "managed worktree ownership marker does not match the registry" });
      }
      const listed = await git(sourceRoot, ["worktree", "list", "--porcelain"]);
      const listedPaths = listed.split(/\r?\n/).filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
      if (!listedPaths.some(listedPath => {
        try { return sameDirectory(canonicalDirectory(listedPath, "Git worktree list entry"), record.path); }
        catch { return false; }
      })) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "ownership-drift", removable: false,
          detail: "source repository no longer registers this worktree" });
      }
      if (options.requireManifest !== false && !await this.#manifestHasExactResource(record)) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "ownership-drift", removable: false,
          detail: "installation ownership manifest no longer matches this worktree" });
      }
      const status = await git(record.path, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=no"]);
      if (status.trim()) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "dirty", removable: false,
          detail: "managed worktree contains tracked or untracked user-significant changes" });
      }
      const headSha = sha((await git(record.path, ["rev-parse", "HEAD"])).trim(), "managed worktree HEAD");
      if (headSha !== record.baseSha) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "head-drift", removable: false,
          detail: "managed worktree HEAD moved away from its creation base; preserving commits", headSha });
      }
      return Object.freeze({ ...this.#inspectionBase(record), state: "owned-clean", removable: true,
        detail: "worktree ownership, repository identity, marker, manifest, cleanliness, and base HEAD all match", headSha });
    } catch (error) {
      return Object.freeze({ ...this.#inspectionBase(record), state: "unsafe", removable: false,
        detail: error instanceof Error ? error.message : String(error) });
    }
  }

  async #inspectMissing(
    record: ManagedChatWorktreeRecord,
    options: { readonly requireManifest?: boolean },
  ): Promise<ManagedChatWorktreeInspection> {
    if (!existsSync(record.sourceRoot)) {
      return Object.freeze({ ...this.#inspectionBase(record), state: "source-missing", removable: false,
        detail: "managed worktree directory and source repository are missing; preserving ownership metadata" });
    }
    try {
      const sourceRoot = canonicalDirectory(record.sourceRoot, "source repository");
      const repo = await repositoryIdentity(sourceRoot);
      if (!sameDirectory(sourceRoot, record.sourceRoot) || repo.identity !== record.repositoryIdentity) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "ownership-drift", removable: false,
          detail: "source repository identity no longer matches Tela ownership" });
      }
      if (options.requireManifest !== false && !await this.#manifestHasExactResource(record)) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "ownership-drift", removable: false,
          detail: "installation ownership manifest no longer matches this missing worktree" });
      }
      const marker = findAdminMarker(repo.commonGitDir, record);
      if (marker.registrationMatchCount === 0) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "missing", removable: false,
          detail: "managed worktree directory and exact Git registration are already absent" });
      }
      if (marker.registrationMatchCount !== 1 || marker.matchCount !== 1 || !marker.expectedGitDirMatch) {
        return Object.freeze({ ...this.#inspectionBase(record), state: "ownership-drift", removable: false,
          detail: "missing worktree still has a Git registration but its Tela admin marker cannot be proven exact" });
      }
      return Object.freeze({ ...this.#inspectionBase(record), state: "owned-missing-registration", removable: true,
        detail: "worktree directory is missing but exact Git registration and Tela admin ownership still match" });
    } catch (error) {
      return Object.freeze({ ...this.#inspectionBase(record), state: "unsafe", removable: false,
        detail: error instanceof Error ? error.message : String(error) });
    }
  }

  #inspectionBase(record: ManagedChatWorktreeRecord) {
    return { id: record.id, resourceId: record.resourceId, workspaceId: record.workspaceId,
      path: record.path, sourceRoot: record.sourceRoot } as const;
  }

  async remove(id: string): Promise<ManagedChatWorktreeRemoval> {
    let record = this.#record(id);
    const inspection = await this.inspect(id);
    if (inspection.state !== "owned-clean" && inspection.state !== "owned-missing-registration") {
      return Object.freeze({ id, removed: false, preserved: true, detail: inspection.detail });
    }
    record = Object.freeze({ ...record, lifecycle: "removing", updatedAt: new Date().toISOString() });
    this.#set(record);
    try {
      await git(record.sourceRoot, ["worktree", "remove", "--force", record.path]);
    } catch (error) {
      this.#set(Object.freeze({ ...record, lifecycle: "active", updatedAt: new Date().toISOString() }));
      throw error;
    }
    await unregisterOwnedResource({
      path: this.#ownershipManifestPath,
      installId: this.#installId,
      productVersion: this.#productVersion,
      resourceId: record.resourceId,
    });
    if (this.#workspaces && record.workspaceId !== "pending") this.#workspaces.forget(record.workspaceId, "managed");
    this.#delete(record.id);
    return Object.freeze({ id, removed: true, preserved: false,
      detail: inspection.state === "owned-missing-registration"
        ? "missing managed worktree Git registration removed"
        : "owned clean managed worktree removed" });
  }

  async reconcile(): Promise<void> {
    for (const original of [...this.#records.values()]) {
      let record = original;
      if (!existsSync(record.path)) {
        const missing = await this.inspect(record.id, { requireManifest: false });
        if (missing.state === "missing") {
          await unregisterOwnedResource({ path: this.#ownershipManifestPath, installId: this.#installId,
            productVersion: this.#productVersion, resourceId: record.resourceId });
          if (this.#workspaces && record.workspaceId !== "pending") this.#workspaces.forget(record.workspaceId, "managed");
          this.#delete(record.id);
          continue;
        }
        if (record.lifecycle === "removing" && missing.state === "owned-missing-registration") {
          await this.remove(record.id);
          continue;
        }
      }
      if (record.lifecycle === "removing" && existsSync(record.path)) {
        record = Object.freeze({ ...record, lifecycle: "active", updatedAt: new Date().toISOString() });
        this.#set(record);
      }
      const proof = await this.inspect(record.id, { requireManifest: false });
      if (["owned-clean", "dirty", "head-drift"].includes(proof.state)) {
        if (record.workspaceId === "pending" && this.#workspaces) {
          const workspace = this.#workspaces.openManaged(record.path);
          record = Object.freeze({ ...record, workspaceId: workspace.id, updatedAt: new Date().toISOString() });
          this.#set(record);
        }
        await registerOwnedResource({ path: this.#ownershipManifestPath, installId: this.#installId,
          productVersion: this.#productVersion, resource: resourceFor(record) });
        if (record.lifecycle !== "active") {
          record = Object.freeze({ ...record, lifecycle: "active", updatedAt: new Date().toISOString() });
          this.#set(record);
        }
      }
    }
  }

  list(): readonly ManagedChatWorktreeRecord[] {
    return Object.freeze([...this.#records.values()]);
  }

  recordForResource(resourceId: string): ManagedChatWorktreeRecord | undefined {
    return [...this.#records.values()].find(record => record.resourceId === resourceId);
  }
}

export class ChatManagedWorktreeOwnershipObserver implements UninstallObserver {
  readonly #manager: ChatManagedWorktreeManager;

  constructor(manager: ChatManagedWorktreeManager) {
    this.#manager = manager;
  }

  async observe(resource: OwnedResource, manifest: OwnershipManifest): Promise<OwnershipObservation> {
    if (resource.kind !== "managed-worktree") return "unknown";
    const record = this.#manager.recordForResource(resource.id);
    if (!record) return existsSync(resource.path) ? "unknown" : "missing";
    if (record.installId !== manifest.installId
      || record.path !== resource.path
      || record.repositoryIdentity !== resource.repositoryIdentity) return "ownership-drift";
    const inspection = await this.#manager.inspect(record.id);
    if (inspection.state === "owned-clean" || inspection.state === "owned-missing-registration") return "owned";
    if (inspection.state === "dirty" || inspection.state === "head-drift") return "dirty";
    if (inspection.state === "missing") return "missing";
    if (inspection.state === "unsafe") return "unsafe";
    return "ownership-drift";
  }
}
