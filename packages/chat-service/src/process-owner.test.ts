import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { callProcessOwner, startProcessOwnerControl } from "./process-owner";

test("owner shutdown delivers an admitted terminal observation before closing transport", async () => {
  let entered!: () => void, completed!: () => void;
  const admitted = new Promise<void>(resolve => { entered = resolve; });
  const completion = new Promise<void>(resolve => { completed = resolve; });
  const control = await startProcessOwnerControl({
    binding: { ownerId: randomUUID(), operationId: randomUUID(), workspaceId: "opaque-workspace" },
    secret: randomBytes(32).toString("hex"),
    authority: { status: () => ({}), write() {}, async wait() { entered(); await completion; return { state: "exited", output: "complete" }; } },
  });
  try {
    const observing = callProcessOwner(control.descriptor, { action: "wait", yieldTimeMs: 1000 });
    await admitted;
    completed();
    const stopped = control.close();
    expect(await observing).toEqual({ state: "exited", output: "complete" });
    await stopped;
  } finally { await control.close(); }
});

async function fixture() {
  let writes = 0, cancels = 0;
  let resolveObservationAborted!: () => void;
  const observationCancelled = new Promise<void>(resolve => { resolveObservationAborted = resolve; });
  let resolveWaiting!: () => void;
  const waiting = new Promise<void>(resolve => { resolveWaiting = resolve; });
  const control = await startProcessOwnerControl({ binding: { ownerId: randomUUID(), operationId: randomUUID(), workspaceId: randomUUID() },
    secret: randomBytes(32).toString("hex"), authority: {
      status: () => ({ running: cancels === 0, writes }),
      wait: async (duration, signal) => {
        resolveWaiting();
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, duration);
          const cancelled = () => { clearTimeout(timer); resolveObservationAborted(); resolve(); };
          if (signal.aborted) cancelled();
          else signal.addEventListener("abort", cancelled, { once: true });
        });
        return { running: cancels === 0 };
      },
      write: () => { writes++; },
      cancelOwnedExecution: async () => { cancels++; return { running: false }; },
    } });
  return { control, waiting, observationCancelled, writes: () => writes, cancels: () => cancels };
}

test("owner control authenticates exact binding and refuses uncertain stdin replay", async () => {
  const f = await fixture();
  try {
    expect(await callProcessOwner(f.control.descriptor, { action: "status" })).toEqual({ running: true, writes: 0 });
    await expect(callProcessOwner({ ...f.control.descriptor, secret: "0".repeat(64) }, { action: "cancel" })).rejects.toThrow("401");
    await expect(callProcessOwner({ ...f.control.descriptor, workspaceId: randomUUID() }, { action: "stdin", chars: "wrong" })).rejects.toThrow("409");
    await expect(callProcessOwner({ ...f.control.descriptor, ownerId: randomUUID() }, { action: "cancel" })).rejects.toThrow("409");
    const requestId = randomUUID();
    await callProcessOwner(f.control.descriptor, { action: "stdin", chars: "accepted", requestId });
    await expect(callProcessOwner(f.control.descriptor, { action: "stdin", chars: "accepted", requestId })).rejects.toThrow("409");
    expect(f.writes()).toBe(1);
    expect(f.cancels()).toBe(0);
    await callProcessOwner(f.control.descriptor, { action: "cancel" });
    await callProcessOwner(f.control.descriptor, { action: "cancel" });
    expect(f.cancels()).toBe(1);
  } finally { await f.control.close(); }
});

test("cancelled observation never calls execution cancellation", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const pending = callProcessOwner(f.control.descriptor, { action: "wait", yieldTimeMs: 100 }, controller.signal);
    void pending.catch(() => {});
    await f.waiting;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await f.observationCancelled;
    // A subsequent authenticated request observes the same running execution.
    expect(await callProcessOwner(f.control.descriptor, { action: "status" })).toEqual({ running: true, writes: 0 });
    expect(f.cancels()).toBe(0);
  } finally { await f.control.close(); }
});

test("replacement endpoint cannot impersonate the owner response", async () => {
  const f = await fixture();
  let leakedSecret = false;
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const text = await request.text();
    leakedSecret = text.includes(f.control.descriptor.secret) || request.headers.get("authorization") !== null;
    // Reflecting a valid request signature must not authenticate a fake response.
    return new Response(text, { headers: { "x-tela-owner-signature": request.headers.get("x-tela-owner-request-signature") ?? "" } });
  } });
  try {
    await expect(callProcessOwner({ ...f.control.descriptor, endpoint: `http://127.0.0.1:${fake.port}/v1/operation` }, { action: "status" })).rejects.toThrow("authentication failed");
    expect(leakedSecret).toBe(false);
  } finally { await fake.stop(true); await f.control.close(); }
});
