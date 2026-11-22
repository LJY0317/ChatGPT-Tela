import { expect, test } from "bun:test";
import { submitOfficialWebFollowUp, type RegisteredWebFollowUp } from "./official-web-follow-up";

const model = "chatgpt-tela-web/family/12345678901234567890";
const registration: RegisteredWebFollowUp = {
  threadId: "registered", profileScope: "installed/profile-2", accountFingerprint: "account-a", model,
};

function fixture() {
  const calls: { method: string; params: any }[] = [];
  let closed = false;
  let exited!: () => void;
  const exit = new Promise<void>(resolve => { exited = resolve; });
  const listeners = new Set<(method: string, params: unknown) => void>();
  const thread: any = { id: "registered", model, modelProvider: "openai", source: "cli", status: { type: "idle" } };
  const rpc = {
    exited: exit,
    subscribe(listener: (method: string, params: unknown) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async send(method: string, params?: unknown): Promise<any> {
      calls.push({ method, params });
      if (method === "thread/resume") return { thread };
      if (method === "model/list") return { data: [{ model }], nextCursor: null };
      if (method === "thread/turns/list") return { data: [{ id: "previous", status: "completed" }], nextCursor: null };
      if (method === "turn/start") return { turn: { id: "follow-up" } };
      if (method === "thread/items/list") return { data: [{ turnId: "follow-up", item: {
        id: "final", type: "agentMessage", phase: "final_answer", text: "Done",
      } }], nextCursor: null };
      throw Error(`Unexpected ${method}`);
    },
    async close() { closed = true; exited(); },
  };
  const input = { threadId: "registered", resolveRegistration: async () => registration,
    profileScope: registration.profileScope, accountFingerprint: registration.accountFingerprint,
    executable: "unused", codexHome: "unused", prompt: "A new task", connect: async () => rpc };
  return { calls, thread, input, emit(method: string, params: unknown) {
    for (const listener of listeners) listener(method, params);
  }, exit: exited, get closed() { return closed; }, get listenerCount() { return listeners.size; } };
}

test("only the resumed Web writer starts one follow-up and remains owned through completion", async () => {
  const f = fixture();
  const task = submitOfficialWebFollowUp(f.input);
  expect(await task.accepted).toEqual({ threadId: "registered", turnId: "follow-up", model, status: "accepted" });
  expect(f.calls.map(call => call.method)).toEqual(["thread/resume", "model/list", "thread/turns/list", "turn/start"]);
  expect(f.calls[0]?.params).toEqual({ threadId: "registered", excludeTurns: true });
  expect(f.calls[3]?.params).toEqual({ threadId: "registered", model, input: [{ type: "text", text: "A new task" }] });
  expect(f.closed).toBe(false);
  f.emit("turn/completed", { threadId: "other", turn: { id: "follow-up", status: "completed" } });
  f.emit("turn/completed", { threadId: "registered", turn: { id: "other", status: "completed" } });
  expect(f.closed).toBe(false);
  f.emit("turn/completed", { threadId: "registered", turn: { id: "follow-up", status: "completed" } });
  expect(await task.finished).toEqual({ threadId: "registered", turnId: "follow-up", model,
    status: "completed", itemId: "final", answer: "Done" });
  expect(f.calls.map(call => call.method)).toEqual(["thread/resume", "model/list", "thread/turns/list", "turn/start", "thread/items/list"]);
  expect(f.closed).toBe(true);
  expect(f.listenerCount).toBe(0);
});

test("follow-up ACK waits for durable acceptance and still submits once", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const registered = Promise.withResolvers<void>();
  let delivered = false;
  const task = submitOfficialWebFollowUp({ ...f.input,
    onAccepted: async (receipt, started) => {
      expect(receipt.turnId).toBe("follow-up");
      expect(started.turn.id).toBe(receipt.turnId);
      entered.resolve();
      await registered.promise;
    },
  });
  void task.accepted.then(() => { delivered = true; });
  await entered.promise;
  expect(delivered).toBe(false);
  expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  registered.resolve();
  expect(await task.accepted).toMatchObject({ turnId: "follow-up", status: "accepted" });
  f.emit("turn/completed", { threadId: "registered", turn: { id: "follow-up", status: "completed" } });
  expect(await task.finished).toMatchObject({ turnId: "follow-up", status: "completed" });
});

test("registration, profile and account mismatches refuse execution before writer acquisition", async () => {
  for (const mismatch of [
    { profileScope: "other-profile" }, { accountFingerprint: "other-account" },
    { resolveRegistration: async () => ({ ...registration, threadId: "other-chat" }) },
    { resolveRegistration: async () => ({ ...registration, model: "native-model" }) },
  ]) {
    const f = fixture();
    await expect(submitOfficialWebFollowUp({ ...f.input, ...mismatch }).accepted).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  }
});

test("changed conversation, model, provider and active turn refuse turn/start", async () => {
  for (const change of [
    { id: "wrong-chat" }, { model: "another-model" }, { modelProvider: "custom" },
    { status: { type: "active" } }, { source: { subAgent: { thread_spawn: { parent_thread_id: "other" } } } },
  ]) {
    const f = fixture();
    Object.assign(f.thread, change);
    await expect(submitOfficialWebFollowUp(f.input).accepted).rejects.toThrow();
    expect(f.calls.some(call => call.method === "turn/start")).toBe(false);
    expect(f.closed).toBe(true);
  }
});

test("writer refusal or an unfinished latest turn never sends a model request", async () => {
  const busy = fixture();
  await expect(submitOfficialWebFollowUp({ ...busy.input, connect: async () => ({
    async send() { throw Error("Writer unavailable"); }, async close() {},
    exited: Promise.resolve(), subscribe: () => () => {},
  }) }).accepted).rejects.toThrow("Writer unavailable");

  const unfinished = fixture();
  const original = unfinished.input.connect;
  await expect(submitOfficialWebFollowUp({ ...unfinished.input, connect: async () => {
    const rpc = await original();
    return { ...rpc, send(method: string, params?: unknown) {
      if (method === "thread/turns/list") return Promise.resolve({ data: [{ id: "previous", status: "inProgress" }] });
      return rpc.send(method, params);
    } };
  } }).accepted).rejects.toThrow("no completed latest turn");
  expect(unfinished.calls.some(call => call.method === "turn/start")).toBe(false);
});

test("completion arriving before ACK is retained for the acknowledged turn", async () => {
  const f = fixture();
  const task = submitOfficialWebFollowUp({ ...f.input, connect: async () => {
    const rpc = await f.input.connect();
    return { ...rpc, async send(method: string, params?: unknown) {
      const result = await rpc.send(method, params);
      if (method === "turn/start") f.emit("turn/completed", {
        threadId: "registered", turn: { id: "follow-up", status: "completed" },
      });
      return result;
    } };
  } });
  expect(await task.accepted).toMatchObject({ turnId: "follow-up", status: "accepted" });
  expect(await task.finished).toMatchObject({ status: "completed", answer: "Done" });
  expect(f.closed).toBe(true);
});

test("writer exit after ACK rejects completion while preserving receipt", async () => {
  const f = fixture();
  const task = submitOfficialWebFollowUp(f.input);
  expect(await task.accepted).toMatchObject({ turnId: "follow-up", status: "accepted" });
  f.exit();
  await expect(task.finished).rejects.toThrow("completion could not be confirmed");
  expect(f.closed).toBe(true);
});

test("noncompleted terminal turn completes the owned lifecycle without reading answer", async () => {
  const f = fixture();
  const task = submitOfficialWebFollowUp(f.input);
  await task.accepted;
  f.emit("turn/completed", { threadId: "registered", turn: { id: "follow-up", status: "failed" } });
  expect(await task.finished).toEqual({ threadId: "registered", turnId: "follow-up", model, status: "failed" });
  expect(f.calls.some(call => call.method === "thread/items/list")).toBe(false);
  expect(f.closed).toBe(true);
});
