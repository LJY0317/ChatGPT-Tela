import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspaceInstructions } from "./workspace-instructions";

const fixtures: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "tela-instructions-"));
  fixtures.push(path);
  return path;
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("workspace instruction discovery", () => {
  test("loads global and project instructions and reflects edits and deletion on rediscovery", () => {
    const codexHome = realpathSync(directory());
    const root = realpathSync(directory());
    const nested = join(root, "src");
    mkdirSync(nested);
    writeFileSync(join(codexHome, "AGENTS.md"), "global-v1\n");
    writeFileSync(join(root, "AGENTS.md"), "project-v1\n");
    writeFileSync(join(nested, "AGENTS.md"), "nested\n");

    const first = discoverWorkspaceInstructions(realpathSync(root), { codexHome: realpathSync(codexHome) });
    expect(first.instructions).toEqual([
      { path: "~/.codex/AGENTS.md", content: "global-v1\n", source: "global", scope: "user" },
      { path: "AGENTS.md", content: "project-v1\n", source: "workspace", scope: "project" },
    ]);
    expect(first.availableInstructionFiles).toContain("src/AGENTS.md");
    expect(first.globalInstructionStatus).toBe("loaded");
    expect(first.availableInstructionFiles).not.toContain("~/.codex/AGENTS.md");

    writeFileSync(join(codexHome, "AGENTS.md"), "global-v2\n");
    unlinkSync(join(root, "AGENTS.md"));
    const second = discoverWorkspaceInstructions(realpathSync(root), { codexHome: realpathSync(codexHome) });
    expect(second.instructions).toEqual([{ path: "~/.codex/AGENTS.md", content: "global-v2\n", source: "global", scope: "user" }]);
    expect(second.globalInstructionStatus).toBe("loaded");

    unlinkSync(join(codexHome, "AGENTS.md"));
    expect(discoverWorkspaceInstructions(realpathSync(root), { codexHome: realpathSync(codexHome) })).toMatchObject({ instructions: [], globalInstructionStatus: "missing" });
  });

  test("advertises an oversized global file instead of silently omitting it", () => {
    const codexHome = realpathSync(directory());
    const root = realpathSync(directory());
    writeFileSync(join(codexHome, "AGENTS.md"), "x".repeat(128 * 1024 + 1));
    const result = discoverWorkspaceInstructions(realpathSync(root), { codexHome: realpathSync(codexHome) });
    expect(result.instructions).toEqual([]);
    expect(result.availableInstructionFiles).not.toContain("~/.codex/AGENTS.md");
    expect(result.globalInstructionStatus).toBe("oversized");
  });
});
