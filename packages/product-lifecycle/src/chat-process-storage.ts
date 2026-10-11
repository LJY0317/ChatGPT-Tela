import { join } from "node:path";
import { physicalFs as fs } from "./physical-fs";
import type { ProductPaths } from "./layout";

/** Storage compatibility is a narrow lifecycle contract, not execution authority. */
export interface ChatProcessStoreCompatibility {
  readonly readVersions: readonly number[];
  readonly writeVersion: number;
}

// Keep the installed pathname stable. The JSON header owns format versioning.
export const CHAT_PROCESS_STORE_FILENAME = "process-operations-v1.json";
export const CURRENT_CHAT_PROCESS_STORE_COMPATIBILITY = Object.freeze({
  readVersions: Object.freeze([1, 2] as const), writeVersion: 2 as const,
});

export function parseChatProcessStoreCompatibility(value: unknown): ChatProcessStoreCompatibility {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Chat process storage compatibility is invalid");
  const item = value as Record<string, unknown>;
  const validVersion = (version: unknown): version is number => Number.isSafeInteger(version) && (version as number) > 0 && (version as number) <= 65535;
  if (Object.keys(item).some(key => !["readVersions", "writeVersion"].includes(key))
    || !Array.isArray(item.readVersions) || item.readVersions.length === 0 || item.readVersions.length > 16
    || !item.readVersions.every(validVersion) || new Set(item.readVersions).size !== item.readVersions.length
    || !validVersion(item.writeVersion) || !item.readVersions.includes(item.writeVersion)) {
    throw new Error("Chat process storage compatibility is invalid");
  }
  return Object.freeze({ readVersions: Object.freeze([...item.readVersions]), writeVersion: item.writeVersion });
}

function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

/** On explicit lifecycle/Chat launch only. Never scans, writes, or logs state contents. */
export function assertChatProcessStoreCompatible(paths: ProductPaths, target?: ChatProcessStoreCompatibility): void {
  const compatibility = target === undefined ? { readVersions: [1], writeVersion: 1 } : parseChatProcessStoreCompatibility(target);
  const parents = [paths.stateRoot, join(paths.stateRoot, "services"), paths.serviceState("chat")];
  const identities: { dev: number; ino: number }[] = [];
  for (const parent of parents) {
    let stat: ReturnType<typeof fs.lstatSync>;
    try { stat = fs.lstatSync(parent); } catch (error) { if (absent(error)) return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Chat process state directory is unsafe");
    identities.push({ dev: stat.dev, ino: stat.ino });
  }
  const path = join(paths.serviceState("chat"), CHAT_PROCESS_STORE_FILENAME), limit = 1024 * 1024;
  let before: ReturnType<typeof fs.lstatSync>;
  try { before = fs.lstatSync(path); } catch (error) { if (absent(error)) return; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error("Chat process state is unsafe or oversized");
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > limit || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Chat process state changed during compatibility check");
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > limit) throw new Error("Chat process state grew beyond its limit");
    for (let index = 0; index < parents.length; index++) {
      const current = fs.lstatSync(parents[index]!);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identities[index]!.dev
        || current.ino !== identities[index]!.ino) throw new Error("Chat process state directory changed during compatibility check");
    }
    const after = fs.fstatSync(fd), currentFile = fs.lstatSync(path);
    if (!currentFile.isFile() || currentFile.isSymbolicLink() || currentFile.dev !== opened.dev || currentFile.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("Chat process state changed during compatibility check");
    let value: unknown;
    try { value = JSON.parse(bytes.subarray(0, size).toString("utf8")) as unknown; }
    catch { throw new Error("Chat process state JSON is invalid; preserve the existing records"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Chat process state header is invalid");
    const version = (value as Record<string, unknown>).version;
    if (!Number.isSafeInteger(version) || !compatibility.readVersions.includes(version as number)) {
      throw new Error("target package cannot read the existing Chat process state; keep the compatible package");
    }
    if (compatibility.writeVersion < (version as number)) throw new Error("target package would downgrade the existing Chat process state; keep the compatible package");
  } finally { fs.closeSync(fd); }
}
