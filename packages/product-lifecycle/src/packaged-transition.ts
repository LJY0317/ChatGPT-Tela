import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProductPaths, TelaServiceId } from "./layout";
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
  if (existsSync(macApplicationUpdatePath(paths))) throw Error("finish the pending application update before another installation");
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
  if (existsSync(macApplicationUpdatePath(paths))) throw Error("finish the pending application update before another installation");
  if (existsSync(packagedUpgradeJournalPath(paths)) || existsSync(packagedRepairJournalPath(paths))) {
    throw new Error(`cannot start packaged ${requested} while a packaged transition journal is incomplete`);
  }
}

/** Service coordination only. Sparkle owns the app's signed bytes and replacement. */
export interface MacApplicationUpdate {
  readonly version: 1;
  readonly installId: string;
  readonly sourceVersion: string;
  readonly sourceBuild: string;
  readonly targetBuild: string;
  readonly applicationPath: string;
  readonly sourceFingerprint: string;
  readonly phase: "quiescing" | "ready" | "resuming";
  readonly runningServices: readonly TelaServiceId[];
  readonly stoppedServices: readonly TelaServiceId[];
  readonly pendingStop?: TelaServiceId | undefined;
  readonly resumeVersion?: string;
  readonly resumeFingerprint?: string;
  readonly resumedServices: readonly TelaServiceId[];
}

export function macApplicationUpdatePath(paths: ProductPaths): string {
  return join(paths.stateRoot, "install", "application-update-v1.json");
}

export function readMacApplicationUpdate(paths: ProductPaths): MacApplicationUpdate | undefined {
  const path = macApplicationUpdatePath(paths);
  if (!existsSync(path)) return undefined;
  const raw = readPackagedTransitionValue(path) as Record<string, unknown>;
  const ids = ["gateway", "chat", "codex"];
  const list = (value: unknown) => Array.isArray(value) && value.every(id => ids.includes(id)) && new Set(value).size === value.length;
  if (!raw || raw.version !== 1 || !["quiescing", "ready", "resuming"].includes(raw.phase as string)
    || !["installId", "sourceVersion", "sourceBuild", "targetBuild", "applicationPath"].every(key => typeof raw[key] === "string" && (raw[key] as string).length > 0)
    || typeof raw.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.sourceFingerprint)
    || !list(raw.runningServices) || !list(raw.stoppedServices) || !list(raw.resumedServices)
    || (raw.pendingStop !== undefined && !ids.includes(raw.pendingStop as string))
    || (raw.phase === "resuming" && (typeof raw.resumeVersion !== "string" || !raw.resumeVersion || typeof raw.resumeFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.resumeFingerprint)))) {
    throw Error("application update coordination record is invalid");
  }
  return raw as unknown as MacApplicationUpdate;
}
