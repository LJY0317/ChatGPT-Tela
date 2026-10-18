import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessCompletionArchive } from "./process-completion-archive";
import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";

const removeFixture = registerTemporaryFixtureCleanup();

function setup() {
  const root = mkdtempSync(join(tmpdir(), "tela-completion-archive-"));
  const path = join(root, "archive.sqlite");
  const key = "a".repeat(64);
  const archive = new ProcessCompletionArchive(path, key, 3);
  const make = (sessionId: number, state = "exited") => ({
    operationId: randomUUID(), workspaceId: "synthetic-workspace",
    sessionId, state, updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return { root, path, key, archive, make };
}

describe("separate authenticated completion archive", () => {
  test("preserves exact terminal operation identity and rejects changed replay", () => {
    const f = setup();
    try {
      const operation = f.make(41);
      f.archive.save(operation);
      f.archive.save(operation);
      expect(f.archive.count()).toBe(1);
      expect(f.archive.get(operation.operationId)).toEqual(operation);
      expect(f.archive.page("synthetic-workspace", 0, 10)).toEqual([operation]);
      expect(() => f.archive.save({ ...operation, state: "signaled" })).toThrow("changed");
      expect(() => f.archive.save(f.make(42, "unknown"))).toThrow("unresolved");
      f.archive.close();
      const reopened = new ProcessCompletionArchive(f.path, f.key, 3);
      try { expect(reopened.get(operation.operationId)).toEqual(operation); }
      finally { reopened.close(); }
    } finally { removeFixture(f.root); }
  });

  test("refuses silent eviction of recent terminal deduplication evidence", () => {
    const f = setup();
    try {
      for (let i = 1; i <= 3; i++) f.archive.save(f.make(i));
      expect(() => f.archive.save(f.make(4))).toThrow("capacity");
      expect(f.archive.count()).toBe(3);
    } finally { f.archive.close(); removeFixture(f.root); }
  });

  test("atomic bulk promotion publishes all verified identities or none", () => {
    const f = setup();
    try {
      const first = f.make(1), second = f.make(2);
      f.archive.saveMany([first, second]);
      f.archive.saveMany([first, second]);
      expect(f.archive.count()).toBe(2);
      expect(f.archive.getBySessionId(1)).toEqual(first);
      expect(f.archive.getBySessionId(2)).toEqual(second);
      expect(() => f.archive.saveMany([f.make(3), f.make(4)])).toThrow("capacity");
      expect(f.archive.count()).toBe(2);
      expect(() => f.archive.saveMany([first, { ...second, state: "signaled" }]))
        .toThrow("changed");
      expect(f.archive.get(second.operationId)).toEqual(second);
      expect(() => f.archive.saveMany([f.make(3), f.make(4, "unknown")]))
        .toThrow("unresolved");
      expect(f.archive.count()).toBe(2);
    } finally { f.archive.close(); removeFixture(f.root); }
  });

});
