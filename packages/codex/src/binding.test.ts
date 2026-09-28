import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  RolloutFileCurrentTurnSource,
  bindNativeTurnRequest,
  type CanonicalCurrentTurnSource,
} from "./binding";

function request(threadId: string, turnId: string, extraMetadata: Record<string, unknown> = {}): unknown {
  return {
    client_metadata: {
      "x-codex-turn-metadata": {
        request_kind: "turn",
        thread_id: threadId,
        turn_id: turnId,
        cwd: "/request/claim/must/not/grant/authority",
        ...extraMetadata,
      },
    },
    tools: [{
      type: "function",
      name: "brand_new_tool",
      description: "runtime discovered",
      parameters: { type: "object" },
    }],
  };
}

async function rolloutFixture(threadId: string, turnId: string): Promise<{ path: string; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "chatgpt-tela-codex-binding-"));
  const path = join(cwd, "rollout.jsonl");
  const records = [
    { type: "session_meta", payload: { id: threadId, source: "cli" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    {
      type: "turn_context",
      payload: {
        turn_id: turnId,
        cwd,
        workspace_roots: [cwd],
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
        file_system_sandbox_policy: { kind: "unrestricted" },
      },
    },
  ];
  await writeFile(path, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
  return { path, cwd };
}

describe("native current-turn binding", () => {
  test("binds tools only after canonical rollout proves the exact current turn", async () => {
    const fixture = await rolloutFixture("thread-1", "turn-1");
    const source = new RolloutFileCurrentTurnSource(threadId => (
      threadId === "thread-1" ? fixture.path : undefined
    ));

    const binding = await bindNativeTurnRequest(request("thread-1", "turn-1"), source);
    expect(binding.authority.source).toBe("native-current-turn");
    expect(binding.authority.cwd).toBe(fixture.cwd);
    expect(binding.authority.sandbox).toEqual({ kind: "danger-full-access" });
    expect(binding.tools.exact("brand_new_tool")?.name).toBe("brand_new_tool");
  });

  test("rejects a stale requested turn even when the thread is valid", async () => {
    const source: CanonicalCurrentTurnSource = {
      async currentTurn(threadId) {
        return {
          threadId,
          turnId: "turn-current",
          cwd: "/workspace",
          workspaceRoots: ["/workspace"],
          sandbox: { kind: "read-only", network: "restricted" },
          proof: "turn-context",
          environmentSourceTurnId: "turn-current",
        };
      },
    };

    await expect(bindNativeTurnRequest(request("thread-1", "turn-stale"), source))
      .rejects.toThrow("does not name the canonical current turn");
  });

  test("rejects a root request when canonical state proves a child thread", async () => {
    const source: CanonicalCurrentTurnSource = {
      async currentTurn(threadId) {
        return {
          threadId,
          turnId: "turn-1",
          parentThreadId: "parent-1",
          agentName: "/root/reviewer",
          cwd: "/workspace",
          workspaceRoots: ["/workspace"],
          sandbox: { kind: "read-only", network: "restricted" },
          proof: "turn-context",
          environmentSourceTurnId: "turn-1",
        };
      },
    };

    await expect(bindNativeTurnRequest(request("child-1", "turn-1"), source))
      .rejects.toThrow("lineage does not match");
  });

  test("accepts current Codex root sentinel only for a canonical root thread", async () => {
    const source: CanonicalCurrentTurnSource = {
      async currentTurn(threadId) {
        return {
          threadId,
          turnId: "turn-1",
          cwd: "/workspace",
          workspaceRoots: ["/workspace"],
          sandbox: { kind: "read-only", network: "restricted" },
          proof: "turn-context",
          environmentSourceTurnId: "turn-1",
        };
      },
    };

    const binding = await bindNativeTurnRequest(request("thread-1", "turn-1", {
      agent_name: "/root",
    }), source);
    expect(binding.claim.agentName).toBe("/root");
    expect(binding.canonicalEvidence.agentName).toBeUndefined();
  });

  test("root sentinel never authorizes a canonical child agent", async () => {
    const source: CanonicalCurrentTurnSource = {
      async currentTurn(threadId) {
        return {
          threadId,
          turnId: "turn-1",
          parentThreadId: "parent-1",
          agentName: "/root/reviewer",
          cwd: "/workspace",
          workspaceRoots: ["/workspace"],
          sandbox: { kind: "read-only", network: "restricted" },
          proof: "turn-context",
          environmentSourceTurnId: "turn-1",
        };
      },
    };

    await expect(bindNativeTurnRequest(request("child-1", "turn-1", {
      parent_thread_id: "parent-1",
      agent_name: "/root",
    }), source)).rejects.toThrow("agent identity does not match");
  });
});
