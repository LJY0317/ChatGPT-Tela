import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProductPaths } from "./layout";
import { physicalFs as fs } from "./physical-fs";

/** Local transition metadata only; never expose malformed JSON excerpts. */
export function readPackagedTransitionValue(path: string): unknown {
  const limit = 16 * 1024, stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("packaged transition journal is unsafe or oversized");
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > limit || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("packaged transition journal changed during read");
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > limit) throw new Error("packaged transition journal grew beyond its limit");
    try { return JSON.parse(bytes.subarray(0, size).toString("utf8")) as unknown; }
    catch { throw new Error("packaged transition journal JSON is invalid"); }
  } finally { fs.closeSync(fd); }
}

export function packagedUpgradeJournalPath(paths: ProductPaths): string {
  return join(paths.stateRoot, "install", "packaged-upgrade-v1.json");
}

export function packagedRepairJournalPath(paths: ProductPaths): string {
  return join(paths.stateRoot, "install", "packaged-repair-v1.json");
}

export function packagedUninstallJournalPath(paths: ProductPaths): string {
  return join(paths.stateRoot, "install", "packaged-uninstall-v1.json");
}

export function assertNoPackagedUninstall(paths: ProductPaths): void {
  if (existsSync(packagedUninstallJournalPath(paths))) throw new Error("packaged uninstall is incomplete; inspect its checkpoint before another mutation");
}

export function assertNoConflictingPackagedTransition(
  paths: ProductPaths,
  requested: "upgrade" | "repair",
): void {
  assertNoPackagedUninstall(paths);
  const conflicting = requested === "upgrade" ? packagedRepairJournalPath(paths) : packagedUpgradeJournalPath(paths);
  if (existsSync(conflicting)) {
    throw new Error(`cannot start packaged ${requested} while the other packaged transition has an incomplete journal`);
  }
}

export function assertNoActivePackagedTransition(
  paths: ProductPaths,
  requested: string,
): void {
  assertNoPackagedUninstall(paths);
  if (existsSync(packagedUpgradeJournalPath(paths)) || existsSync(packagedRepairJournalPath(paths))) {
    throw new Error(`cannot start packaged ${requested} while a packaged transition journal is incomplete`);
  }
}
