import {
  mkdirSync,
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
  test("oversized or corrupt cache entries cannot allocate unbounded derived checkpoint state", async () => {
    const root = scratch();
    try {
      const cache = new FileContextCheckpointCache({ directory: root });
      await expect(cache.put({
        nativeTaskId: "thread-1", revisionId: "revision",
        content: "x".repeat(41 * 1024), estimatedTokens: 11000,
      })).rejects.toThrow("bounded derived-cache limit");
      expect(await cache.list("thread-1")).toEqual([]);
      await cache.put({
        nativeTaskId: "thread-1", revisionId: "small", content: "valid", estimatedTokens: 2,
      });
      const [file] = readdirSync(root);
      if (!file) throw new Error("fixture cache missing");
      writeFileSync(join(root, file), "x".repeat(600 * 1024));
      expect(await cache.list("thread-1")).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
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

  test("concurrent checkpoints for one Native task retain all bounded revisions across cache instances", async () => {
    const root = scratch();
    try {
      const first = new FileContextCheckpointCache({ directory: root });
      const second = new FileContextCheckpointCache({ directory: root });
      const inputs = Array.from({ length: 8 }, (_, index) => ({
        nativeTaskId: "thread-concurrent",
        revisionId: `revision-${index}`,
        content: `independent verified checkpoint ${index}`,
        estimatedTokens: index + 1,
      }));
      const stored = await Promise.all(inputs.map((entry, index) =>
        (index % 2 ? first : second).put(entry)));
      const reloaded = new FileContextCheckpointCache({ directory: root });
      expect(await reloaded.list("thread-concurrent")).toEqual(stored);
      expect(await reloaded.list("unrelated-thread")).toEqual([]);
      expect(readdirSync(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clear is ordered after queued checkpoint writes and prevents stale resurrection", async () => {
    const root = scratch();
    try {
      const first = new FileContextCheckpointCache({ directory: root });
      const second = new FileContextCheckpointCache({ directory: root });
      const writes = Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? first : second).put({
          nativeTaskId: "revoked-task", revisionId: `rev-${index}`,
          content: `derived state ${index}`, estimatedTokens: index + 1,
        }));
      const cleared = second.clear("revoked-task");
      await Promise.all([...writes, cleared]);
      expect(await first.list("revoked-task")).toEqual([]);
      expect(await second.list("revoked-task")).toEqual([]);
      // A new authorized source may still create an unrelated task checkpoint.
      const next = await first.put({
        nativeTaskId: "other-task", revisionId: "new-revision",
        content: "only new task evidence", estimatedTokens: 4,
      });
      expect(await second.list("other-task")).toEqual([next]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed write releases the same-task queue for a later valid checkpoint", async () => {
    const root = scratch();
    try {
      const directory = join(root, "cached");
      // A regular file in place of a directory provokes a real filesystem
      // failure after admission, not just synchronous input validation.
      writeFileSync(directory, "not a directory");
      const cache = new FileContextCheckpointCache({ directory });
      const entries = [1, 2].map(index => ({
        nativeTaskId: "thread-failing-write",
        revisionId: `revision-${index}`,
        content: `verified summary ${index}`,
        estimatedTokens: index,
      }));
      const failures = await Promise.allSettled(entries.map(entry => cache.put(entry)));
      expect(failures.map(result => result.status)).toEqual(["rejected", "rejected"]);
      rmSync(directory);
      mkdirSync(directory);
      const recovered = await cache.put(entries[1]!);
      expect(await new FileContextCheckpointCache({ directory })
        .list("thread-failing-write")).toEqual([recovered]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
