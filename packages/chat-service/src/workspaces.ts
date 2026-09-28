import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface ChatWorkspace {
  readonly id: string;
  readonly kind: "user" | "managed";
  readonly root: string;
  readonly device: string;
  readonly inode: string;
  readonly openedAt: string;
}

interface WorkspaceStore {
  readonly version: 1;
  readonly workspaces: readonly ChatWorkspace[];
}

function canonicalDirectory(path: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`workspace root must be a real directory, not a symlink: ${absolute}`);
  }
  return realpathSync(absolute);
}

function identity(path: string): { readonly device: string; readonly inode: string } {
  const stat = statSync(path, { bigint: true });
  return Object.freeze({ device: stat.dev.toString(), inode: stat.ino.toString() });
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function parseStore(value: unknown): WorkspaceStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tela Chat workspace store must be an object");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !Array.isArray(item.workspaces)) throw new Error("Tela Chat workspace store version is invalid");
  const workspaces = item.workspaces.map((entry, index): ChatWorkspace => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`workspace[${index}] is invalid`);
    const row = entry as Record<string, unknown>;
    const text = (field: string): string => {
      const value = row[field];
      if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) {
        throw new Error(`workspace[${index}].${field} is invalid`);
      }
      return value;
    };
    const root = text("root");
    if (!isAbsolute(root)) throw new Error(`workspace[${index}].root must be absolute`);
    const kind = row.kind === undefined ? "user" : row.kind;
    if (kind !== "user" && kind !== "managed") throw new Error(`workspace[${index}].kind is invalid`);
    return Object.freeze({
      id: text("id"),
      kind,
      root,
      device: text("device"),
      inode: text("inode"),
      openedAt: text("openedAt"),
    });
  });
  return Object.freeze({ version: 1, workspaces: Object.freeze(workspaces) });
}

export class ChatWorkspaceRegistry {
  readonly #allowedRoots: readonly string[];
  readonly #managedRoots: readonly string[];
  readonly #storePath: string;
  readonly #byId = new Map<string, ChatWorkspace>();

  constructor(input: {
    readonly allowedRoots: readonly string[];
    readonly managedRoots?: readonly string[];
    readonly storePath: string;
  }) {
    if (input.allowedRoots.length === 0) throw new Error("Tela Chat requires at least one locally approved workspace root");
    this.#allowedRoots = Object.freeze(input.allowedRoots.map(canonicalDirectory));
    this.#managedRoots = Object.freeze((input.managedRoots ?? []).map(root => {
      const absolute = resolve(root);
      mkdirSync(absolute, { recursive: true, mode: 0o700 });
      return canonicalDirectory(absolute);
    }));
    this.#storePath = resolve(input.storePath);
    if (existsSync(this.#storePath)) {
      const store = parseStore(JSON.parse(readFileSync(this.#storePath, "utf8")) as unknown);
      for (const workspace of store.workspaces) this.#byId.set(workspace.id, workspace);
    }
  }

  #save(): void {
    mkdirSync(dirname(this.#storePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#storePath}.tmp-${process.pid}`;
    const store: WorkspaceStore = { version: 1, workspaces: Object.freeze([...this.#byId.values()]) };
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
    renameSync(temporary, this.#storePath);
  }

  open(path: string): ChatWorkspace {
    return this.#open(path, "user");
  }

  openManaged(path: string): ChatWorkspace {
    if (this.#managedRoots.length === 0) throw new Error("Tela Chat managed workspace roots are not configured");
    return this.#open(path, "managed");
  }

  #open(path: string, kind: "user" | "managed"): ChatWorkspace {
    if (typeof path !== "string" || !path.trim() || /[\u0000\r\n]/.test(path)) throw new Error("workspace path is invalid");
    const root = canonicalDirectory(path);
    const roots = kind === "user" ? this.#allowedRoots : this.#managedRoots;
    if (!roots.some(allowed => inside(allowed, root))) {
      throw new Error(kind === "user"
        ? "workspace path is outside locally approved roots"
        : "managed workspace path is outside Tela-owned roots");
    }
    const currentIdentity = identity(root);
    for (const existing of this.#byId.values()) {
      if (existing.kind === kind && existing.root === root
        && existing.device === currentIdentity.device && existing.inode === currentIdentity.inode) {
        return this.get(existing.id);
      }
    }
    const workspace = Object.freeze({
      id: `chatws_${randomUUID()}`,
      kind,
      root,
      ...currentIdentity,
      openedAt: new Date().toISOString(),
    });
    this.#byId.set(workspace.id, workspace);
    try {
      this.#save();
    } catch (error) {
      this.#byId.delete(workspace.id);
      throw error;
    }
    return workspace;
  }

  get(id: string): ChatWorkspace {
    const workspace = this.#byId.get(id);
    if (!workspace) throw new Error(`unknown Tela Chat workspace: ${id}`);
    if (!existsSync(workspace.root)) throw new Error("workspace root is no longer available");
    const root = canonicalDirectory(workspace.root);
    if (root !== workspace.root) throw new Error("workspace root identity changed");
    const current = identity(root);
    if (current.device !== workspace.device || current.inode !== workspace.inode) {
      throw new Error("workspace root was replaced since it was opened");
    }
    const roots = workspace.kind === "user" ? this.#allowedRoots : this.#managedRoots;
    if (!roots.some(allowed => inside(allowed, root))) {
      throw new Error(workspace.kind === "user"
        ? "workspace root is no longer inside locally approved roots"
        : "managed workspace root is no longer inside Tela-owned roots");
    }
    return workspace;
  }

  list(): readonly ChatWorkspace[] {
    return Object.freeze([...this.#byId.values()].map(workspace => this.get(workspace.id)));
  }

  forget(id: string, expectedKind?: "user" | "managed"): void {
    const workspace = this.#byId.get(id);
    if (!workspace) return;
    if (expectedKind && workspace.kind !== expectedKind) {
      throw new Error(`refusing to forget a ${workspace.kind} workspace through ${expectedKind} cleanup`);
    }
    this.#byId.delete(id);
    try {
      this.#save();
    } catch (error) {
      this.#byId.set(id, workspace);
      throw error;
    }
  }
}

export function isPathInside(root: string, candidate: string): boolean {
  return inside(root, candidate);
}
