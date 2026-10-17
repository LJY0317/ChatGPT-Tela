import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatToolRuntime } from "./tools";

const THREAD = "11111111-2222-7333-8444-555555555555";

test("one discovered bounded read capability replaces arbitrary Bun command for Native Work inspection", async () => {
  const base = mkdtempSync(join(tmpdir(), "tela-chat-inspect-"));
  const root = join(base, "workspace"); mkdirSync(root);
  const requests: unknown[] = [];
  const runtime = createChatToolRuntime({
    allowedRoots: [root], stateRoot: join(base, "state"),
    inspectNativeWork: async request => {
      requests.push(request);
      return Object.freeze({ status: "read_only", ownerProven: true, agentMayApprove: false,
        observedAt: "2026-10-17T00:00:00Z" });
    },
  });
  const withoutPeer = createChatToolRuntime({ allowedRoots: [root], stateRoot: join(base, "independent") });
  try {
    expect(runtime.capabilities).toContain("inspect_native_work");
    expect(withoutPeer.capabilities).not.toContain("inspect_native_work");
    const opened = runtime.workspaces.open(root);
    const result = await runtime.call("inspect_native_work", {
      workspace_id: opened.id, thread_id: THREAD, slot: 2, minutes: 15,
      cmd: "NEVER_EXECUTE_THIS_UNREVIEWED_COMMAND",
    });
    expect(result).toMatchObject({ status: "read_only", ownerProven: true, agentMayApprove: false });
    expect(requests).toEqual([{ slot: 2, threadId: THREAD, minutes: 15 }]);
    for (const bad of [
      { workspace_id: "foreign", thread_id: THREAD },
      { workspace_id: opened.id, thread_id: "not-an-id" },
      { workspace_id: opened.id, thread_id: THREAD, slot: 100 },
      { workspace_id: opened.id, thread_id: THREAD, minutes: 0 },
    ]) {
      await expect(runtime.call("inspect_native_work", bad)).rejects.toThrow();
    }
    expect(requests).toHaveLength(1);
    await expect(withoutPeer.call("inspect_native_work", {
      workspace_id: opened.id, thread_id: THREAD,
    })).rejects.toThrow("unavailable");
  } finally { await runtime.close(); await withoutPeer.close(); rmSync(base, { recursive: true, force: true }); }
});
