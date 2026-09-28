import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative } from "node:path";
import type { ChatWorkspaceRegistry } from "./workspaces";
import { resolveWritableWorkspacePath, safeRelativePath } from "./paths";

type PatchAction = AddAction | UpdateAction | DeleteAction;

interface AddAction {
  readonly kind: "add";
  readonly path: string;
  readonly lines: readonly string[];
}

interface UpdateHunk {
  readonly lines: readonly { readonly kind: "context" | "add" | "remove"; readonly text: string }[];
}

interface UpdateAction {
  readonly kind: "update";
  readonly path: string;
  readonly moveTo?: string;
  readonly hunks: readonly UpdateHunk[];
}

interface DeleteAction {
  readonly kind: "delete";
  readonly path: string;
}

export interface ChatPatchResult {
  readonly additions: number;
  readonly removals: number;
  readonly files: readonly {
    readonly path: string;
    readonly previousPath?: string;
    readonly operation: "add" | "update" | "delete" | "move";
  }[];
}

function actionHeader(line: string): { readonly kind: "add" | "update" | "delete"; readonly path: string } | undefined {
  for (const [prefix, kind] of [
    ["*** Add File: ", "add"],
    ["*** Update File: ", "update"],
    ["*** Delete File: ", "delete"],
  ] as const) {
    if (line.startsWith(prefix)) return { kind, path: safeRelativePath(line.slice(prefix.length)) };
  }
  return undefined;
}

export function parseChatPatch(patch: string): readonly PatchAction[] {
  if (typeof patch !== "string" || patch.length > 2 * 1024 * 1024) throw new Error("patch is empty or too large");
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") throw new Error("patch is missing *** Begin Patch marker");
  let end = lines.length - 1;
  while (end > 0 && lines[end] === "") end -= 1;
  if (lines[end] !== "*** End Patch") throw new Error("patch is missing *** End Patch marker");
  const actions: PatchAction[] = [];
  let index = 1;
  while (index < end) {
    const header = actionHeader(lines[index]!);
    if (!header) throw new Error(`unexpected patch line: ${lines[index]}`);
    index += 1;
    if (header.kind === "add") {
      const content: string[] = [];
      while (index < end && !actionHeader(lines[index]!)) {
        const line = lines[index]!;
        if (!line.startsWith("+")) throw new Error(`added file lines must start with +: ${header.path}`);
        content.push(line.slice(1));
        index += 1;
      }
      if (content.length === 0) throw new Error(`added file has no content: ${header.path}`);
      actions.push(Object.freeze({ kind: "add", path: header.path, lines: Object.freeze(content) }));
      continue;
    }
    if (header.kind === "delete") {
      actions.push(Object.freeze({ kind: "delete", path: header.path }));
      continue;
    }

    let moveTo: string | undefined;
    if (lines[index]?.startsWith("*** Move to: ")) {
      moveTo = safeRelativePath(lines[index]!.slice("*** Move to: ".length));
      index += 1;
    }
    const hunks: UpdateHunk[] = [];
    while (index < end && !actionHeader(lines[index]!)) {
      if (!lines[index]!.startsWith("@@")) {
        throw new Error(`updated file hunk is missing @@ marker: ${header.path}`);
      }
      index += 1;
      const hunkLines: Array<{ kind: "context" | "add" | "remove"; text: string }> = [];
      while (index < end && !actionHeader(lines[index]!) && !lines[index]!.startsWith("@@")) {
        const line = lines[index]!;
        if (line === "*** End of File") {
          index += 1;
          break;
        }
        const prefix = line[0];
        if (prefix === " ") hunkLines.push({ kind: "context", text: line.slice(1) });
        else if (prefix === "+") hunkLines.push({ kind: "add", text: line.slice(1) });
        else if (prefix === "-") hunkLines.push({ kind: "remove", text: line.slice(1) });
        else throw new Error(`invalid patch hunk line for ${header.path}`);
        index += 1;
      }
      if (hunkLines.length === 0) throw new Error(`empty patch hunk: ${header.path}`);
      hunks.push(Object.freeze({ lines: Object.freeze(hunkLines) }));
    }
    if (hunks.length === 0 && !moveTo) throw new Error(`updated file contains no changes: ${header.path}`);
    actions.push(Object.freeze({ kind: "update", path: header.path,
      ...(moveTo ? { moveTo } : {}), hunks: Object.freeze(hunks) }));
  }
  if (actions.length === 0) throw new Error("patch contains no file actions");
  return Object.freeze(actions);
}

function splitText(content: Buffer): { readonly lines: string[]; readonly eol: string; readonly finalNewline: boolean } {
  const text = content.toString("utf8");
  if (text.includes("\u0000")) throw new Error("patch target appears to be binary");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = text.endsWith("\n");
  const normalized = text.replaceAll("\r\n", "\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function applyHunks(content: Buffer, action: UpdateAction): { readonly bytes: Buffer; readonly additions: number; readonly removals: number } {
  const original = splitText(content);
  const lines = [...original.lines];
  let cursor = 0;
  let additions = 0;
  let removals = 0;
  for (const hunk of action.hunks) {
    const expected = hunk.lines.filter(line => line.kind !== "add").map(line => line.text);
    const replacement = hunk.lines.filter(line => line.kind !== "remove").map(line => line.text);
    let found = -1;
    if (expected.length === 0) {
      found = cursor;
    } else {
      outer: for (let start = cursor; start <= lines.length - expected.length; start += 1) {
        for (let offset = 0; offset < expected.length; offset += 1) {
          if (lines[start + offset] !== expected[offset]) continue outer;
        }
        found = start;
        break;
      }
    }
    if (found < 0) throw new Error(`could not find hunk context: ${action.path}`);
    lines.splice(found, expected.length, ...replacement);
    cursor = found + replacement.length;
    additions += hunk.lines.filter(line => line.kind === "add").length;
    removals += hunk.lines.filter(line => line.kind === "remove").length;
  }
  const finalNewline = original.finalNewline || action.hunks.length > 0;
  return {
    bytes: Buffer.from(lines.join(original.eol) + (finalNewline ? original.eol : ""), "utf8"),
    additions,
    removals,
  };
}

interface Snapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly bytes?: Buffer;
  readonly mode?: number;
}

function snapshot(path: string): Snapshot {
  if (!existsSync(path)) return { path, existed: false };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("patch target must be a regular non-symlink file");
  return { path, existed: true, bytes: readFileSync(path), mode: stat.mode };
}

function atomicWrite(path: string, bytes: Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tela-${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, bytes, { mode: mode === undefined ? 0o600 : mode & 0o777 });
    if (!existsSync(path)) {
      renameSync(temporary, path);
    } else {
      try {
        // POSIX and current Node Windows builds normally replace a regular file atomically.
        renameSync(temporary, path);
      } catch (replaceError) {
        const backupPath = `${path}.tela-${randomBytes(8).toString("hex")}.bak`;
        renameSync(path, backupPath);
        try {
          renameSync(temporary, path);
          rmSync(backupPath, { force: true });
        } catch (error) {
          try {
            if (existsSync(path)) rmSync(path, { force: true });
            if (existsSync(backupPath)) renameSync(backupPath, path);
          } catch (rollbackError) {
            throw new AggregateError(
              [replaceError, error, rollbackError],
              `atomic file replacement failed and backup was preserved at ${backupPath}`,
            );
          }
          throw new AggregateError([replaceError, error], "atomic file replacement failed; original file was restored");
        }
      }
    }
    if (mode !== undefined) {
      try { chmodSync(path, mode & 0o777); } catch { /* Windows permissions differ. */ }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export class ChatPatchTool {
  constructor(readonly workspaces: ChatWorkspaceRegistry) {}

  apply(input: { readonly workspaceId: string; readonly patch: string }): ChatPatchResult {
    const workspace = this.workspaces.get(input.workspaceId);
    const actions = parseChatPatch(input.patch);
    const changes = new Map<string, { readonly bytes: Buffer | null; readonly mode?: number }>();
    const snapshots = new Map<string, Snapshot>();
    const claimedPaths = new Set<string>();
    const files: ChatPatchResult["files"][number][] = [];
    let additions = 0;
    let removals = 0;

    const remember = (path: string): Snapshot => {
      let value = snapshots.get(path);
      if (!value) {
        value = snapshot(path);
        snapshots.set(path, value);
      }
      return value;
    };

    const claim = (path: string): void => {
      if (claimedPaths.has(path)) throw new Error("patch contains multiple actions for the same workspace path");
      claimedPaths.add(path);
    };

    for (const action of actions) {
      const source = resolveWritableWorkspacePath(workspace.root, action.path);
      claim(source);
      const sourceSnapshot = remember(source);
      if (action.kind === "add") {
        const bytes = Buffer.from(`${action.lines.join("\n")}\n`, "utf8");
        changes.set(source, { bytes, ...(sourceSnapshot.mode === undefined ? {} : { mode: sourceSnapshot.mode }) });
        additions += action.lines.length;
        if (sourceSnapshot.existed && sourceSnapshot.bytes) removals += splitText(sourceSnapshot.bytes).lines.length;
        files.push({ path: action.path, operation: sourceSnapshot.existed ? "update" : "add" });
        continue;
      }
      if (!sourceSnapshot.existed || !sourceSnapshot.bytes) throw new Error(`patch target does not exist: ${action.path}`);
      if (action.kind === "delete") {
        changes.set(source, { bytes: null });
        removals += splitText(sourceSnapshot.bytes).lines.length;
        files.push({ path: action.path, operation: "delete" });
        continue;
      }
      const updated = applyHunks(sourceSnapshot.bytes, action);
      additions += updated.additions;
      removals += updated.removals;
      if (action.moveTo) {
        const destination = resolveWritableWorkspacePath(workspace.root, action.moveTo);
        claim(destination);
        remember(destination);
        if (destination === source) throw new Error("patch move destination equals source");
        changes.set(source, { bytes: null });
        changes.set(destination, { bytes: updated.bytes, ...(sourceSnapshot.mode === undefined ? {} : { mode: sourceSnapshot.mode }) });
        files.push({ path: action.moveTo, previousPath: action.path, operation: "move" });
      } else {
        changes.set(source, { bytes: updated.bytes, ...(sourceSnapshot.mode === undefined ? {} : { mode: sourceSnapshot.mode }) });
        files.push({ path: action.path, operation: "update" });
      }
    }

    const applied: string[] = [];
    try {
      for (const [path, change] of changes) {
        if (change.bytes === null) rmSync(path, { force: true });
        else atomicWrite(path, change.bytes, change.mode);
        applied.push(path);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const path of [...applied].reverse()) {
        const original = snapshots.get(path);
        if (!original) continue;
        try {
          if (!original.existed) rmSync(path, { force: true });
          else atomicWrite(path, original.bytes!, original.mode);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], "patch failed and rollback was incomplete");
      }
      throw error;
    }

    // Ensure every target still resolves under the canonical root after parent creation/renames.
    for (const [path, change] of changes) {
      if (change.bytes === null) continue;
      const rel = relative(workspace.root, path);
      resolveWritableWorkspacePath(workspace.root, rel);
    }
    return Object.freeze({ additions, removals, files: Object.freeze(files.map(file => Object.freeze(file))) });
  }
}
