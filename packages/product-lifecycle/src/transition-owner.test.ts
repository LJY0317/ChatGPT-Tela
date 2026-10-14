import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureOwnershipManifest } from "./ownership-store";
import { readOwnershipManifest } from "./ownership";
import { resolveProductPaths } from "./layout";
import { withPackagedTransitionOwner } from "./transition-owner";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tela-transition-owner-")); roots.push(root);
  const paths = resolveProductPaths({ platform: "linux", home: root, environment: {} });
  const manifest = await ensureOwnershipManifest({ path: paths.installManifest, productVersion: "fixture" });
  return { paths, installId: manifest.installId };
}

test("one transition owns the install across awaits; competitors never enter or steal it", async () => {
  const input = await fixture();
  let finish!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const owner = withPackagedTransitionOwner(input, async () => { entered(); await gate; });
  await ready;
  try {
    let competitorEntered = false;
    await expect(withPackagedTransitionOwner(input, async () => { competitorEntered = true; })).rejects.toThrow("another installer owns");
    expect(competitorEntered).toBe(false);
    const other = await fixture();
    await expect(withPackagedTransitionOwner(other, async () => "independent")).resolves.toBe("independent");
  } finally { finish(); await owner; }
  await expect(withPackagedTransitionOwner(input, async () => "next")).resolves.toBe("next");
  expect(readOwnershipManifest(input.paths.installManifest)?.resources.some(row => row.id === "transition-coordinator")).toBe(true);
});

test("operation failure releases the lock without claiming success or deleting evidence", async () => {
  const input = await fixture(), checkpoint = join(input.paths.stateRoot, "install", "checkpoint.json");
  await expect(withPackagedTransitionOwner(input, async () => {
    writeFileSync(checkpoint, "pending"); throw new Error("synthetic refusal");
  })).rejects.toThrow("synthetic refusal");
  await withPackagedTransitionOwner(input, async () => { expect(readFileSync(checkpoint, "utf8")).toBe("pending"); });
});

test("an independently running coordinator exits without cleanup; next owner preserves the exact journal", async () => {
  const input = await fixture();
  await withPackagedTransitionOwner(input, async () => {});
  const checkpoint = join(input.paths.stateRoot, "install", "checkpoint.json");
  const module = pathToFileURL(join(import.meta.dir, "transition-owner.ts")).href;
  const script = `import { withPackagedTransitionOwner } from ${JSON.stringify(module)};
    import { writeFileSync } from 'node:fs'; import { resolveProductPaths } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "layout.ts")).href)};
    const paths=resolveProductPaths({platform:'linux',home:${JSON.stringify(roots.at(-1))},environment:{}});
    await withPackagedTransitionOwner({paths,installId:${JSON.stringify(input.installId)}},async()=>{
      writeFileSync(${JSON.stringify(checkpoint)},'quiescing'); console.log('ready');
      await Bun.stdin.stream().getReader().read(); process.exit(23);
    });`;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    await expect(withPackagedTransitionOwner(input, async () => {})).rejects.toThrow("another installer owns");
  } finally { child.stdin.write("exit\n"); child.stdin.end(); }
  expect(await child.exited).toBe(23);
  await withPackagedTransitionOwner(input, async () => { expect(readFileSync(checkpoint, "utf8")).toBe("quiescing"); });
});

test("an unowned database is preserved and never treated as an expired owner", async () => {
  const input = await fixture();
  await withPackagedTransitionOwner(input, async () => {});
  const database = join(input.paths.stateRoot, "install", "coordinator", "writer.sqlite");
  writeFileSync(database, "foreign evidence");
  let entered = false;
  await expect(withPackagedTransitionOwner(input, async () => { entered = true; })).rejects.toThrow();
  expect(entered).toBe(false);
  expect(readFileSync(database, "utf8")).toBe("foreign evidence");
});
