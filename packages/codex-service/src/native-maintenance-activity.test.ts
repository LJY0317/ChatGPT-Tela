import { expect, test } from "bun:test";
import { inspectLoadedNativeActivity } from "./native-maintenance-activity";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";

function fixture(states: Record<string, "idle" | "active" | "notLoaded">, opts: {
  readonly changedOwner?: boolean;
  readonly malformed?: boolean;
  readonly paginated?: boolean;
} = {}) {
  const calls: string[] = [];
  const rpc: Pick<CodexAppServerRpc, "request"> = {
    async request(method, params) {
      calls.push(method);
      if (method === "thread/loaded/list") {
        if (opts.malformed) return { data: [Object.keys(states)[0], Object.keys(states)[0]], nextCursor: null };
        if (opts.paginated && !(params as { cursor?: string } | undefined)?.cursor) {
          return { data: Object.keys(states).slice(0, 1), nextCursor: "next" };
        }
        return { data: opts.paginated ? Object.keys(states).slice(1) : Object.keys(states), nextCursor: null };
      }
      if (method === "thread/read") {
        const id = String((params as { threadId?: string } | undefined)?.threadId);
        return { thread: { id: opts.changedOwner ? "foreign-thread" : id,
          status: { type: states[id] ?? "notLoaded" }, historyMode: "legacy" } };
      }
      throw Error("No history or mutation RPCs are allowed in Native activity inspection");
    },
  };
  return { rpc, calls };
}

test("Native maintenance census observes every loaded conversation but never pages private Legacy history", async () => {
  const f = fixture({ "thread-a": "idle", "thread-b": "active" }, { paginated: true });
  expect(await inspectLoadedNativeActivity(f.rpc)).toEqual({ loadedCount: 2, activeThreadCount: 1 });
  expect(f.calls).toEqual(["thread/loaded/list", "thread/loaded/list", "thread/read", "thread/read"]);
  expect(f.calls).not.toContain("thread/turns/list");
});

test("native shutdown census treats an empty complete inventory as genuinely idle", async () => {
  const f = fixture({});
  expect(await inspectLoadedNativeActivity(f.rpc)).toEqual({ loadedCount: 0, activeThreadCount: 0 });
  expect(f.calls).toEqual(["thread/loaded/list"]);
});

test("unknown, changing, duplicate and aborted Native owner evidence cannot authorize shutdown", async () => {
  for (const f of [
    fixture({ "thread-a": "notLoaded" }),
    fixture({ "thread-a": "idle" }, { changedOwner: true }),
    fixture({ "thread-a": "idle" }, { malformed: true }),
  ]) {
    await expect(inspectLoadedNativeActivity(f.rpc)).rejects.toThrow();
  }
  const f = fixture({ "thread-a": "idle" });
  const abort = new AbortController(); abort.abort();
  await expect(inspectLoadedNativeActivity(f.rpc, abort.signal)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("Native inventory with unbounded pagination is rejected before reading any thread", async () => {
  let calls = 0;
  const rpc: Pick<CodexAppServerRpc, "request"> = {
    async request(method) {
      calls++;
      if (method !== "thread/loaded/list") throw Error("Unexpected history read");
      return { data: [], nextCursor: String(calls) };
    },
  };
  await expect(inspectLoadedNativeActivity(rpc)).rejects.toThrow("incomplete");
  expect(calls).toBe(4);
});
