import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgeNativeResult, type ResultReference } from "./result-acknowledgement";

const result: ResultReference = { parentThreadId: "parent", threadId: "child", turnId: "turn", outcome: "answer", itemId: "answer" };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tela-ack-"));
  const calls: string[] = [];
  const thread: any = { id: "child", parentThreadId: "parent", source: { subAgent: { thread_spawn: { parent_thread_id: "parent" } } } };
  const item: any = { id: "answer", type: "agentMessage", phase: "final_answer", text: "PRIVATE_FINAL_BODY" };
  const latest: any = { id: "turn", status: "failed" };
  const rpc = { async request(method: string, params?: any) {
    calls.push(method);
    if (method === "thread/read") return { thread };
    if (method === "thread/items/list") return { data: [{ turnId: params.turnId, item }], nextCursor: null };
    if (method === "thread/turns/list") return { data: [latest] };
    throw Error("Unexpected mutation: " + method);
  } };
  return { directory, calls, thread, item, latest, rpc, close() { rmSync(directory, { recursive: true, force: true }); } };
}

test("explicit exact-result acknowledgement is scoped, idempotent and body-free", async () => {
  const f = fixture();
  try {
    const input = { rpc: f.rpc, directory: f.directory, scope: "install/profile-one", result };
    const first = await acknowledgeNativeResult({ ...input, now: 1000 });
    expect((await acknowledgeNativeResult({ ...input, now: 2000 })).acknowledgedAt).toBe(first.acknowledgedAt);
    const other = await acknowledgeNativeResult({ ...input, scope: "install/profile-two", now: 2000 });
    expect(other.scope).not.toBe(first.scope);
    const newer = await acknowledgeNativeResult({ ...input, result: { ...result, turnId: "next-turn" }, now: 2000 });
    expect(newer.result.turnId).toBe("next-turn");
    expect(newer.acknowledgedAt).not.toBe(first.acknowledgedAt);
    const stored = readdirSync(f.directory).map(name => readFileSync(join(f.directory, name), "utf8")).join("");
    expect(stored).not.toContain("PRIVATE_FINAL_BODY");
    expect(stored).not.toContain("install/profile-one");
    expect(f.calls.every(method => ["thread/read", "thread/items/list"].includes(method))).toBe(true);
  } finally { f.close(); }
});

test("ordinary chats, foreign parents and non-final items cannot acquire an acknowledgement", async () => {
  const f = fixture();
  try {
    const input = { rpc: f.rpc, directory: f.directory, scope: "profile", result };
    await expect(acknowledgeNativeResult({ ...input, result: { ...result, parentThreadId: "other" } })).rejects.toThrow("parent and child");
    f.item.phase = "commentary";
    await expect(acknowledgeNativeResult(input)).rejects.toThrow("not a final answer");
    f.thread.source = "cli";
    await expect(acknowledgeNativeResult(input)).rejects.toThrow();
    expect(readdirSync(f.directory)).toEqual([]);
  } finally { f.close(); }
});

test("paged final-item lookup preserves the exact turn and does not acknowledge a missing item", async () => {
  const f = fixture();
  try {
    let pages = 0;
    const rpc = { async request(method: string, params?: any): Promise<any> {
      if (method !== "thread/items/list") return f.rpc.request(method, params);
      expect(params.turnId).toBe("turn");
      pages++;
      return params.cursor ? { data: [{ turnId: "turn", item: f.item }], nextCursor: null }
        : { data: [{ turnId: "turn", item: { id: "progress", type: "agentMessage" } }], nextCursor: "next" };
    } };
    await acknowledgeNativeResult({ rpc, directory: f.directory, scope: "profile", result });
    expect(pages).toBe(2);
    f.item.id = "other";
    await expect(acknowledgeNativeResult({ rpc, directory: f.directory, scope: "profile", result })).rejects.toThrow("not found");
  } finally { f.close(); }
});

test("failure acknowledgement verifies the terminal outcome without manufacturing a final answer", async () => {
  const f = fixture();
  try {
    const failure: ResultReference = { parentThreadId: "parent", threadId: "child", turnId: "turn", outcome: "failed" };
    const input = { rpc: f.rpc, directory: f.directory, scope: "profile", result: failure };
    expect((await acknowledgeNativeResult(input)).result.outcome).toBe("failed");
    expect(f.calls).toEqual(["thread/read", "thread/turns/list"]);
    f.latest.status = "inProgress";
    await expect(acknowledgeNativeResult(input)).rejects.toThrow("terminal failure");
  } finally { f.close(); }
});

test("receipt retention uses age and total bytes while preserving unrelated files", async () => {
  const f = fixture();
  try {
    const old = join(f.directory, "a".repeat(64) + ".json");
    writeFileSync(old, "{}"); utimesSync(old, new Date(0), new Date(0));
    writeFileSync(join(f.directory, "b".repeat(64) + ".json"), "x".repeat(3 * 1024 * 1024));
    writeFileSync(join(f.directory, "c".repeat(64) + ".json"), "x".repeat(3 * 1024 * 1024));
    writeFileSync(join(f.directory, "unrelated.txt"), "keep");
    await acknowledgeNativeResult({ rpc: f.rpc, directory: f.directory, scope: "profile", result });
    const names = readdirSync(f.directory);
    expect(names).not.toContain("a".repeat(64) + ".json");
    expect(names).toContain("unrelated.txt");
    expect(names.filter(name => name.endsWith(".json")).reduce((sum, name) => sum + readFileSync(join(f.directory, name)).length, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
  } finally { f.close(); }
});
