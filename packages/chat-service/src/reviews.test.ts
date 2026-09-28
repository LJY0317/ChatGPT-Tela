import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatReviewCheckpointStore } from "./reviews";
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
  test("show_changes returns a durable review ref that reopens the exact old snapshot after later edits and restart", async () => {
    const f = fixture();
    try {
      const objectsBefore = objectCount(f.root);
      const workspace = await f.runtime.call("open_workspace", { path: f.root }) as { id: string };
      await f.runtime.call("apply_patch", {
        workspace_id: workspace.id,
        patch: `*** Begin Patch\n*** Update File: README.md\n@@\n hello\n-world\n+tela\n*** Add File: notes.txt\n+first note\n*** End Patch`,
      });
      const shown = await f.runtime.call("show_changes", { workspace_id: workspace.id }) as {
        reviewRef?: string;
        reviewCheckpoint: { available: boolean; reviewRef?: string };
      };
      expect(shown.reviewCheckpoint.available).toBe(true);
      expect(shown.reviewRef).toMatch(/^chatreview_/);
      const reviewRef = shown.reviewRef!;

      await f.runtime.call("apply_patch", {
        workspace_id: workspace.id,
        patch: `*** Begin Patch\n*** Update File: README.md\n@@\n hello\n-tela\n+later\n*** Update File: notes.txt\n@@\n-first note\n+later note\n*** End Patch`,
      });
      const historical = await f.runtime.call("show_review", {
        workspace_id: workspace.id,
        review_ref: reviewRef,
      }) as {
        historical: boolean;
        patch: string;
        untracked: readonly { path: string; encoding: string; content: string }[];
      };
      expect(historical.historical).toBe(true);
      expect(historical.patch).toContain("+tela");
      expect(historical.patch).not.toContain("+later");
      expect(historical.untracked.find(item => item.path === "notes.txt"))
        .toMatchObject({ encoding: "utf8", content: "first note\n" });
      expect(git(f.root, ["for-each-ref", "--format=%(refname)", "refs/chatgpt-tela"])).toBe("");
      expect(objectCount(f.root)).toBe(objectsBefore);

      await f.runtime.close();
      const reopened = createChatToolRuntime({ allowedRoots: [f.root], stateRoot: f.stateRoot });
      try {
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

  test("oversized untracked content leaves live show_changes usable but declines historical capture", async () => {
    const f = fixture();
    try {
      const workspace = await f.runtime.call("open_workspace", { path: f.root }) as { id: string };
      writeFileSync(join(f.root, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
      const shown = await f.runtime.call("show_changes", { workspace_id: workspace.id }) as {
        untracked: readonly string[];
        reviewRef?: string;
        reviewCheckpoint: { available: boolean; reason?: string };
      };
      expect(shown.untracked).toContain("large.bin");
      expect(shown.reviewRef).toBeUndefined();
      expect(shown.reviewCheckpoint.available).toBe(false);
      expect(shown.reviewCheckpoint.reason).toContain("exceeds");
    } finally {
      await f.runtime.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });
});
