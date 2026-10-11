import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  readOwnershipManifest,
  unregisterOwnedResource,
} from "@chatgpt-tela/product-lifecycle";
import { ChatWorkspaceRegistry } from "./workspaces";
import { createChatToolRuntime } from "./tools";
import { ChatProcessManager } from "./processes";
import {
  ChatManagedWorktreeManager,
  ChatManagedWorktreeOwnershipObserver,
} from "./worktrees";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function listedWorktreeIds(cwd: string): string[] {
  return git(cwd, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter(line => line.startsWith("worktree "))
    .map(line => line.slice(9).replace(/\\/g, "/").split("/").at(-1)!)
    .filter(Boolean);
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tela-chat-worktree-"));
  const source = join(base, "source");
  const state = join(base, "state");
  const managedRoot = join(state, "managed-worktrees");
  const workspaceStore = join(state, "workspaces-v1.json");
  const worktreeStore = join(state, "managed-worktrees-v1.json");
  const ownershipManifest = join(state, "ownership-v1.json");
  mkdirSync(source);
  git(source, ["init"]);
  git(source, ["config", "user.email", "tela@example.invalid"]);
  git(source, ["config", "user.name", "Tela Test"]);
  writeFileSync(join(source, "README.md"), "base\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "Initial"]);
  const workspaces = new ChatWorkspaceRegistry({
    allowedRoots: [source],
    managedRoots: [managedRoot],
    storePath: workspaceStore,
  });
  const sourceWorkspace = workspaces.open(source);
  const manager = new ChatManagedWorktreeManager({
    workspaces,
    managedRoot,
    storePath: worktreeStore,
    ownershipManifestPath: ownershipManifest,
    installId: "install-worktree-test",
    productVersion: "0.0.0",
  });
  return {
    base,
    source,
    state,
    managedRoot,
    workspaceStore,
    worktreeStore,
    ownershipManifest,
    workspaces,
    sourceWorkspace,
    manager,
  };
}

describe("Tela Chat managed worktree ownership", () => {
  test("creates only under Tela state, records exact ownership, and removes a clean base worktree", async () => {
    const f = fixture();
    try {
      const created = await f.manager.create({ sourceWorkspaceId: f.sourceWorkspace.id });
      expect(created.workspace.kind).toBe("managed");
      expect(created.worktree.path.startsWith(`${realpathSync(f.managedRoot)}${sep}`)).toBe(true);
      expect(created.worktree.sourceRoot).toBe(realpathSync(f.source));
      const manifest = readOwnershipManifest(f.ownershipManifest);
      expect(manifest?.installId).toBe("install-worktree-test");
      expect(manifest?.resources).toContainEqual({
        kind: "managed-worktree",
        id: created.worktree.resourceId,
        owner: "chat",
        path: created.worktree.path,
        repositoryIdentity: created.worktree.repositoryIdentity,
      });
      expect((await f.manager.inspect(created.worktree.id)).state).toBe("owned-clean");
      const observer = new ChatManagedWorktreeOwnershipObserver(f.manager);
      expect(await observer.observe(
        manifest!.resources.find(resource => resource.id === created.worktree.resourceId)!,
        manifest!,
      )).toBe("owned");
      const removed = await f.manager.remove(created.worktree.id);
      expect(removed).toMatchObject({ removed: true, preserved: false });
      expect(existsSync(created.worktree.path)).toBe(false);
      expect(readOwnershipManifest(f.ownershipManifest)?.resources).toEqual([]);
      expect(existsSync(f.source)).toBe(true);
      expect(readFileSync(join(f.source, "README.md"), "utf8")).toBe("base\n");
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("dirty managed worktree is preserved and remains in the uninstall manifest", async () => {
    const f = fixture();
    try {
      const created = await f.manager.create({ sourceWorkspaceId: f.sourceWorkspace.id });
      writeFileSync(join(created.worktree.path, "notes.txt"), "user-significant\n");
      const inspection = await f.manager.inspect(created.worktree.id);
      expect(inspection.state).toBe("dirty");
      expect((await f.manager.remove(created.worktree.id))).toMatchObject({ removed: false, preserved: true });
      expect(existsSync(created.worktree.path)).toBe(true);
      expect(readOwnershipManifest(f.ownershipManifest)?.resources.some(resource => resource.id === created.worktree.resourceId))
        .toBe(true);
      const observer = new ChatManagedWorktreeOwnershipObserver(f.manager);
      expect(await observer.observe(
        readOwnershipManifest(f.ownershipManifest)!.resources[0]!,
        readOwnershipManifest(f.ownershipManifest)!,
      )).toBe("dirty");
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("clean detached commits are preserved instead of being made unreachable", async () => {
    const f = fixture();
    try {
      const created = await f.manager.create({ sourceWorkspaceId: f.sourceWorkspace.id });
      writeFileSync(join(created.worktree.path, "README.md"), "new commit\n");
      git(created.worktree.path, ["add", "README.md"]);
      git(created.worktree.path, ["commit", "-m", "Managed change"]);
      const inspection = await f.manager.inspect(created.worktree.id);
      expect(inspection.state).toBe("head-drift");
      expect(inspection.headSha).not.toBe(created.worktree.baseSha);
      expect((await f.manager.remove(created.worktree.id))).toMatchObject({ removed: false, preserved: true });
      expect(existsSync(created.worktree.path)).toBe(true);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("ownership marker drift prevents destructive cleanup", async () => {
    const f = fixture();
    try {
      const created = await f.manager.create({ sourceWorkspaceId: f.sourceWorkspace.id });
      const rawGitDir = git(created.worktree.path, ["rev-parse", "--git-dir"]);
      const gitDir = resolve(created.worktree.path, rawGitDir);
      writeFileSync(join(gitDir, "chatgpt-tela-owner-v1.json"), JSON.stringify({ version: 1, installId: "foreign" }));
      expect((await f.manager.inspect(created.worktree.id)).state).toBe("unsafe");
      expect((await f.manager.remove(created.worktree.id))).toMatchObject({ removed: false, preserved: true });
      expect(existsSync(created.worktree.path)).toBe(true);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("a managed worktree path replaced by a symlink is never removed as Tela-owned", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "tela-chat-worktree-outside-"));
    try {
      writeFileSync(join(outside, "sentinel.txt"), "outside\n");
      const created = await f.manager.create({ sourceWorkspaceId: f.sourceWorkspace.id });
      rmSync(created.worktree.path, { recursive: true, force: true });
      symlinkSync(outside, created.worktree.path, "dir");
      const inspection = await f.manager.inspect(created.worktree.id);
      expect(inspection.state).toBe("unsafe");
      expect((await f.manager.remove(created.worktree.id))).toMatchObject({ removed: false, preserved: true });
      expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("outside\n");
    } finally {
      rmSync(f.base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("missing source repository preserves the managed worktree", async () => {
    const f = fixture();
    try {
      const created = await f.manager.create({ sourceWorkspaceId: f.sourceWorkspace.id });
      renameSync(f.source, `${f.source}.moved`);
      const inspection = await f.manager.inspect(created.worktree.id);
      expect(inspection.state).toBe("source-missing");
      expect((await f.manager.remove(created.worktree.id))).toMatchObject({ removed: false, preserved: true });
      expect(existsSync(created.worktree.path)).toBe(true);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("a missing worktree directory cleans only its exact proven stale Git registration", async () => {
    const f = fixture();
    try {
      const created = await f.manager.create({ sourceWorkspaceId: f.sourceWorkspace.id });
      rmSync(created.worktree.path, { recursive: true, force: true });
      const inspection = await f.manager.inspect(created.worktree.id);
      expect(inspection).toMatchObject({ state: "owned-missing-registration", removable: true });
      expect(listedWorktreeIds(f.source)).toContain(created.worktree.id);
      expect(await f.manager.remove(created.worktree.id)).toMatchObject({ removed: true, preserved: false });
      expect(listedWorktreeIds(f.source)).not.toContain(created.worktree.id);
      expect(readOwnershipManifest(f.ownershipManifest)?.resources).toEqual([]);
      expect(existsSync(f.source)).toBe(true);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("a missing worktree without its exact admin marker is preserved", async () => {
    const f = fixture();
    try {
      const created = await f.manager.create({ sourceWorkspaceId: f.sourceWorkspace.id });
      const rawGitDir = git(created.worktree.path, ["rev-parse", "--git-dir"]);
      const gitDir = resolve(created.worktree.path, rawGitDir);
      rmSync(join(gitDir, "chatgpt-tela-owner-v1.json"), { force: true });
      rmSync(created.worktree.path, { recursive: true, force: true });
      const inspection = await f.manager.inspect(created.worktree.id);
      expect(inspection.state).toBe("ownership-drift");
      expect(await f.manager.remove(created.worktree.id)).toMatchObject({ removed: false, preserved: true });
      expect(listedWorktreeIds(f.source)).toContain(created.worktree.id);
      expect(readOwnershipManifest(f.ownershipManifest)?.resources.some(resource => resource.id === created.worktree.resourceId))
        .toBe(true);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("reconcile repairs a provisioning record whose manifest registration was interrupted", async () => {
    const f = fixture();
    try {
      const created = await f.manager.create({ sourceWorkspaceId: f.sourceWorkspace.id });
      const store = JSON.parse(readFileSync(f.worktreeStore, "utf8")) as {
        version: 1;
        worktrees: Array<Record<string, unknown>>;
      };
      store.worktrees[0]!.lifecycle = "provisioning";
      writeFileSync(f.worktreeStore, `${JSON.stringify(store, null, 2)}\n`);
      await unregisterOwnedResource({
        path: f.ownershipManifest,
        installId: "install-worktree-test",
        productVersion: "0.0.0",
        resourceId: created.worktree.resourceId,
      });

      const restoredWorkspaces = new ChatWorkspaceRegistry({
        allowedRoots: [f.source],
        managedRoots: [f.managedRoot],
        storePath: f.workspaceStore,
      });
      const restored = new ChatManagedWorktreeManager({
        workspaces: restoredWorkspaces,
        managedRoot: f.managedRoot,
        storePath: f.worktreeStore,
        ownershipManifestPath: f.ownershipManifest,
        installId: "install-worktree-test",
        productVersion: "0.0.0",
      });
      await restored.reconcile();
      expect(restored.list()[0]?.lifecycle).toBe("active");
      expect(readOwnershipManifest(f.ownershipManifest)?.resources.some(resource => resource.id === created.worktree.resourceId))
        .toBe(true);
      expect((await restored.inspect(created.worktree.id)).state).toBe("owned-clean");
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("reconcile finishes an interrupted exact removal after the directory disappeared", async () => {
    const f = fixture();
    try {
      const created = await f.manager.create({ sourceWorkspaceId: f.sourceWorkspace.id });
      const store = JSON.parse(readFileSync(f.worktreeStore, "utf8")) as {
        version: 1;
        worktrees: Array<Record<string, unknown>>;
      };
      store.worktrees[0]!.lifecycle = "removing";
      writeFileSync(f.worktreeStore, `${JSON.stringify(store, null, 2)}\n`);
      rmSync(created.worktree.path, { recursive: true, force: true });

      const restoredWorkspaces = new ChatWorkspaceRegistry({
        allowedRoots: [f.source],
        managedRoots: [f.managedRoot],
        storePath: f.workspaceStore,
      });
      const restored = new ChatManagedWorktreeManager({
        workspaces: restoredWorkspaces,
        managedRoot: f.managedRoot,
        storePath: f.worktreeStore,
        ownershipManifestPath: f.ownershipManifest,
        installId: "install-worktree-test",
        productVersion: "0.0.0",
      });
      await restored.reconcile();
      expect(restored.list()).toEqual([]);
      expect(readOwnershipManifest(f.ownershipManifest)?.resources).toEqual([]);
      expect(git(f.source, ["worktree", "list", "--porcelain"])).not.toContain(created.worktree.path);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });
});


test("public removal preserves live agent work and admits clean terminal cleanup", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = createChatToolRuntime({ allowedRoots: [f.source], stateRoot: f.state,
    ownership: { installId: "install-worktree-test", productVersion: "0.0.0", manifestPath: f.ownershipManifest },
    agentDrivers: [{ id: "fixture", async run() { await gate; return { response: "done" }; } }],
  });
  try {
    await runtime.initialize();
    const created = await runtime.worktrees!.create({ sourceWorkspaceId: f.sourceWorkspace.id });
    const agent = await runtime.agents!.start({ workspaceId: created.workspace.id, target: "fixture", prompt: "fixture" });
    expect(await runtime.call("remove_worktree", { worktree_id: created.worktree.id })).toMatchObject({ removed: false, preserved: true });
    expect(existsSync(created.worktree.path)).toBe(true);
    release();
    expect((await runtime.agents!.wait({ workspaceId: created.workspace.id, agentIds: [agent.id], timeoutMs: 1000 }))[0]!.status).toBe("idle");
    expect(await runtime.call("remove_worktree", { worktree_id: created.worktree.id })).toMatchObject({ removed: true, preserved: false });
  } finally { release(); await runtime.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("missing driver and retention cannot discard unresolved agent workspace authority", async () => {
  const f = fixture();
  const input = { allowedRoots: [f.source], stateRoot: f.state,
    ownership: { installId: "install-worktree-test", productVersion: "0.0.0", manifestPath: f.ownershipManifest } };
  const runtime = createChatToolRuntime({ ...input,
    agentDrivers: [{ id: "fixture", async run() { return { response: "done" }; } }],
  });
  try {
    await runtime.initialize();
    const created = await runtime.worktrees!.create({ sourceWorkspaceId: f.sourceWorkspace.id });
    const agent = await runtime.agents!.start({ workspaceId: created.workspace.id, target: "fixture", prompt: "fixture" });
    await runtime.agents!.wait({ workspaceId: created.workspace.id, agentIds: [agent.id], timeoutMs: 1000 });
    await runtime.close();
    const path = join(f.state, "agents-v1.json");
    const store = JSON.parse(readFileSync(path, "utf8"));
    store.agents[0].status = "unknown"; store.agents[0].updatedAt = "2000-01-01T00:00:00.000Z";
    store.turns[0].status = "unknown"; store.turns[0].updatedAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(path, JSON.stringify(store));
    const restarted = createChatToolRuntime(input);
    try {
      await restarted.initialize();
      expect(restarted.capabilities).not.toContain("start_agent");
      expect(await restarted.call("remove_worktree", { worktree_id: created.worktree.id })).toMatchObject({ removed: false, preserved: true });
      expect(existsSync(created.worktree.path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).agents).toHaveLength(1);
    } finally { await restarted.close(); }
  } finally { await runtime.close(); rmSync(f.base, { recursive: true, force: true }); }
});


test("worktree removal holds exclusion across Git inspection and releases when cleanup refuses", async () => {
  const f = fixture();
  const processes = new ChatProcessManager({ workspaces: f.workspaces, storePath: join(f.state, "processes.json") });
  let resume!: () => void;
  try {
    const created = await f.manager.create({ sourceWorkspaceId: f.sourceWorkspace.id });
    writeFileSync(join(created.worktree.path, "dirty.txt"), "preserve");
    const inspect = f.manager.inspect.bind(f.manager);
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    f.manager.inspect = async (...args) => { entered(); await gate; return inspect(...args); };
    const removal = f.manager.remove(created.worktree.id);
    await waiting;
    try {
      await expect(processes.exec({ workspaceId: created.workspace.id, command: "true" })).rejects.toThrow("removal is in progress");
    } finally { resume(); }
    expect((await removal).preserved).toBe(true);
    expect(f.workspaces.get(created.workspace.id).root).toBe(created.worktree.path);
  } finally { resume?.(); await processes.close(); rmSync(f.base, { recursive: true, force: true }); }
});
