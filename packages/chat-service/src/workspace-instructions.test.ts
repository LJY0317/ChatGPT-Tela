import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
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
      { path: join(codexHome, "AGENTS.md"), content: "global-v1\n", source: "global", scope: "user" },
      { path: "AGENTS.md", content: "project-v1\n", source: "workspace", scope: "project" },
    ]);
    expect(first.availableInstructionFiles).toContain("src/AGENTS.md");
    expect(first.globalInstructionStatus).toBe("loaded");
    expect(first.availableInstructionFiles).not.toContain("~/.codex/AGENTS.md");
    const repeated = discoverWorkspaceInstructions(root, { codexHome, knownInstructionRevision: first.instructionRevision });
    expect(repeated.instructionsUnchanged).toBe(true);
    expect(repeated.instructions).toEqual([]);
    expect(repeated.availableInstructionFiles).toEqual(first.availableInstructionFiles);
    // The same files are still required for a caller that did not retain that delivery.
    expect(discoverWorkspaceInstructions(root, { codexHome }).instructions).toEqual(first.instructions);

    writeFileSync(join(codexHome, "AGENTS.md"), "global-v2\n");
    unlinkSync(join(root, "AGENTS.md"));
    const second = discoverWorkspaceInstructions(realpathSync(root), { codexHome: realpathSync(codexHome),
      knownInstructionRevision: first.instructionRevision });
    expect(second.instructionsUnchanged).toBe(false);
    expect(second.instructions).toEqual([{ path: join(codexHome, "AGENTS.md"), content: "global-v2\n", source: "global", scope: "user" }]);
    expect(second.globalInstructionStatus).toBe("loaded");

    unlinkSync(join(codexHome, "AGENTS.md"));
    expect(discoverWorkspaceInstructions(realpathSync(root), { codexHome: realpathSync(codexHome) })).toMatchObject({ instructions: [], globalInstructionStatus: "missing" });
  });

  test("reports an oversized global file without advertising an unreadable workspace path", () => {
    const codexHome = realpathSync(directory());
    const root = realpathSync(directory());
    writeFileSync(join(codexHome, "AGENTS.md"), "x".repeat(128 * 1024 + 1));
    const result = discoverWorkspaceInstructions(realpathSync(root), { codexHome: realpathSync(codexHome) });
    expect(result.instructions).toEqual([]);
    expect(result.availableInstructionFiles).not.toContain("~/.codex/AGENTS.md");
    expect(result.globalInstructionStatus).toBe("oversized");
    expect(result.instructionScanComplete).toBe(false);
  });
});

test("an instruction revision from another workspace cannot suppress identical prose", () => {
  const codexHome = realpathSync(directory()), first = realpathSync(directory()), second = realpathSync(directory());
  for (const root of [first, second]) writeFileSync(join(root, "AGENTS.md"), "same rules");
  const original = discoverWorkspaceInstructions(first, { codexHome });
  const different = discoverWorkspaceInstructions(second, { codexHome, knownInstructionRevision: original.instructionRevision });
  expect(different.instructionsUnchanged).toBe(false);
  expect(different.instructions[0]?.content).toBe("same rules");
});

 test("follows user-managed global links and keeps workspace link boundaries", () => {
    const codexHome = realpathSync(directory());
    const root = realpathSync(directory());
    const shared = realpathSync(directory());
    writeFileSync(join(shared, "rules.md"), "user-rule");
    symlinkSync(join(shared, "rules.md"), join(codexHome, "AGENTS.md"));
    writeFileSync(join(root, "rules.md"), "project-rule");
    symlinkSync(join(root, "rules.md"), join(root, "AGENTS.md"));
    mkdirSync(join(root, "nested"));
    symlinkSync(join(shared, "rules.md"), join(root, "nested", "AGENTS.md"));
    const result = discoverWorkspaceInstructions(root, { codexHome });
    expect(result.instructions.map(row => row.content)).toEqual(["user-rule", "project-rule"]);
    expect(result.availableInstructionFiles).not.toContain("nested/AGENTS.md");
    expect(result.instructionScanComplete).toBe(false);
  });

 test("reports an invalid global file without blocking project instructions", () => {
    const codexHome = realpathSync(directory());
    const root = realpathSync(directory());
    mkdirSync(join(codexHome, "AGENTS.md"));
    writeFileSync(join(root, "AGENTS.md"), "project-rule");
    const result = discoverWorkspaceInstructions(root, { codexHome });
    expect(result.globalInstructionStatus).toBe("unreadable");
    expect(result.instructionScanComplete).toBe(false);
    expect(result.instructions.map(row => row.content)).toEqual(["project-rule"]);
 });
