import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatReviewCheckpointStore } from "./reviews";
import { compareChatReviewRecords } from "./review-diff";
import { createChatToolRuntime } from "./tools";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function objectCount(cwd: string): number {
  const lines = git(cwd, ["count-objects", "-v"]).split(/\r?\n/);
  const value = (name: string): number => {
    const line = lines.find(item => item.startsWith(`${name}: `));
    return Number(line?.slice(`${name}: `.length) ?? "0");
  };
  // Git may auto-pack loose objects between observations (notably on Linux CI). Review capture must
  // not create repository objects, but packing an existing object must not look like object loss.
  return value("count") + value("in-pack");
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tela-chat-review-"));
  const root = join(base, "project");
  const stateRoot = join(base, "state");
  mkdirSync(root);
  git(root, ["init"]);
  git(root, ["config", "user.email", "tela@example.invalid"]);
  git(root, ["config", "user.name", "Tela Test"]);
  writeFileSync(join(root, "README.md"), "hello\nworld\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "Initial"]);
  const runtime = createChatToolRuntime({ allowedRoots: [root], stateRoot });
  return { base, root, stateRoot, runtime };
}

describe("Tela Chat historical review checkpoints", () => {
  test("private review comparison reconstructs two checkpoints without writing Git objects into the user repository", async () => {
    const f = fixture();
    try {
      const objectsBefore = objectCount(f.root);
      const head = git(f.root, ["rev-parse", "HEAD"]);
      const canonicalRoot = realpathSync(f.root);
      const store = new ChatReviewCheckpointStore({ root: join(f.stateRoot, "review-diff-fixture") });
      const before = store.capture({
        workspaceId: "workspace-review-diff",
        workspaceRoot: canonicalRoot,
        head,
        status: "",
        patch: "",
        untrackedPaths: [],
      });
      writeFileSync(join(f.root, "README.md"), "hello\ntela\n");
      writeFileSync(join(f.root, "notes.txt"), "first note\n");
      const after = store.capture({
        workspaceId: "workspace-review-diff",
        workspaceRoot: canonicalRoot,
        head,
        status: " M README.md\n?? notes.txt\n",
        patch: execFileSync("git", ["diff", "--binary", "HEAD", "--", "."], { cwd: f.root, encoding: "utf8" }),
        untrackedPaths: ["notes.txt"],
      });
      const delta = await compareChatReviewRecords({
        workspaceRoot: canonicalRoot,
        scratchRoot: join(f.stateRoot, "review-comparison-scratch"),
        before,
        after,
      });
      expect(delta.summary).toEqual({
        files: 2,
        additions: 2,
        removals: 1,
        trackedFiles: 1,
        untrackedFiles: 1,
        complete: true,
      });
      expect(delta.patch).toContain("+tela");
      expect(delta.patch).toContain("+first note");
      expect(delta.files.map(file => file.path)).toEqual(["README.md", "notes.txt"]);
      expect(objectCount(f.root)).toBe(objectsBefore);
    } finally {
      await f.runtime.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("show_changes returns a durable review ref that reopens the exact old snapshot after later edits and restart", async () => {
    const f = fixture();
    try {
      const objectsBefore = objectCount(f.root);
      const workspace = await f.runtime.call("open_workspace", { path: f.root }) as {
        id: string;
        reviewBaseline: { available: boolean; reviewRef?: string; openReviewRef?: string; reused?: boolean };
      };
      expect(workspace.reviewBaseline).toMatchObject({ available: true, reused: false });
      expect(workspace.reviewBaseline.openReviewRef).toBe(workspace.reviewBaseline.reviewRef);
      await f.runtime.call("apply_patch", {
        workspace_id: workspace.id,
        patch: `*** Begin Patch\n*** Update File: README.md\n@@\n hello\n-world\n+tela\n*** Add File: notes.txt\n+first note\n*** End Patch`,
      });
      const shown = await f.runtime.call("show_changes", { workspace_id: workspace.id }) as {
        reviewRef?: string;
        reviewCheckpoint: { available: boolean; reviewRef?: string };
        summary: { files: number; additions: number; removals: number; trackedFiles: number; untrackedFiles: number; complete: boolean };
        reviewDelta: { available: boolean; patch?: string; summary?: { files: number; additions: number; removals: number } };
      };
      expect(shown.reviewCheckpoint.available).toBe(true);
      expect(shown.reviewRef).toMatch(/^chatreview_/);
      expect(shown.summary).toEqual({
        files: 2,
        additions: 2,
        removals: 1,
        trackedFiles: 1,
        untrackedFiles: 1,
        complete: true,
      });
      expect(shown.reviewDelta).toMatchObject({
        available: true,
        summary: { files: 2, additions: 2, removals: 1 },
      });
      expect(shown.reviewDelta.patch).toContain("+tela");
      const reviewRef = shown.reviewRef!;

      await f.runtime.call("apply_patch", {
        workspace_id: workspace.id,
        patch: `*** Begin Patch\n*** Update File: README.md\n@@\n hello\n-tela\n+later\n*** Update File: notes.txt\n@@\n-first note\n+later note\n*** End Patch`,
      });
      const secondShown = await f.runtime.call("show_changes", { workspace_id: workspace.id }) as {
        reviewRef?: string;
        reviewDelta: { available: boolean; patch?: string; summary?: { files: number; additions: number; removals: number } };
      };
      expect(secondShown.reviewDelta).toMatchObject({
        available: true,
        summary: { files: 2, additions: 2, removals: 2 },
      });
      expect(secondShown.reviewDelta.patch).toContain("-tela");
      expect(secondShown.reviewDelta.patch).toContain("+later");
      expect(secondShown.reviewDelta.patch).toContain("-first note");
      expect(secondShown.reviewDelta.patch).toContain("+later note");
      expect(secondShown.reviewDelta.patch).not.toContain("-world");
      const fromOpen = await f.runtime.call("show_changes", {
        workspace_id: workspace.id,
        since: "workspace_open",
        mark_reviewed: false,
      }) as {
        reviewDelta: { available: boolean; since?: string; patch?: string; summary?: { files: number; additions: number; removals: number } };
      };
      expect(fromOpen.reviewDelta).toMatchObject({
        available: true,
        since: "workspace_open",
        summary: { files: 2, additions: 2, removals: 1 },
      });
      expect(fromOpen.reviewDelta.patch).toContain("-world");
      expect(fromOpen.reviewDelta.patch).toContain("+later");
      expect(fromOpen.reviewDelta.patch).toContain("+later note");
      const historical = await f.runtime.call("show_review", {
        workspace_id: workspace.id,
        review_ref: reviewRef,
      }) as {
        historical: boolean;
        patch: string;
        untracked: readonly { path: string; encoding: string; content: string }[];
        summary: { files: number; additions: number; removals: number; trackedFiles: number; untrackedFiles: number; complete: boolean };
      };
      expect(historical.historical).toBe(true);
      expect(historical.summary).toEqual(shown.summary);
      expect(historical.patch).toContain("+tela");
      expect(historical.patch).not.toContain("+later");
      expect(historical.untracked.find(item => item.path === "notes.txt"))
        .toMatchObject({ encoding: "utf8", content: "first note\n" });
      expect(git(f.root, ["for-each-ref", "--format=%(refname)", "refs/chatgpt-tela"])).toBe("");
      expect(objectCount(f.root)).toBe(objectsBefore);

      await f.runtime.close();
      const reopened = createChatToolRuntime({ allowedRoots: [f.root], stateRoot: f.stateRoot });
      try {
        await reopened.initialize();
        await reopened.call("apply_patch", {
          workspace_id: workspace.id,
          patch: `*** Begin Patch\n*** Update File: README.md\n@@\n hello\n-later\n+after restart\n*** End Patch`,
        });
        const afterRestartDelta = await reopened.call("show_changes", { workspace_id: workspace.id }) as {
          reviewDelta: { available: boolean; patch?: string; summary?: { files: number; additions: number; removals: number } };
        };
        expect(afterRestartDelta.reviewDelta).toMatchObject({
          available: true,
          summary: { files: 1, additions: 1, removals: 1 },
        });
        expect(afterRestartDelta.reviewDelta.patch).toContain("-later");
        expect(afterRestartDelta.reviewDelta.patch).toContain("+after restart");
        const afterRestart = await reopened.call("show_review", {
          workspace_id: workspace.id,
          review_ref: reviewRef,
        }) as { patch: string; historical: boolean };
        expect(afterRestart.historical).toBe(true);
        expect(afterRestart.patch).toContain("+tela");
        const listed = await reopened.call("list_reviews", { workspace_id: workspace.id }) as readonly { reviewRef: string }[];
        expect(listed.map(item => item.reviewRef)).toContain(reviewRef);
      } finally {
        await reopened.close();
      }
    } finally {
      await f.runtime.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("review history is bounded to the newest sixteen checkpoints per workspace", async () => {
    const f = fixture();
    try {
      const workspaceId = "workspace-retention-fixture";
      const store = new ChatReviewCheckpointStore({ root: join(f.stateRoot, "review-checkpoints-retention") });
      for (let index = 0; index < 18; index += 1) {
        store.capture({
          workspaceId,
          workspaceRoot: f.root,
          status: "",
          patch: `checkpoint-${index}`,
          untrackedPaths: [],
        });
      }
      const listed = store.list(workspaceId);
      expect(listed.length).toBe(16);
    } finally {
      await f.runtime.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("review retention preserves the private open and last-shown baselines inside the normal bound", async () => {
    const f = fixture();
    try {
      const workspaceId = "workspace-baseline-retention";
      const root = realpathSync(f.root);
      const store = new ChatReviewCheckpointStore({ root: join(f.stateRoot, "review-baseline-retention") });
      const open = store.capture({
        workspaceId,
        workspaceRoot: root,
        status: "",
        patch: "",
        untrackedPaths: [],
      });
      store.setBaseline(workspaceId, open.reviewRef);
      let latest = open;
      for (let index = 0; index < 20; index += 1) {
        latest = store.capture({
          workspaceId,
          workspaceRoot: root,
          status: "",
          patch: `checkpoint-${index}`,
          untrackedPaths: [],
        });
        store.setBaseline(workspaceId, latest.reviewRef);
      }
      expect(store.list(workspaceId)).toHaveLength(16);
      expect(store.openBaselineRef(workspaceId)).toBe(open.reviewRef);
      expect(store.baselineRef(workspaceId)).toBe(latest.reviewRef);
      expect(store.read(workspaceId, open.reviewRef).reviewRef).toBe(open.reviewRef);
      expect(store.read(workspaceId, latest.reviewRef).reviewRef).toBe(latest.reviewRef);
    } finally {
      await f.runtime.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("tracked binary changes mark compact line counts incomplete instead of inventing counts", async () => {
    const f = fixture();
    try {
      const binaryPath = join(f.root, "binary.dat");
      writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]));
      git(f.root, ["add", "binary.dat"]);
      git(f.root, ["commit", "-m", "Add binary"]);
      writeFileSync(binaryPath, Buffer.from([0, 9, 8, 7]));
      const workspace = await f.runtime.call("open_workspace", { path: f.root }) as { id: string };
      writeFileSync(binaryPath, Buffer.from([0, 5, 6, 7]));
      const shown = await f.runtime.call("show_changes", { workspace_id: workspace.id }) as {
        summary: { files: number; additions: number; removals: number; complete: boolean };
      };
      expect(shown.summary).toMatchObject({ files: 1, complete: false });
      expect(shown.summary.additions).toBe(0);
      expect(shown.summary.removals).toBe(0);
    } finally {
      await f.runtime.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  test("oversized untracked content leaves live show_changes usable but declines historical capture", async () => {
    const f = fixture();
    try {
      const workspace = await f.runtime.call("open_workspace", { path: f.root }) as { id: string };
      writeFileSync(join(f.root, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
      const shown = await f.runtime.call("show_changes", { workspace_id: workspace.id }) as {
        untracked: readonly string[];
        reviewRef?: string;
        reviewCheckpoint: { available: boolean; reason?: string };
        summary: { files: number; untrackedFiles: number; complete: boolean };
      };
      expect(shown.untracked).toContain("large.bin");
      expect(shown.reviewRef).toBeUndefined();
      expect(shown.reviewCheckpoint.available).toBe(false);
      expect(shown.reviewCheckpoint.reason).toContain("exceeds");
      expect(shown.summary).toMatchObject({ files: 1, untrackedFiles: 1, complete: false });
    } finally {
      await f.runtime.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });
});
