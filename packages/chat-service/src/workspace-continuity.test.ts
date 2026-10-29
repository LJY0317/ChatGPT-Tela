import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatWorkspaceRegistry } from "./workspaces";
import { ChatFileTools } from "./files";
import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";

const cleanup = registerTemporaryFixtureCleanup();
const macTest = process.platform === "darwin" ? test : test.skip;
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tela-workspace-continuity-"));
  const root = join(base, "project"), storePath = join(base, "workspaces.json");
  mkdirSync(root); writeFileSync(join(root, "hello.txt"), "kept context\n");
  const registry = () => new ChatWorkspaceRegistry({ allowedRoots: [base], storePath });
  const workspace = registry().open(root);
  const rewrite = (change: (row: Record<string, unknown>) => void) => {
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    change(store.workspaces[0]); writeFileSync(storePath, JSON.stringify(store));
  };
  return { base, root, storePath, registry, workspace, rewrite };
}

macTest("a changed mount device preserves workspace ID and supplies the current native helper identity", () => {
  const f = fixture();
  try {
    expect(f.workspace.volume).toBeDefined();
    f.rewrite(row => { row.device = "old-mount-device"; });
    const before = readFileSync(f.storePath, "utf8");
    const registry = f.registry(), restored = registry.get(f.workspace.id);
    expect(readFileSync(f.storePath, "utf8")).toBe(before);
    expect(restored.id).toBe(f.workspace.id);
    expect(restored.device).toBe(statSync(f.root, { bigint: true }).dev.toString());
    expect(registry.open(f.root).id).toBe(f.workspace.id);
    expect(new ChatFileTools(registry).read({ workspaceId: f.workspace.id, path: "hello.txt" }).content)
      .toContain("kept context");
    expect(f.registry().get(f.workspace.id)).toEqual(restored);
  } finally { cleanup(f.base); }
});

macTest("a different stable volume cannot inherit a workspace even with the same inode", () => {
  const f = fixture();
  try {
    f.rewrite(row => { row.volume = "00000000-0000-0000-0000-000000000000"; });
    expect(() => f.registry().get(f.workspace.id)).toThrow("was replaced");
  } finally { cleanup(f.base); }
});

test("replacing the root still rejects the old workspace", () => {
  const f = fixture();
  try {
    renameSync(f.root, f.root + "-old"); mkdirSync(f.root);
    expect(() => f.registry().get(f.workspace.id)).toThrow("was replaced");
    expect(f.registry().open(f.root).id).not.toBe(f.workspace.id);
  } finally { cleanup(f.base); }
});

macTest("legacy records gain a stable volume only while their original device/inode still match", () => {
  const f = fixture();
  try {
    f.rewrite(row => { delete row.volume; });
    expect(f.registry().open(f.root).volume).toBe(f.workspace.volume);
    expect(JSON.parse(readFileSync(f.storePath, "utf8")).workspaces[0].volume).toBe(f.workspace.volume);
    f.rewrite(row => { delete row.volume; row.device = "unproven-old-device"; });
    expect(() => f.registry().get(f.workspace.id)).toThrow("was replaced");
    expect(f.registry().open(f.root).id).not.toBe(f.workspace.id);
  } finally { cleanup(f.base); }
});
