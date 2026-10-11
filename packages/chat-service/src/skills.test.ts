import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

async function fixture(run: (context: { project: string; global: string; workspaceId: string; runtime: ReturnType<typeof createChatToolRuntime> }) => Promise<void>) {
  const base = mkdtempSync(join(tmpdir(), "tela-skill-contract-"));
  const project = join(base, "project");
  const global = join(base, "global");
  mkdirSync(project);
  const runtime = createChatToolRuntime({ allowedRoots: [project], stateRoot: join(base, "state"), globalSkillRoots: [global] });
  try {
    const workspace = await runtime.call("open_workspace", { path: project }) as { id: string };
    await run({ project, global, workspaceId: workspace.id, runtime });
  } finally { await runtime.close(); rmSync(base, { recursive: true, force: true }); }
}

test("YAML multiline, quoted values and CRLF remain searchable; edits are discovered on demand", async () => {
  await fixture(async ({ project, workspaceId, runtime }) => {
    const root = join(project, ".agents", "skills");
    skill(root, "workflow", "workflow", "placeholder");
    const path = join(root, "workflow", "SKILL.md");
    writeFileSync(path, ["---", 'name: "workflow" # comment', "description: >-", "  Inspect changes", "  before editing.", "---", "# Workflow"].join("\r\n"));
    expect(await runtime.call("list_skills", { workspace_id: workspaceId, query: "before editing" })).toEqual([
      { name: "workflow", description: "Inspect changes before editing.", source: "project" },
    ]);
    writeFileSync(path, "---\nname: workflow\ndescription: |\n  First line\n  Second line\n---\nBody\n");
    expect(await runtime.call("list_skills", { workspace_id: workspaceId })).toEqual([
      { name: "workflow", description: "First line\nSecond line", source: "project" },
    ]);
  });
});

test("project disable masks the same global skill and prevents supporting-file reads", async () => {
  await fixture(async ({ project, global, workspaceId, runtime }) => {
    skill(global, "workflow", "workflow", "global");
    skill(join(project, ".agents", "skills"), "workflow", "workflow", "project", "disable-model-invocation: true");
    expect(await runtime.call("list_skills", { workspace_id: workspaceId })).toEqual([]);
    await expect(runtime.call("read_skill", { workspace_id: workspaceId, name: "workflow" })).rejects.toThrow("unknown Tela Chat skill");
  });
});

test("ambiguous metadata, invalid UTF-8 and oversized skill documents are not advertised", async () => {
  await fixture(async ({ project, workspaceId, runtime }) => {
    const root = join(project, ".agents", "skills");
    const cases = [
      "---\nname: bad\nname: other\ndescription: duplicate\n---",
      "---\nname: bad\ndescription: [not, text]\n---",
      "---\nname: bad\ndescription: valid\ndisable-model-invocation: maybe\n---",
      "---\nname: &name bad\ndescription: *name\n---",
      "---\nname: bad\ndescription: !unknown value\n---",
      "---\nname: bad\ndescription: unterminated",
      Buffer.from([0xff, 0xfe]),
      "x".repeat(256 * 1024 + 1),
    ];
    for (const [index, content] of cases.entries()) {
      const dir = join(root, `case-${index}`); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "SKILL.md"), content);
    }
    skill(root, "valid", "valid", "still available");
    expect(await runtime.call("list_skills", { workspace_id: workspaceId })).toEqual([
      { name: "valid", description: "still available", source: "project" },
    ]);
  });
});

test("duplicate names within one root fail instead of selecting an arbitrary workflow", async () => {
  await fixture(async ({ project, workspaceId, runtime }) => {
    const root = join(project, ".agents", "skills");
    skill(root, "first", "shared", "first"); skill(root, "second", "shared", "second");
    await expect(runtime.call("list_skills", { workspace_id: workspaceId })).rejects.toThrow("duplicate skill name");
    await expect(runtime.call("read_skill", { workspace_id: workspaceId, name: "shared" })).rejects.toThrow("duplicate skill name");
  });
});

test("supporting files paginate and reject symlink escapes, binary text and oversized resources", async () => {
  await fixture(async ({ project, global, workspaceId, runtime }) => {
    const root = join(project, ".agents", "skills");
    skill(root, "workflow", "workflow", "test");
    const dir = join(root, "workflow");
    writeFileSync(join(dir, "reference.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(dir, "binary.txt"), Buffer.from([0xff]));
    writeFileSync(join(dir, "large.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    expect(await runtime.call("read_skill", { workspace_id: workspaceId, name: "workflow", path: "reference.txt", offset: 2, limit: 1 })).toMatchObject({ content: "2: two", startLine: 2, endLine: 2, totalLines: 3, hasMore: true });
    expect(await runtime.call("read_skill", { workspace_id: workspaceId, name: "workflow", path: "reference.txt", offset: 3, limit: 1 })).toMatchObject({ content: "3: three", hasMore: false });
    await expect(runtime.call("read_skill", { workspace_id: workspaceId, name: "workflow", path: "binary.txt" })).rejects.toThrow("not UTF-8");
    await expect(runtime.call("read_skill", { workspace_id: workspaceId, name: "workflow", path: "large.txt" })).rejects.toThrow("exceeds");
    if (process.platform !== "win32") {
      mkdirSync(global); writeFileSync(join(global, "outside.txt"), "outside");
      symlinkSync(join(global, "outside.txt"), join(dir, "escape.txt"));
      await expect(runtime.call("read_skill", { workspace_id: workspaceId, name: "workflow", path: "escape.txt" })).rejects.toThrow("outside the skill directory");
    }
  });
});
