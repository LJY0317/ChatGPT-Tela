import { afterAll } from "bun:test";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

/** Windows Bun 1.4 node:sqlite may retain a DB file handle until GC. */
export function registerTemporaryFixtureCleanup() {
  const deferred = new Set<string>();
  const temporaryRoot = realpathSync(tmpdir());

  function removeFixture(directory: string): void {
    const absolute = resolve(directory);
    const filename = basename(absolute);
    if (realpathSync(dirname(absolute)) !== temporaryRoot
      || !(filename.startsWith("tela-") || filename.startsWith("chatgpt-tela-maintenance-"))
      || (existsSync(absolute) && (lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()))) {
      throw new Error("Test fixture cleanup requires its exact owned temporary directory");
    }
    if (process.platform === "win32") {
      deferred.add(absolute);
      return;
    }
    rmSync(absolute, { recursive: true, force: true });
  }

  afterAll(() => {
    if (process.platform !== "win32") return;
    Bun.gc(true);
    for (const directory of deferred) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    deferred.clear();
  });
  return removeFixture;
}
