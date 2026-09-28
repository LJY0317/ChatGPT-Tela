import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatWorkspaceRegistry } from "./workspaces";
import { ChatPatchTool } from "./patch";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tela-chat-patch-"));
  const root = join(base, "project");
  const state = join(base, "state.json");
  mkdirSync(root);
  const workspaces = new ChatWorkspaceRegistry({ allowedRoots: [root], storePath: state });
  const workspace = workspaces.open(root);
  return { base, root, workspace, tool: new ChatPatchTool(workspaces) };
}

describe("Tela Chat patch tool", () => {
  test("applies add/update/delete as one workspace-scoped operation", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "alpha.txt"), "one\ntwo\nthree\n");
      writeFileSync(join(f.root, "remove.txt"), "remove\n");
      const result = f.tool.apply({
        workspaceId: f.workspace.id,
        patch: `*** Begin Patch\n*** Add File: nested/new.txt\n+hello\n*** Update File: alpha.txt\n@@\n one\n-two\n+changed\n three\n*** Delete File: remove.txt\n*** End Patch`,
      });
      expect(readFileSync(join(f.root, "alpha.txt"), "utf8")).toBe("one\nchanged\nthree\n");
      expect(readFileSync(join(f.root, "nested/new.txt"), "utf8")).toBe("hello\n");
      expect(result.files.map(file => file.operation)).toEqual(["add", "update", "delete"]);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  test("rejects lexical and symlink workspace escapes", () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "tela-chat-outside-"));
    try {
      expect(() => f.tool.apply({
        workspaceId: f.workspace.id,
        patch: `*** Begin Patch\n*** Add File: ../escape.txt\n+no\n*** End Patch`,
      })).toThrow("escapes");
      if (process.platform !== "win32") {
        symlinkSync(outside, join(f.root, "outside"), "dir");
        expect(() => f.tool.apply({
          workspaceId: f.workspace.id,
          patch: `*** Begin Patch\n*** Add File: outside/escape.txt\n+no\n*** End Patch`,
        })).toThrow("outside");
      }
    } finally {
      rmSync(f.base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("validates every hunk before mutating earlier files", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "first.txt"), "before\n");
      writeFileSync(join(f.root, "second.txt"), "actual\n");
      expect(() => f.tool.apply({
        workspaceId: f.workspace.id,
        patch: `*** Begin Patch\n*** Update File: first.txt\n@@\n-before\n+after\n*** Update File: second.txt\n@@\n-missing\n+replacement\n*** End Patch`,
      })).toThrow("could not find hunk context");
      expect(readFileSync(join(f.root, "first.txt"), "utf8")).toBe("before\n");
      expect(readFileSync(join(f.root, "second.txt"), "utf8")).toBe("actual\n");
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
});
