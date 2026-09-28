import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createChatToolRuntime } from "./tools";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tela-chat-tools-"));
  const root = join(base, "project");
  mkdirSync(root);
  git(root, ["init"]);
  git(root, ["config", "user.email", "tela@example.invalid"]);
  git(root, ["config", "user.name", "Tela Test"]);
  writeFileSync(join(root, "README.md"), "hello\nworld\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "Initial"]);
  const runtime = createChatToolRuntime({ allowedRoots: [root], stateRoot: join(base, "state") });
  return { base, root, runtime };
}

describe("Tela Chat first vertical slice", () => {
  test("open -> read -> patch -> exec/status -> show changes stays inside one approved workspace", async () => {
    const f = fixture();
    try {
      const workspace = await f.runtime.call("open_workspace", { path: f.root }) as { id: string; root: string };
      expect(workspace.root).toBe(realpathSync(f.root));

      const read = await f.runtime.call("read", {
        workspace_id: workspace.id,
        path: "README.md",
        offset: 1,
        limit: 10,
      }) as { content: string; totalLines: number };
      expect(read.content).toContain("1: hello");
      expect(read.totalLines).toBe(2);

      const many = await f.runtime.call("read_many", {
        workspace_id: workspace.id,
        reads: [{ path: "README.md", limit: 1 }, { path: "README.md", offset: 2, limit: 1 }],
      }) as readonly { content: string }[];
      expect(many.map(item => item.content)).toEqual(["1: hello", "2: world"]);

      await f.runtime.call("apply_patch", {
        workspace_id: workspace.id,
        patch: `*** Begin Patch\n*** Update File: README.md\n@@\n hello\n-world\n+tela\n*** Add File: notes.txt\n+new file\n*** End Patch`,
      });
      expect(readFileSync(join(f.root, "README.md"), "utf8")).toBe("hello\ntela\n");

      const operationId = randomUUID();
      const processResult = await f.runtime.call("exec_command", {
        workspace_id: workspace.id,
        operation_id: operationId,
        cmd: process.platform === "win32" ? "echo process-ok" : "printf process-ok",
        yield_time_ms: 1000,
      }) as { output: string; state: string };
      expect(processResult.output).toContain("process-ok");
      expect(processResult.state).toBe("exited");
      const status = await f.runtime.call("process_status", {
        workspace_id: workspace.id,
        operation_id: operationId,
      }) as { state: string; ioAvailable: boolean };
      expect(status).toMatchObject({ state: "exited", ioAvailable: false });

      const changes = await f.runtime.call("show_changes", { workspace_id: workspace.id }) as {
        status: string;
        patch: string;
        untracked: readonly string[];
      };
      expect(changes.patch).toContain("-world");
      expect(changes.patch).toContain("+tela");
      expect(changes.untracked).toContain("notes.txt");
    } finally {
      await f.runtime.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("workspace registration refuses a path outside locally approved roots", async () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "tela-chat-unapproved-"));
    try {
      await expect(f.runtime.call("open_workspace", { path: outside })).rejects.toThrow("outside locally approved roots");
    } finally {
      await f.runtime.close();
      rmSync(f.base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("workspace-scoped failures create bounded privacy-safe incident references without changing the original error", async () => {
    const f = fixture();
    try {
      const workspace = await f.runtime.call("open_workspace", { path: f.root }) as { id: string };
      await expect(f.runtime.call("read", {
        workspace_id: workspace.id,
        path: "private-do-not-persist.txt",
      })).rejects.toThrow();
      const incidents = await f.runtime.call("list_incidents", {
        workspace_id: workspace.id,
      }) as ReadonlyArray<{ incidentRef: string; capability: string; category: string; workspaceFingerprint?: string }>;
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({ capability: "read", category: "failed" });
      expect(incidents[0]?.workspaceFingerprint).toBeUndefined();
      const shown = await f.runtime.call("show_incident", {
        workspace_id: workspace.id,
        incident_ref: incidents[0]!.incidentRef,
      });
      expect(shown).toEqual(incidents[0]);
    } finally {
      await f.runtime.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("show_changes never walks upward into an unapproved parent Git repository", async () => {
    const base = mkdtempSync(join(tmpdir(), "tela-chat-parent-repo-"));
    const child = join(base, "approved-child");
    mkdirSync(child);
    git(base, ["init"]);
    git(base, ["config", "user.email", "tela@example.invalid"]);
    git(base, ["config", "user.name", "Tela Test"]);
    writeFileSync(join(child, "inside.txt"), "inside\n");
    git(base, ["add", "."]);
    git(base, ["commit", "-m", "Initial"]);
    const runtime = createChatToolRuntime({ allowedRoots: [child], stateRoot: join(base, ".tela-state") });
    try {
      const workspace = await runtime.call("open_workspace", { path: child }) as { id: string };
      await expect(runtime.call("show_changes", { workspace_id: workspace.id }))
        .rejects.toThrow("outside the approved workspace root");
    } finally {
      await runtime.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("managed worktree capabilities create only Tela-owned roots and refuse to delete dirty work", async () => {
    const base = mkdtempSync(join(tmpdir(), "tela-chat-managed-tools-"));
    const source = join(base, "source");
    const stateRoot = join(base, "state");
    mkdirSync(source);
    git(source, ["init"]);
    git(source, ["config", "user.email", "tela@example.invalid"]);
    git(source, ["config", "user.name", "Tela Test"]);
    writeFileSync(join(source, "README.md"), "base\n");
    git(source, ["add", "README.md"]);
    git(source, ["commit", "-m", "Initial"]);
    const runtime = createChatToolRuntime({
      allowedRoots: [source],
      stateRoot,
      ownership: {
        installId: "tools-managed-install",
        productVersion: "0.0.0",
        manifestPath: join(base, "ownership-v1.json"),
      },
    });
    try {
      await runtime.initialize();
      expect(runtime.capabilities).toContain("create_worktree");
      const sourceWorkspace = await runtime.call("open_workspace", { path: source }) as { id: string };
      const created = await runtime.call("create_worktree", {
        source_workspace_id: sourceWorkspace.id,
      }) as { worktree: { id: string; path: string }; workspace: { id: string; kind: string } };
      expect(created.workspace.kind).toBe("managed");
      expect((await runtime.call("list_worktrees", {}) as readonly unknown[]).length).toBe(1);
      expect(await runtime.call("inspect_worktree", { worktree_id: created.worktree.id }))
        .toMatchObject({ state: "owned-clean", removable: true });
      writeFileSync(join(created.worktree.path, "keep-me.txt"), "dirty\n");
      expect(await runtime.call("remove_worktree", { worktree_id: created.worktree.id }))
        .toMatchObject({ removed: false, preserved: true });
      expect(existsSync(created.worktree.path)).toBe(true);
    } finally {
      await runtime.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
