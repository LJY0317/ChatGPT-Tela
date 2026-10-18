import { afterEach, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireNativeBackendOwnership } from "./native-backend-owner";
import { resolveProductPaths } from "./layout";
import { ensureOwnershipManifest } from "./ownership-store";
import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";

const roots: string[] = [];
const removeFixture = registerTemporaryFixtureCleanup();
afterEach(() => { for (const root of roots.splice(0)) removeFixture(root); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tela-backend-owner-")); roots.push(root);
  const paths = resolveProductPaths({ platform: "linux", home: root, environment: {} });
  await ensureOwnershipManifest({ path: paths.installManifest, productVersion: "fixture" });
  return { root, paths, nativeHome: join(root, "native-home") };
}

test("one Native home admits one owner across awaits, while independent homes remain usable", async () => {
  const f = await fixture(), first = (await acquireNativeBackendOwnership(f))!;
  await expect(acquireNativeBackendOwnership(f)).rejects.toThrow("Another runtime owns");
  const other = (await acquireNativeBackendOwnership({ ...f, nativeHome: join(f.root, "second") }))!;
  first.beginSpawn(); first.attachBackend(process.pid);
  first.cancelBeforeSpawn();
  await expect(acquireNativeBackendOwnership(f)).rejects.toThrow("Another runtime owns");
  first.proveBackendExit(); first.proveBackendExit(); other.cancelBeforeSpawn();
  const next = (await acquireNativeBackendOwnership(f))!; next.cancelBeforeSpawn();
});

test("symlink aliases cannot acquire separate ownership over the same Native home", async () => {
  if (process.platform === "win32") return;
  const f = await fixture();
  symlinkSync(f.root, join(f.root, "alias"));
  const first = (await acquireNativeBackendOwnership(f))!;
  try { await expect(acquireNativeBackendOwnership({ ...f, nativeHome: join(f.root, "alias", "native-home") })).rejects.toThrow("Another runtime owns"); }
  finally { first.cancelBeforeSpawn(); }
});

test("owner loss preserves live backend authority, and only proven absence allows a later start", async () => {
  const f = await fixture();
  const module = pathToFileURL(join(import.meta.dir, "native-backend-owner.ts")).href;
  const layout = pathToFileURL(join(import.meta.dir, "layout.ts")).href;
  const script = `import {acquireNativeBackendOwnership} from ${JSON.stringify(module)};
    import {resolveProductPaths} from ${JSON.stringify(layout)};
    const lease=await acquireNativeBackendOwnership({nativeHome:${JSON.stringify(f.nativeHome)},paths:resolveProductPaths({platform:'linux',home:${JSON.stringify(f.root)},environment:{}})});
    lease.beginSpawn();
    const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},100000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});
    lease.attachBackend(child.pid);console.log(child.pid);
    await Bun.stdin.stream().getReader().read();process.exit(23);`;
  const owner = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = owner.stdout.getReader(), first = await reader.read(); reader.releaseLock();
  const backendPid = Number(new TextDecoder().decode(first.value).trim());
  expect(Number.isSafeInteger(backendPid) && backendPid > 0).toBe(true);
  owner.stdin.write("exit"); owner.stdin.end(); expect(await owner.exited).toBe(23);
  try {
    await expect(acquireNativeBackendOwnership(f)).rejects.toThrow("Previous Native backend is still running");
  } finally { try { process.kill(backendPid, "SIGTERM"); } catch { /* Fixture already exited. */ } }
  const end = Date.now() + 5000;
  while (Date.now() < end) { try { process.kill(backendPid, 0); } catch { break; } await Bun.sleep(10); }
  const next = (await acquireNativeBackendOwnership(f))!; next.cancelBeforeSpawn();
});

test("an uncertain spawn is not erased just because its owner disappeared", async () => {
  const f = await fixture(), first = (await acquireNativeBackendOwnership(f))!;
  first.beginSpawn();
  const db = new DatabaseSync(join(f.paths.stateRoot, "native-backends", "owners.sqlite"));
  // A nonexistent owner models a process crash in the spawn/receipt gap.
  db.exec("UPDATE backends SET owner_pid=2147483647"); db.close();
  await expect(acquireNativeBackendOwnership(f)).rejects.toThrow("startup is uncertain");
  first.proveBackendExit();
});

test("foreign ownership evidence is preserved, never overwritten as a stale lock", async () => {
  const f = await fixture(), first = (await acquireNativeBackendOwnership(f))!; first.cancelBeforeSpawn();
  const path = join(f.paths.stateRoot, "native-backends", "owners.sqlite");
  writeFileSync(path, "foreign evidence");
  await expect(acquireNativeBackendOwnership(f)).rejects.toThrow();
  expect(readFileSync(path, "utf8")).toBe("foreign evidence");
});
