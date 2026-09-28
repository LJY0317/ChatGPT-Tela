import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function safeRelativePath(value: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error("workspace-relative path is invalid");
  if (isAbsolute(value)) throw new Error("workspace-relative path must not be absolute");
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(part => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some(part => part === "..")) throw new Error("path escapes the workspace");
  return parts.join("/");
}

export function resolveExistingWorkspacePath(root: string, relativePath: string): string {
  const safe = safeRelativePath(relativePath);
  const candidate = resolve(root, safe);
  if (!existsSync(candidate)) throw new Error(`workspace path does not exist: ${safe}`);
  const resolved = realpathSync(candidate);
  if (!inside(root, resolved)) throw new Error("path resolves outside the workspace");
  return resolved;
}

export function resolveWritableWorkspacePath(root: string, relativePath: string): string {
  const safe = safeRelativePath(relativePath);
  const candidate = resolve(root, safe);
  const parent = dirname(candidate);
  if (!existsSync(parent)) {
    // Walk upward until an existing ancestor is found, then prove that ancestor remains in the workspace.
    let ancestor = parent;
    while (!existsSync(ancestor)) {
      const next = dirname(ancestor);
      if (next === ancestor) throw new Error("workspace path has no existing parent");
      ancestor = next;
    }
    const resolvedAncestor = realpathSync(ancestor);
    if (!inside(root, resolvedAncestor)) throw new Error("path resolves outside the workspace");
  } else {
    const resolvedParent = realpathSync(parent);
    if (!inside(root, resolvedParent)) throw new Error("path resolves outside the workspace");
  }
  if (existsSync(candidate)) {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error("refusing to modify a symlink workspace path");
    const resolved = realpathSync(candidate);
    if (!inside(root, resolved)) throw new Error("path resolves outside the workspace");
  }
  return candidate;
}

export function resolveWorkspaceDirectory(root: string, relativePath: string | undefined): string {
  if (relativePath === undefined || relativePath.trim() === "" || relativePath === ".") return root;
  const resolved = resolveExistingWorkspacePath(root, relativePath);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory()) throw new Error("working directory is not a directory");
  return resolved;
}
