import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** POSIX namespace synchronization. Windows needs a separate native adapter;
 * callers must not interpret file synchronization there as directory durability.
 */
export function synchronizeProcessDirectory(path: string): boolean {
  if (process.platform === "win32") return false;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isDirectory()) throw new Error("process state parent is not a directory");
    fsyncSync(fd);
    return true;
  } finally { closeSync(fd); }
}

/** Publish immutable evidence only after its bytes are flushed. A failed flush leaves
 * the exclusive reservation in place: uncertainty never authorizes replacement.
 * POSIX also synchronizes its parent entry. This is not a hardware power-loss guarantee.
 */
export function writeExclusiveProcessState(path: string, bytes: string | Buffer,
  synchronize: (fd: number) => void = fsyncSync): Readonly<{ dev: number; ino: number }> {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let identity: { dev: number; ino: number };
  try {
    const opened = fstatSync(fd);
    identity = { dev: opened.dev, ino: opened.ino };
    writeFileSync(fd, bytes);
    synchronize(fd);
  } finally { closeSync(fd); }
  synchronizeProcessDirectory(dirname(path));
  return identity;
}

/** Replacement is published only after temporary bytes have been synchronized.
 * One bounded pending slot prevents repeated failures from growing private state.
 * A fully synchronized temporary file that cannot be renamed is safely discarded;
 * incomplete/foreign pending evidence is never adopted or overwritten.
 */
export function replaceProcessState(path: string, bytes: string | Buffer): void {
  const temporary = `${path}.pending-v1`;
  const identity = writeExclusiveProcessState(temporary, bytes);
  try { renameSync(temporary, path); }
  catch (error) {
    const current = lstatSync(temporary);
    if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
      unlinkSync(temporary);
      synchronizeProcessDirectory(dirname(path));
    }
    throw error;
  }
  synchronizeProcessDirectory(dirname(path));
}

export function readBoundedProcessState(path: string, maximumBytes: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw new Error("process state file is unsafe or oversized");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maximumBytes || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error("process state file changed during read");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > maximumBytes) throw new Error("process state file grew beyond its limit");
    return buffer.subarray(0, size);
  } finally { closeSync(fd); }
}
