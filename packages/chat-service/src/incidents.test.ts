import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatIncidentStore, chatWorkspaceFingerprint } from "./incidents";

describe("Tela Chat privacy-safe incidents", () => {
  test("stores only fixed failure metadata and an opaque workspace fingerprint", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-chat-incidents-"));
    try {
      const store = new ChatIncidentStore({ root });
      const workspaceId = "chatws_private-fixture";
      const record = store.captureFailure({
        capability: "exec_command",
        workspaceId,
        error: new Error("secret command /Users/private/project --token super-secret"),
      });
      expect(record).toMatchObject({ capability: "exec_command", category: "failed",
        workspaceFingerprint: chatWorkspaceFingerprint(workspaceId) });
      const raw = readFileSync(join(root, `${record.incidentRef}.json`), "utf8");
      expect(raw).not.toContain(workspaceId);
      expect(raw).not.toContain("/Users/private/project");
      expect(raw).not.toContain("super-secret");
      expect(store.list(workspaceId)).toEqual([{
        incidentRef: record.incidentRef,
        observedAt: record.observedAt,
        capability: "exec_command",
        category: "failed",
      }]);
      expect(store.read(workspaceId, record.incidentRef)).toEqual(store.list(workspaceId)[0]!);
      expect(() => store.read("chatws_other", record.incidentRef)).toThrow("unknown Tela Chat incident");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retention stays bounded per workspace and globally", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-chat-incidents-bound-"));
    try {
      const store = new ChatIncidentStore({ root });
      for (let i = 0; i < 40; i += 1) {
        store.captureFailure({ capability: "read", workspaceId: "chatws_one", error: new Error(`raw-${i}`) });
      }
      expect(store.list("chatws_one", 100)).toHaveLength(32);
      for (let i = 0; i < 120; i += 1) {
        store.captureFailure({ capability: "read", workspaceId: `chatws_${i + 10}`, error: new Error("raw") });
      }
      expect(readdirSync(root).filter(name => name.endsWith(".json")).length).toBeLessThanOrEqual(128);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
