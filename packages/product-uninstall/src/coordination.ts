import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FilesystemOwnershipObserver, OWNERSHIP_MARKER, packagedUninstallJournalPath, readPackagedTransitionValue,
  readOwnershipManifest, readOwnershipMarker, type OwnedResource, type ProductPaths } from "@chatgpt-tela/product-lifecycle";

const COORDINATOR = "transition-coordinator";
export interface UninstallCheckpoint {
  readonly version: 1;
  readonly operationId: string;
  readonly installId: string;
  readonly ownerPid: number;
  readonly phase: "removing" | "finalizing";
}
export function readUninstallCheckpoint(paths: ProductPaths): UninstallCheckpoint | undefined {
  const path = packagedUninstallJournalPath(paths);
  if (!existsSync(path)) return;
  const value = readPackagedTransitionValue(path) as Partial<UninstallCheckpoint> | null;
  if (value?.version !== 1 || typeof value.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(value.operationId)
    || typeof value.installId !== "string" || !value.installId || value.installId.length > 512
    || !Number.isSafeInteger(value.ownerPid) || value.ownerPid! <= 0
    || !(value.phase === "removing" || value.phase === "finalizing")) throw new Error("uninstall checkpoint is invalid");
  return value as UninstallCheckpoint;
}
export function writeUninstallCheckpoint(paths: ProductPaths, value: UninstallCheckpoint): void {
  const path = packagedUninstallJournalPath(paths), temporary = `${path}.tmp-${value.operationId}`;
  try {
    writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
export function startUninstallCheckpoint(paths: ProductPaths, installId: string): UninstallCheckpoint {
  if (readUninstallCheckpoint(paths)) throw new Error("another uninstall checkpoint already exists");
  const value = { version: 1 as const, operationId: randomUUID(), installId, ownerPid: process.pid, phase: "removing" as const };
  writeUninstallCheckpoint(paths, value); return value;
}
export function clearUninstallCheckpoint(paths: ProductPaths, expected: UninstallCheckpoint): void {
  const current = readUninstallCheckpoint(paths);
  if (!current || current.operationId !== expected.operationId || current.installId !== expected.installId
    || current.phase !== expected.phase || current.ownerPid !== process.pid) throw new Error("uninstall checkpoint owner changed");
  rmSync(packagedUninstallJournalPath(paths));
}
function ownerCouldBeAlive(pid: number): boolean {
  // Signal zero is an existence/permission probe; no signal is delivered.
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error("uninstall coordinator liveness is unknown; preserve checkpoint");
  }
}
export function coordinatorResource(paths: ProductPaths): Extract<OwnedResource, { kind: "directory" }> {
  return { kind: "directory", id: COORDINATOR, owner: "product", path: join(paths.stateRoot, "install", "coordinator"), dataClass: "state" };
}

/** Only metadata remains at this point. No service, model, account or profile action. */
export async function finalizeUninstall(paths: ProductPaths, expected: UninstallCheckpoint, originalOwner = false): Promise<void> {
  const current = readUninstallCheckpoint(paths);
  if (!current || current.operationId !== expected.operationId || current.installId !== expected.installId
    || current.phase !== "finalizing") throw new Error("uninstall finalization checkpoint changed");
  if (originalOwner ? current.ownerPid !== process.pid : ownerCouldBeAlive(current.ownerPid)) {
    throw new Error("uninstall finalization owner is still active; do not take over");
  }
  const claim = `${packagedUninstallJournalPath(paths)}.finalizing`;
  // Unknown abandoned claims remain protected; no stale-age deletion/takeover.
  try { mkdirSync(claim, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("uninstall finalization is already claimed; preserve it for inspection");
    throw error;
  }
  try {
    const latest = readUninstallCheckpoint(paths);
    if (JSON.stringify(latest) !== JSON.stringify(current)) throw new Error("uninstall finalization changed during claim");
    const claimed = { ...current, ownerPid: process.pid };
    writeUninstallCheckpoint(paths, claimed);
    const manifest = readOwnershipManifest(paths.installManifest), resource = coordinatorResource(paths);
    if (manifest && (manifest.installId !== current.installId || manifest.resources.length !== 1
      || JSON.stringify(manifest.resources[0]) !== JSON.stringify(resource))) throw new Error("uninstall still owns non-coordinator resources");
    if (existsSync(resource.path)) {
      if (!lstatSync(resource.path).isDirectory() || lstatSync(resource.path).isSymbolicLink()) throw new Error("uninstall coordinator directory is unsafe");
      const marker = readOwnershipMarker(resource.path);
      if (!marker || marker.installId !== current.installId || marker.resourceId !== COORDINATOR
        || (manifest && await new FilesystemOwnershipObserver().observe(resource, manifest) !== "owned")) throw new Error("uninstall coordinator ownership drift");
      if (readdirSync(resource.path).some(name => ![OWNERSHIP_MARKER, "writer.sqlite", "writer.sqlite-journal", "writer.sqlite-wal", "writer.sqlite-shm"].includes(name))) {
        throw new Error("uninstall coordinator contains unrecognized files");
      }
      rmSync(resource.path, { recursive: true });
    }
    // The journal remains visible across database close/removal and manifest removal.
    if (manifest) rmSync(paths.installManifest);
    clearUninstallCheckpoint(paths, claimed);
  } finally { rmdirSync(claim); }
}
