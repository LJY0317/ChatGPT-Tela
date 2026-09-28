import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { readCanonicalCurrentTurn } from "./rollout";

async function writeRollout(records: readonly unknown[]): Promise<{ path: string; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "chatgpt-tela-rollout-"));
  const path = join(cwd, "rollout.jsonl");
  await writeFile(path, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
  return { path, cwd };
}

function fullAccessContext(turnId: string, cwd: string): unknown {
  return {
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd,
      workspace_roots: [cwd],
      sandbox_policy: { type: "danger-full-access" },
      permission_profile: { type: "disabled" },
      file_system_sandbox_policy: { kind: "unrestricted" },
    },
  };
}

function restrictedContext(
  turnId: string,
  cwd: string,
  input: {
    readonly sandboxType?: "read-only" | "workspace-write";
    readonly profileNetwork?: "enabled" | "restricted";
    readonly legacyNetworkAccess?: boolean;
    readonly splitFileSystemPolicy?: "restricted" | null;
  } = {},
): unknown {
  const sandboxType = input.sandboxType ?? "read-only";
  return {
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd,
      workspace_roots: [cwd],
      sandbox_policy: {
        type: sandboxType,
        ...(input.legacyNetworkAccess !== undefined
          ? { network_access: input.legacyNetworkAccess }
          : {}),
      },
      permission_profile: {
        type: "managed",
        file_system: { type: "restricted", entries: [] },
        ...(input.profileNetwork ? { network: input.profileNetwork } : {}),
      },
      file_system_sandbox_policy: input.splitFileSystemPolicy === null
        ? null
        : { kind: input.splitFileSystemPolicy ?? "restricted" },
    },
  };
}

describe("canonical Codex rollout authority", () => {
  test("uses an exact current turn_context when available", async () => {
    const seed = await mkdtemp(join(tmpdir(), "chatgpt-tela-rollout-cwd-"));
    const fixture = await writeRollout([
      { type: "session_meta", payload: { id: "thread-1", source: "cli" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      fullAccessContext("turn-1", seed),
    ]);

    const evidence = await readCanonicalCurrentTurn(fixture.path, "thread-1");
    expect(evidence.turnId).toBe("turn-1");
    expect(evidence.cwd).toBe(seed);
    expect(evidence.proof).toBe("turn-context");
    expect(evidence.environmentSourceTurnId).toBe("turn-1");
  });

  test("uses the latest prior canonical environment during the task_started/context gap", async () => {
    const seed = await mkdtemp(join(tmpdir(), "chatgpt-tela-rollout-cwd-"));
    const fixture = await writeRollout([
      { type: "session_meta", payload: { id: "thread-1", source: "cli" } },
      fullAccessContext("turn-old", seed),
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-new" } },
    ]);

    const evidence = await readCanonicalCurrentTurn(fixture.path, "thread-1");
    expect(evidence.turnId).toBe("turn-new");
    expect(evidence.cwd).toBe(seed);
    expect(evidence.proof).toBe("current-task-inherited-context");
    expect(evidence.environmentSourceTurnId).toBe("turn-old");
  });

  test("fails closed when a post-boundary context belongs to a different turn", async () => {
    const seed = await mkdtemp(join(tmpdir(), "chatgpt-tela-rollout-cwd-"));
    const fixture = await writeRollout([
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-new" } },
      fullAccessContext("turn-other", seed),
    ]);

    await expect(readCanonicalCurrentTurn(fixture.path, "thread-1"))
      .rejects.toThrow("conflicts with the current task");
  });

  test("authenticates child lineage from canonical session metadata", async () => {
    const seed = await mkdtemp(join(tmpdir(), "chatgpt-tela-rollout-cwd-"));
    const fixture = await writeRollout([
      {
        type: "session_meta",
        payload: { id: "child-1", parent_thread_id: "parent-1", agent_path: "/root/reviewer" },
      },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      fullAccessContext("turn-1", seed),
    ]);

    const evidence = await readCanonicalCurrentTurn(fixture.path, "child-1");
    expect(evidence.parentThreadId).toBe("parent-1");
    expect(evidence.agentName).toBe("/root/reviewer");
  });

  test("reads current Codex managed network authority from permission_profile", async () => {
    const seed = await mkdtemp(join(tmpdir(), "chatgpt-tela-rollout-cwd-"));
    const fixture = await writeRollout([
      { type: "session_meta", payload: { id: "thread-1", source: "cli" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      restrictedContext("turn-1", seed, { profileNetwork: "restricted" }),
    ]);

    const evidence = await readCanonicalCurrentTurn(fixture.path, "thread-1");
    expect(evidence.sandbox).toEqual({ kind: "read-only", network: "restricted" });
  });

  test("accepts current Codex managed authority when the legacy split filesystem policy is null", async () => {
    const seed = await mkdtemp(join(tmpdir(), "chatgpt-tela-rollout-cwd-"));
    const fixture = await writeRollout([
      { type: "session_meta", payload: { id: "thread-1", source: "exec" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      restrictedContext("turn-1", seed, {
        profileNetwork: "restricted",
        splitFileSystemPolicy: null,
      }),
    ]);

    const evidence = await readCanonicalCurrentTurn(fixture.path, "thread-1");
    expect(evidence.sandbox).toEqual({ kind: "read-only", network: "restricted" });
  });

  test("keeps legacy sandbox network_access compatible while rejecting mixed-policy disagreement", async () => {
    const seed = await mkdtemp(join(tmpdir(), "chatgpt-tela-rollout-cwd-"));
    const compatible = await writeRollout([
      { type: "session_meta", payload: { id: "thread-1", source: "cli" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      restrictedContext("turn-1", seed, { legacyNetworkAccess: false }),
    ]);
    expect((await readCanonicalCurrentTurn(compatible.path, "thread-1")).sandbox)
      .toEqual({ kind: "read-only", network: "restricted" });

    const conflicting = await writeRollout([
      { type: "session_meta", payload: { id: "thread-1", source: "cli" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      restrictedContext("turn-1", seed, {
        profileNetwork: "enabled",
        legacyNetworkAccess: false,
      }),
    ]);
    await expect(readCanonicalCurrentTurn(conflicting.path, "thread-1"))
      .rejects.toThrow("network policy is inconsistent");
  });
});
