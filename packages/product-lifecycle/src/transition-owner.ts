import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { prepareOwnedDirectory } from "./directory-registration";
import { readOwnershipManifest } from "./ownership";
import type { ProductPaths } from "./layout";
import { assertNoPackagedUninstall } from "./packaged-transition";

const APPLICATION_ID = 0x54454c41;

/** One OS-backed writer lock, held across the whole transition, not each JSON write.
 * A process crash releases SQLite's lock, but never authorizes replay of a journal.
 * No PID guessing, stale-age takeover, heartbeat, retry or background worker.
 */
export async function withPackagedTransitionOwner<T>(input: {
  readonly paths: ProductPaths;
  readonly installId: string;
}, action: () => Promise<T>): Promise<T> {
  assertNoPackagedUninstall(input.paths);
  const manifest = readOwnershipManifest(input.paths.installManifest);
  if (!manifest || manifest.installId !== input.installId) throw new Error("transition coordinator install ownership changed");
  const installIdHex = Buffer.from(input.installId, "utf8").toString("hex");
  const directory = join(input.paths.stateRoot, "install", "coordinator");
  const prepared = await prepareOwnedDirectory({ manifestPath: input.paths.installManifest,
    installId: manifest.installId, productVersion: manifest.productVersion,
    resource: { kind: "directory", id: "transition-coordinator", owner: "product", path: directory, dataClass: "state" } });
  if (prepared.state === "external-existing") throw new Error("transition coordinator directory is not owned");
  const path = join(directory, "writer.sqlite");
  if (!existsSync(path)) {
    const temporary = join(directory, `writer-${randomUUID()}.sqlite`);
    let created: DatabaseSync | undefined;
    try {
      created = new DatabaseSync(temporary);
      // Bun 1.4 can keep a prepared statement's SQLite handle open after
      // close() on Windows, preventing removal of the unpublished hardlink.
      // Encode the manifest-owned ID as a SQLite hex literal (never SQL text).
      created.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
        CREATE TABLE authority (install_id TEXT PRIMARY KEY);
        INSERT INTO authority VALUES (CAST(X'${installIdHex}' AS TEXT));`);
      created.close(); created = undefined;
      chmodSync(temporary, 0o600);
      // Publish without replacing an inode another coordinator may have locked.
      try { linkSync(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { created?.close(); rmSync(temporary, { force: true }); }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("transition coordinator database is unsafe");
  const database = new DatabaseSync(path);
  let locked = false;
  try {
    // Verify the on-disk owner and both file-format guards without a
    // JavaScript-owned prepared statement. Bun 1.4 on Windows can retain
    // those statements' file handles after DatabaseSync.close(), which
    // prevents a later signed uninstall from deleting this owned directory.
    // An unsatisfied CHECK fails closed; all inputs in the SQL are hex or
    // fixed constants, never interpolated manifest text.
    try {
      database.exec(`PRAGMA busy_timeout=0;
        CREATE TEMP TABLE owner_proof(v INTEGER NOT NULL CHECK(v=1));
        INSERT INTO temp.owner_proof VALUES (
          (SELECT application_id FROM pragma_application_id) = ${APPLICATION_ID}
          AND (SELECT user_version FROM pragma_user_version) = 1
          AND (SELECT install_id FROM authority LIMIT 1) = CAST(X'${installIdHex}' AS TEXT)
          AND (SELECT count(*) FROM authority) = 1
        );
        DROP TABLE temp.owner_proof;`);
    } catch {
      throw new Error("transition coordinator database ownership is invalid");
    }
    try { database.exec("BEGIN IMMEDIATE"); locked = true; }
    catch (error) { throw new Error("another installer owns this transition; do not retry or replace its lock", { cause: error }); }
    const current = lstatSync(path);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink()) throw new Error("transition coordinator database was replaced");
    assertNoPackagedUninstall(input.paths);
    return await action();
  } finally {
    if (locked) database.exec("ROLLBACK");
    database.close();
  }
}
