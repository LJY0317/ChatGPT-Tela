import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatToolRuntime } from "./tools";

function skill(root: string, directory: string, name: string, description: string, extra = ""): void {
  const base = join(root, directory);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    ...(extra ? [extra] : []),
    "---",
    "",
    `# ${name}`,
    "",
    "Use this workflow.",
  ].join("\n"));
}

describe("Tela Chat standard skill discovery", () => {
  test("project skills override global skills and resources stay inside the selected skill", async () => {
    const base = mkdtempSync(join(tmpdir(), "tela-chat-skills-"));
    const project = join(base, "project");
    const global = join(base, "global-skills");
    mkdirSync(project);
    skill(global, "shared", "shared", "global description");
    skill(global, "global-only", "global-only", "global only description");
    skill(global, "hidden", "hidden", "hidden description", "disable-model-invocation: true");
    skill(join(project, ".agents", "skills"), "shared", "shared", "project description");
    skill(join(project, ".agents", "skills"), "project-only", "project-only", "project only description");
    writeFileSync(join(project, ".agents", "skills", "project-only", "references.md"), "reference line\n");
    const runtime = createChatToolRuntime({
      allowedRoots: [project],
      stateRoot: join(base, "state"),
      globalSkillRoots: [global],
    });
    try {
      const workspace = await runtime.call("open_workspace", { path: project }) as { id: string };
      const listed = await runtime.call("list_skills", { workspace_id: workspace.id }) as Array<{
        name: string; description: string; source: string;
      }>;
      expect(listed).toEqual([
        { name: "global-only", description: "global only description", source: "global" },
        { name: "project-only", description: "project only description", source: "project" },
        { name: "shared", description: "project description", source: "project" },
      ]);
      const read = await runtime.call("read_skill", {
        workspace_id: workspace.id,
        name: "project-only",
        path: "references.md",
      }) as { content: string; path: string };
      expect(read).toMatchObject({ path: "references.md", content: "1: reference line" });
      await expect(runtime.call("read_skill", {
        workspace_id: workspace.id,
        name: "project-only",
        path: "../SKILL.md",
      })).rejects.toThrow("path escapes the workspace");
    } finally {
      await runtime.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
