import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CodexHomeCurrentTurnSource } from "./source";

async function writeCanonicalRollout(
  codexHome: string,
  threadId: string,
  turnId: string,
  suffix = "",
): Promise<string> {
  const directory = join(codexHome, "sessions", "2026", "09", "26");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-09-26T12-00-00-${threadId}${suffix}.jsonl`);
  const records = [
    { type: "session_meta", payload: { id: threadId, source: "cli" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    {
      type: "turn_context",
      payload: {
        turn_id: turnId,
        cwd: codexHome,
        workspace_roots: [codexHome],
        sandbox_policy: { type: "danger-full-access" },
        permission_profile: { type: "disabled" },
      },
    },
  ];
  await writeFile(path, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
  return path;
}

describe("Codex home current-turn source", () => {
  test("falls back to one unambiguous live sessions rollout when no index exists", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "chatgpt-tela-codex-home-"));
    await writeCanonicalRollout(codexHome, "thread-1", "turn-1");

    const evidence = await new CodexHomeCurrentTurnSource({ codexHome }).currentTurn("thread-1");
    expect(evidence?.turnId).toBe("turn-1");
    expect(evidence?.cwd).toBe(codexHome);
  });

  test("uses the state index to select one rollout when history makes filename lookup ambiguous", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "chatgpt-tela-codex-home-"));
    const current = await writeCanonicalRollout(codexHome, "thread-1", "turn-current", "_current");
    await writeCanonicalRollout(codexHome, "thread-1", "turn-old", "_old");

    const database = new DatabaseSync(join(codexHome, "state_5.sqlite"));
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    database.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run("thread-1", current);
    database.close();

    const evidence = await new CodexHomeCurrentTurnSource({ codexHome }).currentTurn("thread-1");
    expect(evidence?.turnId).toBe("turn-current");
  });

  test("fails closed on multiple unindexed live rollouts", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "chatgpt-tela-codex-home-"));
    await writeCanonicalRollout(codexHome, "thread-1", "turn-1", "_a");
    await writeCanonicalRollout(codexHome, "thread-1", "turn-2", "_b");

    await expect(new CodexHomeCurrentTurnSource({ codexHome }).currentTurn("thread-1"))
      .rejects.toThrow("multiple canonical rollouts");
  });

  test("an indexed path cannot escape the live sessions tree", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "chatgpt-tela-codex-home-"));
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    const outside = join(codexHome, `rollout-2026-09-26T12-00-00-thread-1.jsonl`);
    await writeFile(outside, "{}\n");

    const database = new DatabaseSync(join(codexHome, "state_5.sqlite"));
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    database.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run("thread-1", outside);
    database.close();

    await expect(new CodexHomeCurrentTurnSource({ codexHome }).currentTurn("thread-1"))
      .rejects.toThrow("escapes the sessions directory");
  });
});
