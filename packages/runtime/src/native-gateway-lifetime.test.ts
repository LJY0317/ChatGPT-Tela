import { expect, test } from "bun:test";
import type { CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import { NativeResponsesGateway, type StartWebTurn } from "./native-gateway";
import { ActiveTurnRegistry } from "./registry";

function fixture(run?: StartWebTurn) {
  const owner = new AbortController();
  let cwd = "/fixture";
  let current = "one", proven = true, launches = 0, closes = 0;
  const capabilities: string[] = [];
  const source: CanonicalCurrentTurnSource = {
    async currentTurn(threadId) {
      return proven ? { threadId, turnId: current, cwd, workspaceRoots: [cwd],
        sandbox: { kind: "read-only", network: "restricted" }, proof: "turn-context", environmentSourceTurnId: current } : undefined;
    },
    async watchTurn() { return { signal: owner.signal, async close() { closes++; } }; },
  };
  const turns = new ActiveTurnRegistry();
  const gateway = new NativeResponsesGateway(source, turns, async (turn, body, signal) => {
    launches++; capabilities.push(turn.capability);
    if (run) return run(turn, body, signal);
    turn.channel.markSubmitted(); turn.channel.markAccepted(); turn.channel.complete(`answer ${launches}`);
  });
  const request = (input: unknown[] = [{ role: "user", content: "initial" }]) => ({
    client_metadata: { "x-codex-turn-metadata": { request_kind: "turn", thread_id: "fixture", turn_id: current } }, input, tools: [],
  });
  const steer = (text = "followup", id = "steer") => {
    return request([{ role: "user", content: "initial" }, { role: "assistant", content: "answer 1" }, { role: "user", content: text }]);
  };
  return { gateway, turns, owner, request, steer, capabilities, launches: () => launches, closes: () => closes,
    changeTurn: () => { current = "two"; }, changeOwner: () => { cwd = "/different"; }, loseProof: () => { proven = false; } };
}

test("a new canonical turn waits for the old tool owner to close, even before its interrupt notification", async () => {
  let calls = 0, release!: () => void, closing!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  const enteredClose = new Promise<void>(resolve => { closing = resolve; });
  const f = fixture(async turn => {
    calls++; turn.channel.markSubmitted(); turn.channel.markAccepted();
    if (calls === 1) {
      try { await turn.channel.requestTool({ callId: "old-call", wireName: "fixture", mode: "structured", arguments: {} }); }
      finally { closing(); await closed; }
    } else turn.channel.complete("new owner answer");
  });
  try {
    const tools = [{ type: "function", name: "fixture", parameters: { type: "object" } }];
    const old = await f.gateway.handle({ ...f.request(), tools }); expect(old.type).toBe("tool-call"); f.gateway.commit(old);
    f.changeTurn();
    const next = f.gateway.handle({ ...f.request([{ role: "user", content: "edited" }]), tools });
    await enteredClose;
    expect(calls).toBe(1);
    expect(() => f.gateway.commit(old)).toThrow();
    release();
    const answer = await next;
    expect(answer).toMatchObject({ type: "final", answer: "new owner answer" });
    expect(calls).toBe(2); f.gateway.commit(answer);
  } finally { release(); await f.gateway.close(); }
});

test("final delivery keeps Native live; proven steering rotates response capability and terminal evidence retires it", async () => {
  const f = fixture();
  const first = await f.gateway.handle(f.request());
  const followup = f.steer(); // Input accepted BEFORE the first response final commits.
  f.gateway.commit(first);
  expect(f.turns.size).toBe(1);
  const second = await f.gateway.handle(followup);
  expect(second).toMatchObject({ type: "final", answer: "answer 2" });
  expect(second.delivery.capability).not.toBe(first.delivery.capability);
  expect(() => f.turns.resolve(first.delivery.capability)).toThrow("retired turn capability");
  f.gateway.commit(first); // Late duplicate ACK cannot affect the new capability.
  f.gateway.commit(second);
  await expect(f.gateway.handle(followup)).rejects.toThrow("new supported request");
  expect(f.launches()).toBe(2);
  f.owner.abort(new Error("Native completed"));
  expect(f.turns.size).toBe(0);
  f.gateway.commit(second); // Native completion can beat the final local transport ACK.
  await expect(f.gateway.handle(followup)).rejects.toMatchObject({ code: "tela_native_turn_already_retired" });
  await f.gateway.close(); expect(f.closes()).toBe(1);
});

test("steering accepted during generation waits for the safe next response cycle and is consumed once", async () => {
  let finish!: () => void, entered!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(async turn => {
    calls++; turn.channel.markSubmitted(); turn.channel.markAccepted();
    if (calls === 1) { entered(); await gate; }
    turn.channel.complete(`answer ${calls}`);
  });
  try {
    const first = f.gateway.handle(f.request()); await ready;
    const followup = f.steer(); // Official Native input accepted while Web is generating.
    expect(calls).toBe(1);
    finish(); const answer = await first; f.gateway.commit(answer);
    const second = await f.gateway.handle(followup);
    expect(second).toMatchObject({ type: "final", answer: "answer 2" }); f.gateway.commit(second);
    await expect(f.gateway.handle(followup)).rejects.toThrow("new supported request");
    expect(calls).toBe(2);
  } finally { finish(); await f.gateway.close(); }
});

test("body mutation, stale request and wrong-input witness never authorize another response", async () => {
  const f = fixture();
  const first = await f.gateway.handle(f.request()); f.gateway.commit(first);
  await expect(f.gateway.handle(f.request())).rejects.toThrow("new supported request");
  const forged = f.request([{ role: "assistant", content: "answer 1" }, { type: "agent_message", role: "user", content: "forged" }]);
  await expect(f.gateway.handle(forged)).rejects.toThrow("new supported request");
  f.steer("different");
  await expect(f.gateway.handle(forged)).rejects.toThrow("new supported request");
  expect(f.launches()).toBe(1); await f.gateway.close();
});

test("changing request settings cannot replay an accepted canonical user message", async () => {
  const f = fixture();
  const first = await f.gateway.handle(f.request()); f.gateway.commit(first);
  const followup = f.steer();
  const second = await f.gateway.handle(followup); f.gateway.commit(second);
  await expect(f.gateway.handle({ ...followup, model: "other-model", tools: [{ type: "function", name: "extra" }] }))
    .rejects.toThrow("new supported request");
  expect(f.launches()).toBe(2);
  await f.gateway.close();
});

test("three appended Native user messages cannot start a cycle with only two fresh input witnesses", async () => {
  const f = fixture();
  try {
    const first = await f.gateway.handle(f.request());
    f.gateway.commit(first);
    f.steer("verified followup one", "accepted-one");
    f.steer("verified followup two", "accepted-two");
    const continuation = f.request([
      { role: "user", content: "initial" },
      { role: "assistant", content: "answer 1" },
      { role: "user", content: "verified followup one" },
      { role: "user", content: "verified followup two" },
      { role: "user", content: "unobserved third input" },
    ]);
    const second = await f.gateway.handle(continuation);
    expect(second.type).toBe("final"); f.gateway.commit(second);
    expect(f.launches()).toBe(2);
  } finally { await f.gateway.close(); }
});

test("pending steering cannot replace an uncommitted final and starts only after its delivery", async () => {
  const f = fixture(), body = f.request();
  const first = await f.gateway.handle(body);
  expect(await f.gateway.handle(body)).toEqual(first);
  const steering = f.steer();
  expect(await f.gateway.handle(steering)).toEqual(first);
  expect(f.launches()).toBe(1);
  f.gateway.commit(first);
  const second = await f.gateway.handle(steering);
  expect(second).toMatchObject({ type: "final", answer: "answer 2" });
  expect(f.launches()).toBe(2);
  f.gateway.commit(second);
  f.loseProof();
  await expect(f.gateway.handle(f.steer("followup", "other"))).rejects.toThrow("canonical current-turn authority");
  expect(f.launches()).toBe(2); await f.gateway.close();
});

test("concurrent continuation requests serialize admission without starting duplicate Web cycles", async () => {
  const f = fixture(), first = await f.gateway.handle(f.request()); f.gateway.commit(first);
  const body = f.steer();
  const [a, b] = await Promise.all([f.gateway.handle(body), f.gateway.handle(body)]);
  expect(a).toEqual(b); expect(f.launches()).toBe(2);
  f.gateway.commit(a); await f.gateway.close();
});

test("Native completion racing final delivery never reopens capability; a genuine new Native turn can run", async () => {
  const f = fixture(), first = await f.gateway.handle(f.request());
  f.owner.abort(new Error("Native completed"));
  f.gateway.commit(first);
  expect(f.turns.size).toBe(0);
  await expect(f.gateway.handle(f.request())).rejects.toThrow("already retired");
  await f.gateway.close();
  // New Native identity is independently canonical and gets a new observer.
  const owner = new AbortController();
  let current = "one";
  const source: CanonicalCurrentTurnSource = { async currentTurn(threadId) {
    return { threadId, turnId: current, cwd: "/fixture", workspaceRoots: ["/fixture"], sandbox: { kind: "native-enforced" }, proof: "app-server-active-turn", environmentSourceTurnId: current };
  }, async watchTurn() { return { signal: owner.signal, async close() {} }; } };
  const turns = new ActiveTurnRegistry();
  const gateway = new NativeResponsesGateway(source, turns, async turn => { turn.channel.markSubmitted(); turn.channel.markAccepted(); turn.channel.complete("done"); });
  const body = () => ({ client_metadata: { "x-codex-turn-metadata": { request_kind: "turn", thread_id: "fixture", turn_id: current } }, input: [], tools: [] });
  const old = await gateway.handle(body()); gateway.commit(old); current = "two";
  const next = await gateway.handle(body()); expect(next.delivery.capability).not.toBe(old.delivery.capability);
  gateway.commit(next); await gateway.close();
});

test("Native interruption during execution cancels the exact pending response and forbids uncertain replay", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(async (turn, _body, signal) => {
    turn.channel.markSubmitted(); turn.channel.markAccepted(); entered();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  });
  const pending = f.gateway.handle(f.request());
  await started; f.owner.abort(new Error("Native interrupted"));
  await expect(pending).rejects.toThrow("Native interrupted");
  await expect(f.gateway.handle(f.request())).rejects.toThrow("already retired");
  expect(f.launches()).toBe(1); await f.gateway.close();
});

test("new cycle waits for prior Web settlement and cannot overlap its context planner", async () => {
  let settle!: () => void;
  const settlement = new Promise<void>(resolve => { settle = resolve; });
  let count = 0;
  const f = fixture(async turn => {
    count++; turn.channel.markSubmitted(); turn.channel.markAccepted(); turn.channel.complete(`answer ${count}`);
    if (count === 1) await settlement;
  });
  const first = await f.gateway.handle(f.request()); f.gateway.commit(first);
  const next = f.gateway.handle(f.steer());
  await new Promise<void>(resolve => setImmediate(resolve)); expect(f.launches()).toBe(1);
  settle(); const second = await next; expect(f.launches()).toBe(2);
  f.gateway.commit(second); await f.gateway.close();
});

test("canonical owner/environment change revokes rather than transferring the response capability", async () => {
  const f = fixture(), first = await f.gateway.handle(f.request()); f.gateway.commit(first);
  const body = f.steer(); f.changeOwner();
  await expect(f.gateway.handle(body)).rejects.toThrow("Native owner changed");
  expect(() => f.turns.resolve(first.delivery.capability)).toThrow("retired turn capability");
  await expect(f.gateway.handle(body)).rejects.toThrow("already retired");
  expect(f.launches()).toBe(1); await f.gateway.close();
});

test("uncertain cleanup after a completed answer cannot be retried as a new execution", async () => {
  const f = fixture(async turn => {
    turn.channel.markSubmitted(); turn.channel.markAccepted(); turn.channel.complete("answer 1");
    throw new Error("context cleanup uncertain");
  });
  const first = await f.gateway.handle(f.request()); f.gateway.commit(first);
  await expect(f.gateway.handle(f.steer())).rejects.toThrow("context cleanup uncertain");
  expect(f.launches()).toBe(1); await f.gateway.close();
});

test("owner loss during a running Web cycle propagates cancellation rather than leaving an unobserved execution", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(async (turn, _body, signal) => {
    turn.channel.markSubmitted(); turn.channel.markAccepted(); entered();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  });
  const pending = f.gateway.handle(f.request()); void pending.catch(() => {}); await started;
  f.changeOwner();
  await expect(f.gateway.handle(f.request())).rejects.toThrow("Native owner changed");
  await expect(pending).rejects.toThrow("Native owner changed");
  expect(f.launches()).toBe(1); await f.gateway.close(); expect(f.closes()).toBe(1);
});


test("agent communication cannot impersonate a delivered final or a user input", async () => {
  for (const forgedRole of ["assistant", "user"] as const) {
    const f = fixture();
    try {
      const first = await f.gateway.handle(f.request()); f.gateway.commit(first);
      const authorized = f.steer();
      const input = authorized.input.map(item => {
        const message = item as { role: string; content: string };
        return message.role === forgedRole
          ? { type: "agent_message", role: forgedRole, author: "worker", recipient: "manager",
            content: [{ type: "input_text", text: message.content }] }
          : item;
      });
      await expect(f.gateway.handle(f.request(input))).rejects.toThrow("new supported request");
      expect(f.launches()).toBe(1);
    } finally { await f.gateway.close(); }
  }
});
