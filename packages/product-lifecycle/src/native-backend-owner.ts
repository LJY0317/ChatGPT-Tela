import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { prepareOwnedDirectory } from "./directory-registration";
import { resolveProductPaths, type ProductPaths } from "./layout";
import { readOwnershipManifest } from "./ownership";

const APPLICATION_ID = 0x544e424f;
export interface NativeBackendOwnership {
  beginSpawn(): void;
  attachBackend(pid: number): void;
  proveBackendExit(): void;
  cancelBeforeSpawn(): void;
}

function canonicalHome(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) throw Error("Native home cannot be resolved");
  return join(canonicalHome(parent), basename(path));
}
function processAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Durable admission fence, not permission to adopt, interrupt or signal an older backend. */
export async function acquireNativeBackendOwnership(input: {
  readonly nativeHome: string;
  readonly paths?: ProductPaths;
}): Promise<NativeBackendOwnership | undefined> {
  const paths = input.paths ?? resolveProductPaths();
  const manifest = readOwnershipManifest(paths.installManifest);
  // Uninstalled developer fixtures do not acquire authority over a packaged installation.
  if (!manifest) return undefined;
  const directory = join(paths.stateRoot, "native-backends");
  const prepared = await prepareOwnedDirectory({ manifestPath: paths.installManifest,
    installId: manifest.installId, productVersion: manifest.productVersion,
    resource: { kind: "directory", id: "native-backend-ownership", owner: "product", path: directory, dataClass: "state" } });
  if (prepared.state === "external-existing") throw Error("Native backend ownership directory is not owned");
  const path = join(directory, "owners.sqlite");
  if (!existsSync(path)) {
    const temporary = join(directory, `owners-${randomUUID()}.sqlite`);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(temporary);
      // Bun 1.4 on Windows can retain a prepared statement's SQLite handle
      // after close(), preventing removal of this unpublished hardlink.
      // Encode only the validated manifest ID as a hex literal, never SQL text.
      const installIdHex = Buffer.from(manifest.installId, "utf8").toString("hex");
      db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
        CREATE TABLE authority (install_id TEXT PRIMARY KEY);
        CREATE TABLE backends (scope TEXT PRIMARY KEY, nonce TEXT NOT NULL, owner_pid INTEGER NOT NULL,
          backend_pid INTEGER, phase TEXT NOT NULL);
        INSERT INTO authority VALUES (CAST(X'${installIdHex}' AS TEXT));`);
      db.close(); db = undefined; chmodSync(temporary, 0o600);
      try { linkSync(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { db?.close(); rmSync(temporary, { force: true }); }
  }
  const scope = createHash("sha256").update(canonicalHome(input.nativeHome)).digest("hex");
  const nonce = randomUUID();
  function transaction<T>(action: (db: DatabaseSync) => T): T {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error("Native backend ownership database is unsafe");
    const db = new DatabaseSync(path); let locked = false;
    try {
      db.exec("PRAGMA busy_timeout=0");
      if ((db.prepare("PRAGMA application_id").get() as any).application_id !== APPLICATION_ID
        || (db.prepare("PRAGMA user_version").get() as any).user_version !== 1
        || (db.prepare("SELECT install_id FROM authority").get() as any)?.install_id !== manifest!.installId) {
        throw Error("Native backend ownership database identity changed");
      }
      try { db.exec("BEGIN IMMEDIATE"); locked = true; }
      catch { throw Error("Another Native lifecycle operation is in progress; no new backend was started"); }
      const current = lstatSync(path);
      if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev) throw Error("Native ownership database was replaced");
      if (readOwnershipManifest(paths.installManifest)?.installId !== manifest!.installId) throw Error("Native install ownership changed");
      const value = action(db); db.exec("COMMIT"); locked = false; return value;
    } finally { if (locked) db.exec("ROLLBACK"); db.close(); }
  }
  transaction(db => {
    const previous = db.prepare("SELECT * FROM backends WHERE scope=?").get(scope) as any;
    if (previous) {
      if (!Number.isSafeInteger(previous.owner_pid) || previous.owner_pid <= 0
        || !["reserved", "spawning", "started"].includes(previous.phase)
        || (previous.backend_pid !== null && (!Number.isSafeInteger(previous.backend_pid) || previous.backend_pid <= 0))
        || (previous.phase === "started") !== (previous.backend_pid !== null)) throw Error("Native backend ownership record is invalid");
      // PID reuse and permission errors remain conservative: an apparently live PID is never adopted.
      if (!processAbsent(previous.owner_pid)) throw Error("Another runtime owns this Native home; no new backend was started");
      if (previous.phase === "spawning" && previous.backend_pid === null) throw Error("Previous Native startup is uncertain; inspect its checkpoint before recovery");
      if (previous.backend_pid !== null && !processAbsent(previous.backend_pid)) throw Error("Previous Native backend is still running; finish owned recovery before starting another");
      db.prepare("DELETE FROM backends WHERE scope=?").run(scope);
    }
    if ((db.prepare("SELECT count(*) AS count FROM backends").get() as any).count >= 64) throw Error("Native backend ownership capacity reached; inspect retained checkpoints");
    db.prepare("INSERT INTO backends VALUES (?,?,?,NULL,'reserved')").run(scope, nonce, process.pid);
  });
  let phase: "reserved" | "spawning" | "started" | "closed" = "reserved";
  function update(expected: string, next: string, pid: number | null) {
    transaction(db => {
      const changed = db.prepare("UPDATE backends SET phase=?,backend_pid=? WHERE scope=? AND nonce=? AND phase=?")
        .run(next, pid, scope, nonce, expected);
      if (Number(changed.changes) !== 1) throw Error("Native backend ownership changed");
    });
  }
  function release() {
    if (phase === "closed") return;
    transaction(db => { db.prepare("DELETE FROM backends WHERE scope=? AND nonce=?").run(scope, nonce); });
    phase = "closed";
  }
  return Object.freeze({
    beginSpawn() { if (phase !== "reserved") throw Error("Native spawn already admitted"); update("reserved", "spawning", null); phase = "spawning"; },
    attachBackend(pid: number) { if (phase !== "spawning" || !Number.isSafeInteger(pid) || pid <= 0) throw Error("Native backend process is unproven"); update("spawning", "started", pid); phase = "started"; },
    // Called only by the exact ChildProcess exit/error event, never by a timeout or quit request.
    proveBackendExit() { release(); },
    cancelBeforeSpawn() { if (phase === "reserved") release(); },
  });
}
