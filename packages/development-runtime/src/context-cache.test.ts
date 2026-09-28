import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FileContextCheckpointCache } from "./context-cache";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "chatgpt-tela-context-cache-test-"));
}

describe("persistent derived context checkpoint cache", () => {
  test("survives a new cache instance without storing raw Native task ids in filenames", async () => {
    const root = scratch();
    try {
      const first = new FileContextCheckpointCache({ directory: root });
      const stored = await first.put({
        nativeTaskId: "thread-sensitive-123",
        revisionId: "revision-1",
        content: "compact semantic projection",
        estimatedTokens: 7,
      });
      const files = readdirSync(root);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
      expect(files[0]).not.toContain("thread-sensitive-123");

      const reopened = new FileContextCheckpointCache({ directory: root });
      expect(await reopened.list("thread-sensitive-123")).toEqual([stored]);
      expect(await reopened.list("different-thread")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("corrupt derived state degrades to an empty cache instead of becoming correctness authority", async () => {
    const root = scratch();
    try {
      const cache = new FileContextCheckpointCache({ directory: root });
      await cache.put({
        nativeTaskId: "thread-1",
        revisionId: "revision-1",
        content: "checkpoint",
        estimatedTokens: 3,
      });
      const [file] = readdirSync(root);
      if (!file) throw new Error("fixture cache file missing");
      writeFileSync(join(root, file), "{corrupt-json", "utf8");

      expect(await cache.list("thread-1")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("token-estimate tampering invalidates the derived checkpoint instead of changing budget policy", async () => {
    const root = scratch();
    try {
      const cache = new FileContextCheckpointCache({ directory: root });
      await cache.put({
        nativeTaskId: "thread-1",
        revisionId: "revision-1",
        content: "checkpoint",
        estimatedTokens: 30,
      });
      const [file] = readdirSync(root);
      if (!file) throw new Error("fixture cache file missing");
      const path = join(root, file);
      const stored = JSON.parse(readFileSync(path, "utf8")) as {
        checkpoints: Array<{ estimatedTokens: number }>;
      };
      if (!stored.checkpoints[0]) throw new Error("fixture checkpoint missing");
      stored.checkpoints[0].estimatedTokens = 1;
      writeFileSync(path, `${JSON.stringify(stored)}\n`, "utf8");

      expect(await cache.list("thread-1")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retention is bounded and deterministic per Native task", async () => {
    const root = scratch();
    try {
      const cache = new FileContextCheckpointCache({
        directory: root,
        maxCheckpointsPerTask: 2,
      });
      const first = await cache.put({
        nativeTaskId: "thread-1",
        revisionId: "revision-1",
        content: "one",
        estimatedTokens: 1,
      });
      const second = await cache.put({
        nativeTaskId: "thread-1",
        revisionId: "revision-2",
        content: "two",
        estimatedTokens: 1,
      });
      const third = await cache.put({
        nativeTaskId: "thread-1",
        revisionId: "revision-3",
        content: "three",
        estimatedTokens: 1,
      });

      expect(await cache.list("thread-1")).toEqual([second, third]);
      expect(await cache.list("thread-1")).not.toContain(first);
      await cache.clear("thread-1");
      expect(await cache.list("thread-1")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
