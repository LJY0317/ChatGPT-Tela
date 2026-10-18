import { afterAll } from "bun:test";
import { appendFileSync, existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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
    let deferredToRunner = 0;
    for (const directory of deferred) {
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" || process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) {
          throw error;
        }
        // Bun 1.4 node:sqlite can retain prepared-statement file handles until
        // its own process exits. An independent CI step must remove the exact
        // test-owned fixture and fail the workflow if it cannot.
        appendFileSync(join(process.env.RUNNER_TEMP, "tela-test-fixtures.jsonl"),
          JSON.stringify({ tempRoot: temporaryRoot, directory }) + "\n");
        deferredToRunner++;
      }
    }
    if (deferredToRunner) console.warn("Windows SQLite fixture cleanup deferred until Bun exits:", deferredToRunner);
    deferred.clear();
  });
  return removeFixture;
}
