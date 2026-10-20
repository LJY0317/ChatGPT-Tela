import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { observeDiagnosticEvents } from "@chatgpt-tela/core";
import { createChatToolRuntime } from "./tools";
import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";

const removeFixture = registerTemporaryFixtureCleanup();

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
  test("effectful ingress records a content-free dispatch boundary", async () => {
    const f = fixture();
    const observed: unknown[] = [];
    const stop = observeDiagnosticEvents(event => {
      if (event.event === "chatgpt_tela_chat" && event.stage === "chat_capability_dispatch_received") {
        observed.push(event);
      }
    });
    try {
      expect(stop).toBeDefined();
      const workspace = await f.runtime.call("open_workspace", { path: f.root }) as { id: string };
      await f.runtime.call("read", { workspace_id: workspace.id, path: "README.md" });
      expect(observed).toHaveLength(0);
      const privatePayload = "ONLY_IN_TEST_FILE_NOT_DIAGNOSTICS";
      await f.runtime.call("apply_patch", {
        workspace_id: workspace.id,
        patch: `*** Begin Patch\n*** Add File: payload.txt\n+${privatePayload}\n*** End Patch`,
      });
      expect(readFileSync(join(f.root, "payload.txt"), "utf8")).toContain(privatePayload);
      // Invalid input reached service dispatch but never acquired a workspace.
      await expect(f.runtime.call("apply_patch", {
        workspace_id: "x".repeat(17_000), patch: "not a patch",
      })).rejects.toThrow();
      expect(observed).toHaveLength(2);
      const log = JSON.stringify(observed);
      expect(log).toContain("chat_capability_dispatch_received");
      expect(log).toContain("apply_patch");
      expect(log).not.toContain(privatePayload);
      expect(log).not.toContain(f.root);
      expect(log).not.toContain(workspace.id);
    } finally {
      stop?.();
      await f.runtime.close();
      removeFixture(f.base);
    }
  });

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
      removeFixture(f.base);
    }
  });

  test("workspace registration refuses a path outside locally approved roots", async () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "tela-chat-unapproved-"));
    try {
      await expect(f.runtime.call("open_workspace", { path: outside })).rejects.toThrow("outside locally approved roots");
    } finally {
      await f.runtime.close();
      removeFixture(f.base);
      removeFixture(outside);
    }
  });

  test("open_workspace loads bounded root instructions and advertises nested instructions explicitly", async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.root, "packages", "app"), { recursive: true });
      mkdirSync(join(f.root, "node_modules", "ignored"), { recursive: true });
      writeFileSync(join(f.root, "AGENTS.md"), "root agent rules\n");
      writeFileSync(join(f.root, "CLAUDE.md"), "root claude rules\n");
      writeFileSync(join(f.root, "packages", "AGENTS.md"), "package rules\n");
      writeFileSync(join(f.root, "packages", "app", "CLAUDE.MD"), "app rules\n");
      writeFileSync(join(f.root, "node_modules", "ignored", "AGENTS.md"), "dependency rules\n");

      const opened = await f.runtime.call("open_workspace", { path: f.root }) as {
        instructions: readonly { path: string; content: string }[];
        availableInstructionFiles: readonly string[];
        instructionScanComplete: boolean;
      };
      expect(opened.instructions).toEqual([
        { path: "AGENTS.md", content: "root agent rules\n" },
        { path: "CLAUDE.md", content: "root claude rules\n" },
      ]);
      expect(opened.availableInstructionFiles).toEqual([
        "packages/AGENTS.md",
        "packages/app/CLAUDE.MD",
      ]);
      expect(opened.instructionScanComplete).toBe(true);
    } finally {
      await f.runtime.close();
      removeFixture(f.base);
    }
  });

  test("repository exploration lists directories and searches bounded text without shell access", async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.root, "src"));
      mkdirSync(join(f.root, "node_modules", "ignored"), { recursive: true });
      writeFileSync(join(f.root, "src", "alpha.ts"), "export const Needle = 'first';\n");
      writeFileSync(join(f.root, "src", "beta.ts"), "// needle second\n");
      writeFileSync(join(f.root, "node_modules", "ignored", "dep.js"), "needle dependency\n");
      const workspace = await f.runtime.call("open_workspace", { path: f.root }) as { id: string };

      const listed = await f.runtime.call("list_directory", {
        workspace_id: workspace.id,
        path: "src",
      }) as { path: string; entries: readonly { name: string; kind: string }[]; hasMore: boolean };
      expect(listed).toEqual({
        path: "src",
        entries: [
          { name: "alpha.ts", kind: "file" },
          { name: "beta.ts", kind: "file" },
        ],
        hasMore: false,
      });

      const searched = await f.runtime.call("search_text", {
        workspace_id: workspace.id,
        query: "needle",
      }) as { matches: readonly { path: string; line: number; preview: string }[]; scanComplete: boolean };
      expect(searched.matches).toEqual([
        { path: "src/alpha.ts", line: 1, preview: "export const Needle = 'first';" },
        { path: "src/beta.ts", line: 1, preview: "// needle second" },
      ]);
      expect(searched.scanComplete).toBe(true);
    } finally {
      await f.runtime.close();
      removeFixture(f.base);
    }
  });

  test("filename search finds bounded workspace paths without inspecting file contents or following links", async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.root, "src"));
      mkdirSync(join(f.root, "node_modules", "ignored"), { recursive: true });
      writeFileSync(join(f.root, "src", "Account.ts"), Buffer.from([0, 1, 2]));
      writeFileSync(join(f.root, "src", "account.test.ts"), "plain");
      writeFileSync(join(f.root, "node_modules", "ignored", "account.ts"), "ignored");
      const workspace = await f.runtime.call("open_workspace", { path: f.root }) as { id: string };
      const found = await f.runtime.call("search_files", { workspace_id: workspace.id, query: "account" }) as {
        matches: readonly string[]; scanComplete: boolean; entriesScanned: number;
      };
      expect(found.matches).toEqual(["src/account.test.ts", "src/Account.ts"]);
      expect(found.scanComplete).toBe(true);
      expect(found.entriesScanned).toBeGreaterThanOrEqual(3);
      const exact = await f.runtime.call("search_files", { workspace_id: workspace.id,
        query: "Account", case_sensitive: true, max_results: 1 }) as {
          matches: readonly string[]; hasMore: boolean; scanComplete: boolean;
        };
      expect(exact.matches).toEqual(["src/Account.ts"]);
      expect(exact.hasMore).toBe(false);
      expect(exact.scanComplete).toBe(true);
      expect((await f.runtime.call("search_files", { workspace_id: workspace.id,
        query: "Account", case_sensitive: true, path: "src" }) as { matches: readonly string[] }).matches)
        .toEqual(["src/Account.ts"]);
      const bounded = await f.runtime.call("search_files", { workspace_id: workspace.id,
        query: "account", max_results: 1 }) as { matches: readonly string[]; hasMore: boolean; scanComplete: boolean };
      expect(bounded.matches).toEqual(["src/account.test.ts"]);
      expect(bounded.hasMore).toBe(true);
      expect(bounded.scanComplete).toBe(false);
      await expect(f.runtime.call("search_files", { workspace_id: "other", query: "Account" })).rejects.toThrow();
      await expect(f.runtime.call("search_files", { workspace_id: workspace.id, query: "Account", path: "../" })).rejects.toThrow();
    } finally {
      await f.runtime.close();
      removeFixture(f.base);
    }
  });

  test("read_many reports each path separately without erasing a valid neighbor or exposing host paths",async()=>{
    const f=fixture();
    try{
      const workspace=await f.runtime.call("open_workspace",{path:f.root}) as {id:string};
      writeFileSync(join(f.root,"binary.dat"),Buffer.from([0,1,2,3]));
      const results=await f.runtime.call("read_many",{
        workspace_id:workspace.id,reads:[
          {path:"README.md",limit:1},
          {path:"missing-file-sensitive-name.txt"},
          {path:"../outside.txt"},
          {path:"binary.dat"},
          {path:"."},
          {path:"README.md",offset:2,limit:1},
        ],
      }) as ReadonlyArray<{path:string;status:string;content:string;error?:{code:string;message:string}}>;
      expect(results.map(x=>x.status)).toEqual(["ok","error","error","error","error","ok"]);
      expect(results[0]?.content).toBe("1: hello");
      expect(results[1]?.error?.code).toBe("not_found");
      expect(results[2]?.error?.code).toBe("path_denied");
      expect(results[3]?.error?.code).toBe("binary");
      expect(results[4]?.error?.code).toBe("path_denied");
      expect(results[5]?.content).toBe("2: world");
      expect(JSON.stringify(results)).not.toContain(f.root);
      // An invalid workspace is an owner failure, not an item-level bypass.
      await expect(f.runtime.call("read_many",{
        workspace_id:"foreign",reads:[{path:"README.md"}],
      })).rejects.toThrow();
    }finally{
      await f.runtime.close();
      removeFixture(f.base);
    }
  });

  test("read_many accounts for budget-limited files instead of silently omitting requested results",async()=>{
    const f=fixture();
    try{
      const workspace=await f.runtime.call("open_workspace",{path:f.root}) as {id:string};
      writeFileSync(join(f.root,"giant.txt"),("a".repeat(1600)+"\n").repeat(400));
      writeFileSync(join(f.root,"many.txt"),Array.from({length:400},(_,i)=>`line ${i}\n`).join(""));
      const results=await f.runtime.call("read_many",{
        workspace_id:workspace.id,reads:[
          {path:"giant.txt",limit:400}, {path:"README.md",limit:1},
          {path:"many.txt",limit:400},{path:"many.txt",limit:400},
          {path:"many.txt",limit:400},{path:"README.md",limit:1},
        ],
      }) as ReadonlyArray<{status:string;content:string;error?:{code:string}}>;
      expect(results).toHaveLength(6);
      expect(results[0]?.status).toBe("skipped");
      expect(results[0]?.error?.code).toBe("batch_budget_exhausted");
      expect(results[1]?.status).toBe("ok");
      expect(results[2]?.status).toBe("ok");
      expect(results[3]?.status).toBe("ok");
      expect(results[4]?.status).toBe("ok");
      expect(results[5]?.status).toBe("skipped");
      expect(results[5]?.error?.code).toBe("batch_budget_exhausted");
    }finally{
      await f.runtime.close();
      removeFixture(f.base);
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
      removeFixture(f.base);
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
      removeFixture(base);
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
      removeFixture(base);
    }
  });
});


test("view_image returns actual workspace image bytes and refuses a mislabeled file", async () => {
  const f = fixture();
  try {
    const workspace = await f.runtime.call("open_workspace", { path: f.root }) as { id: string };
    const png = Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex");
    writeFileSync(join(f.root, "sample.png"), png);
    const image = await f.runtime.call("view_image", { workspace_id: workspace.id, path: "sample.png" }) as { mimeType: string; dataBase64: string };
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.dataBase64, "base64")).toEqual(png);
    writeFileSync(join(f.root, "capture"), png);
    expect(await f.runtime.call("view_image", { workspace_id: workspace.id, path: "capture" }))
      .toMatchObject({ mimeType: "image/png", dataBase64: png.toString("base64") });
    writeFileSync(join(f.root, "image.jpg"), png);
    expect(await f.runtime.call("view_image", { workspace_id: workspace.id, path: "image.jpg" }))
      .toMatchObject({ mimeType: "image/png" });
    for (const [filename, bytes, mimeType] of [
      ["picture", Buffer.from("ffd8ffe000", "hex"), "image/jpeg"],
      ["animation", Buffer.from("GIF89a000000", "ascii"), "image/gif"],
      ["web-capture", Buffer.from("RIFF0000WEBP", "ascii"), "image/webp"],
    ] as const) {
      writeFileSync(join(f.root, filename), bytes);
      expect(await f.runtime.call("view_image", { workspace_id: workspace.id, path: filename }))
        .toMatchObject({ mimeType });
    }
    writeFileSync(join(f.root, "wrong.png"), "not an image");
    await expect(f.runtime.call("view_image", { workspace_id: workspace.id, path: "wrong.png" })).rejects.toThrow("unsupported");
  } finally {
    await f.runtime.close();
    removeFixture(f.base);
  }
});
