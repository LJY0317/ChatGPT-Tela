import { DatabaseSync } from "node:sqlite";
import { closeSync, lstatSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { prepareOwnedDirectory } from "./directory-registration";
import { readOwnershipManifest } from "./ownership";
import type { ProductPaths } from "./layout";
import { assertNoPackagedUninstall, macApplicationUpdatePath, packagedUninstallJournalPath, packagedUpgradeJournalPath, readPackagedTransitionValue } from "./packaged-transition";

const APPLICATION_ID = 0x54454c41;

/** One OS-backed writer lock, held across the whole transition, not each JSON write.
 * A process crash releases SQLite's lock. Uninstall may then re-observe its
 * remaining resources under the exact removal operation, never replay a plan.
 * No PID guessing, stale-age takeover, heartbeat, retry or background worker.
 */
export async function withPackagedTransitionOwner<T>(input: {
  readonly paths: ProductPaths;
  readonly installId: string;
  readonly uninstallOperationId?: string;
}, action: () => Promise<T>): Promise<T> {
  const admit = () => {
    if (input.uninstallOperationId === undefined) return assertNoPackagedUninstall(input.paths);
    const removal = readPackagedTransitionValue(packagedUninstallJournalPath(input.paths)) as Record<string, unknown> | null;
    if (removal?.version !== 1 || removal.installId !== input.installId
      || removal.operationId !== input.uninstallOperationId || removal.phase !== "removing") {
      throw new Error("uninstall operation changed before removal could resume");
    }
  };
  admit();
  const manifest = readOwnershipManifest(input.paths.installManifest);
  if (!manifest || manifest.installId !== input.installId) throw new Error("transition coordinator install ownership changed");
  const installIdHex = Buffer.from(input.installId, "utf8").toString("hex");
  const directory = join(input.paths.stateRoot, "install", "coordinator");
  const prepared = await prepareOwnedDirectory({ manifestPath: input.paths.installManifest,
    installId: manifest.installId, productVersion: manifest.productVersion,
    resource: { kind: "directory", id: "transition-coordinator", owner: "product", path: directory, dataClass: "state" } });
  if (prepared.state === "external-existing") throw new Error("transition coordinator directory is not owned");
  const path = join(directory, "writer.sqlite");
  // Create the canonical inode exclusively. SQLite recovers interrupted initialization in place.
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("transition coordinator database is unsafe");
  const database = new DatabaseSync(path);
  let locked = false;
  const lock = () => {
    try { database.exec("BEGIN IMMEDIATE"); locked = true; }
    catch (error) { throw new Error("another installer owns this transition; do not retry or replace its lock", { cause: error }); }
  };
  const prove = (expression: string) => {
    // Avoid leaving JS-owned prepared statements open on Bun for Windows.
    database.exec(`DROP TABLE IF EXISTS temp.owner_proof;
      CREATE TEMP TABLE owner_proof(v INTEGER NOT NULL CHECK(v=1));
      INSERT INTO temp.owner_proof VALUES (${expression});
      DROP TABLE temp.owner_proof;`);
  };
  try {
    database.exec("PRAGMA busy_timeout=0");
    lock();
    const current = lstatSync(path);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink()) throw new Error("transition coordinator database was replaced");
    let uninitialized = false;
    try {
      prove(`(SELECT application_id FROM pragma_application_id) = 0
        AND (SELECT user_version FROM pragma_user_version) = 0
        AND NOT EXISTS (SELECT 1 FROM main.sqlite_master)`);
      uninitialized = true;
    } catch { /* An existing database must pass the owner check below. */ }
    if (uninitialized) {
      database.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
        CREATE TABLE authority (install_id TEXT PRIMARY KEY);
        INSERT INTO authority VALUES (CAST(X'${installIdHex}' AS TEXT));`);
      database.exec("COMMIT"); locked = false;
      // Keep the same database inode and re-acquire before admitting work.
      lock();
    }
    try {
      prove(`(SELECT application_id FROM pragma_application_id) = ${APPLICATION_ID}
        AND (SELECT user_version FROM pragma_user_version) = 1
        AND (SELECT install_id FROM authority LIMIT 1) = CAST(X'${installIdHex}' AS TEXT)
        AND (SELECT count(*) FROM authority) = 1`);
    } catch {
      throw new Error("transition coordinator database ownership is invalid");
    }
    admit();
    // Only the renamed journal commits recovery state; a dead writer may leave its scratch file.
    for (const journal of [macApplicationUpdatePath(input.paths), packagedUpgradeJournalPath(input.paths)]) {
      rmSync(journal + ".pending", { force: true });
    }
    return await action();
  } finally {
    if (locked) database.exec("ROLLBACK");
    database.close();
  }
}
