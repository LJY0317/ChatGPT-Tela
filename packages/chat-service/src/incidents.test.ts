import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
        workspaceFingerprint: chatWorkspaceFingerprint(workspaceId), reasonClass: "unknown" });
      const raw = readFileSync(join(root, `${record.incidentRef}.json`), "utf8");
      expect(raw).not.toContain(workspaceId);
      expect(raw).not.toContain("/Users/private/project");
      expect(raw).not.toContain("super-secret");
      expect(store.list(workspaceId)).toEqual([{
        incidentRef: record.incidentRef,
        observedAt: record.observedAt,
        capability: "exec_command",
        category: "failed",
        reasonClass: "unknown",
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

  test("classifies actionable failures without retaining exception content or breaking old incidents", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-chat-incidents-reasons-"));
    try {
      const store = new ChatIncidentStore({ root });
      const workspaceId = "chatws_private-fixture";
      const incident = store.captureFailure({ capability: "exec_command", workspaceId,
        error: new Error("Tela Chat process operation registry is at capacity; no process was started") });
      expect(store.read(workspaceId, incident.incidentRef).reasonClass).toBe("capacity_exhausted");
      const abort = store.captureFailure({ capability: "exec_command", workspaceId,
        error: Object.assign(new Error("file contents /Users/private"), { name: "AbortError" }) });
      expect(store.read(workspaceId, abort.incidentRef)).toMatchObject({
        reasonClass: "aborted", category: "aborted",
      });
      const legacy = store.captureFailure({ capability: "read", workspaceId,
        error: new Error("opaque private code") });
      const path = join(root, `${legacy.incidentRef}.json`);
      const older = JSON.parse(readFileSync(path, "utf8"));
      delete older.reasonClass;
      writeFileSync(path, JSON.stringify(older));
      expect(store.read(workspaceId, legacy.incidentRef).reasonClass).toBeUndefined();
      const raw = readFileSync(join(root, `${abort.incidentRef}.json`), "utf8");
      expect(raw).not.toContain("/Users/private");
      expect(raw).not.toContain("file contents");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
