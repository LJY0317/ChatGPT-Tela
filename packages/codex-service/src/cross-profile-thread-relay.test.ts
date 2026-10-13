import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  LocalOriginalThreadOwner, LocalProfileBinding,
} from "./cross-profile-thread-relay";
import { LocalOriginalThreadRelay } from "./cross-profile-thread-relay";

const finger = (digit: string) => digit.repeat(64);
const T = "12345678-1234-4123-8123-123456789abc";
const P = "87654321-1234-4123-8123-abcdefabcdef";
const OLD_REV = finger("1");
const NEW_REV = finger("2");
const TURN = "12345678-1234-4123-8fff-abcdefabcdef";
const binding = (slot: number, seed: string): LocalProfileBinding => ({
  slot, accountFingerprint: finger(seed),
  sessionFingerprint: finger(String((Number(seed) + 1) % 10)),
  routeFingerprint: finger(String((Number(seed) + 2) % 10)),
});

function fixture() {
  const profiles = new Map([
    [1, binding(1, "1")], [2, binding(2, "4")], [3, binding(3, "7")],
  ]);
  const sourceCalls: { method: string; threadId: string }[] = [];
  const approvals: { sourceSlot: number; destinationSlot: number; threadId: string; permission: string }[] = [];
  let approved = true;
  let now = 100_000;
  let revision = OLD_REV;
  let status: "idle" | "active" | "unknown" = "idle";
  let mutateDuringRead = false;
  let otherThreadReturned = false;
  let readBytes = 100;
  let continueFailAfterDispatch = false;
  let continueGate: Promise<void> | undefined;
  let resolveContinue!: () => void;
  let onContinue!: () => void;
  let continueStarted = Promise.resolve();
  let continues = 0;
  const owner: LocalOriginalThreadOwner = {
    async prove(threadId) {
      sourceCalls.push({ method: "prove", threadId });
      return {
        threadId, owner: profiles.get(1)!,
        workspaceFingerprint: finger("a"),
        revision, state: status,
      };
    },
    async read(threadId, maxBytes) {
      sourceCalls.push({ method: `read:${maxBytes}`, threadId });
      if (mutateDuringRead) revision = NEW_REV;
      return {
        threadId, revision: mutateDuringRead ? OLD_REV : revision,
        hasMore: false, turns: [{
          threadId: otherThreadReturned ? P : threadId,
          turnId: TURN, state: "completed" as const,
          text: "synthetic-selected-original ".repeat(readBytes),
        }],
      };
    },
    async continue(input) {
      continues++;
      sourceCalls.push({ method: "continue", threadId: input.threadId });
      onContinue?.();
      await continueGate;
      if (continueFailAfterDispatch) {
        throw new Error("Synthetic transport lost after source may have executed");
      }
      revision = NEW_REV;
      status = "idle";
      return {
        threadId: input.threadId, operationId: input.operationId,
        turnId: TURN, revision, state: "completed",
      };
    },
  };
  const relay = new LocalOriginalThreadRelay({
    async profile(slot) {
      const result = profiles.get(slot);
      if (!result) throw new Error("Unknown exact native owner");
      return result;
    },
    async delegate(caller) {
      if (caller === "authenticated-profile-2") return profiles.get(2)!;
      if (caller === "authenticated-profile-3") return profiles.get(3)!;
      if (caller === "authenticated-profile-1") return profiles.get(1)!;
      throw new Error("Caller is not authenticated by the local profile transport");
    },
    async approve(input) {
      approvals.push(input);
      return approved;
    },
    async owner(slot) {
      if (slot !== 1) throw new Error("Unowned canonical Native worker");
      return owner;
    },
    now: () => now,
  });
  const issue = (permission: "read" | "continue" = "read", ttlMs = 30_000) =>
    relay.grant({ sourceSlot: 1, destinationSlot: 2, threadId: T, permission, ttlMs });
  const caller = "authenticated-profile-2";
  const continueInput = (capability: string, requestId = randomUUID(), expectedRevision = OLD_REV) =>
    ({ capability, caller, expectedRevision, requestId, message: "Continue the same original T using its existing owner" });
  return {
    relay, issue, caller, continueInput, sourceCalls, approvals, profiles,
    setApproval: (v: boolean) => { approved = v; },
    advance: (ms: number) => { now += ms; },
    setStatus: (s: "idle" | "active" | "unknown") => { status = s; },
    setRevision: (r: string) => { revision = r; },
    setReadMutation: (v: boolean) => { mutateDuringRead = v; },
    setForeignOutput: (v: boolean) => { otherThreadReturned = v; },
    setReadBytes: (v: number) => { readBytes = v; },
    setContinueFailure: (v: boolean) => { continueFailAfterDispatch = v; },
    holdContinue: () => {
      continueGate = new Promise<void>(resolve => { resolveContinue = resolve; });
      continueStarted = new Promise<void>(resolve => { onContinue = resolve; });
      return { started: continueStarted, release: () => resolveContinue() };
    },
    counts: () => ({ continues, revision }),
  };
}

describe("one-owner original local thread delegation (source-only, not user-facing)", () => {
  test("only exact local operator approval and two authenticated distinct profiles can create a grant", async () => {
    const f = fixture();
    f.setApproval(false);
    await expect(f.issue()).rejects.toThrow("did not approve");
    f.setApproval(true);
    const authorized = await f.issue();
    expect(authorized.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.approvals).toEqual([
      { sourceSlot: 1, destinationSlot: 2, threadId: T, permission: "read" },
      { sourceSlot: 1, destinationSlot: 2, threadId: T, permission: "read" },
    ]);
    await expect(f.relay.grant({ sourceSlot: 1, destinationSlot: 1, threadId: T, permission: "read" }))
      .rejects.toThrow("distinct");
    await expect(f.relay.grant({ sourceSlot: 1, destinationSlot: 2, threadId: P,
      permission: "read", ttlMs: 50_000_000 })).rejects.toThrow("lifetime");
  });

  test("destination receives only one selected thread, never raw App Server or unrelated private thread", async () => {
    const f = fixture();
    const { capability } = await f.issue();
    const result = await f.relay.read(capability, f.caller);
    expect(result.threadId).toBe(T);
    expect(result.turns.every(t => t.threadId === T)).toBe(true);
    expect(f.sourceCalls.some(c => c.method.startsWith("read:") && c.threadId === T)).toBe(true);
    expect(f.sourceCalls.some(c => c.threadId === P || c.method === "thread/list")).toBe(false);
    await expect(f.relay.read(capability, "authenticated-profile-3"))
      .rejects.toThrow("binding");
    await expect(f.relay.read("x".repeat(43), f.caller))
      .rejects.toThrow("unavailable");
  });

  test("a source read that mixes private threads, exceeds the limit, or changes revision is not shared", async () => {
    for (const kind of ["foreign", "large", "changed"] as const) {
      const f = fixture();
      const { capability } = await f.issue();
      if (kind === "foreign") f.setForeignOutput(true);
      if (kind === "large") f.setReadBytes(10_000);
      if (kind === "changed") f.setReadMutation(true);
      await expect(f.relay.read(capability, f.caller)).rejects.toThrow();
      expect(f.counts().continues).toBe(0);
    }
  });

  test("grant expires without polling and user can revoke before any destination read", async () => {
    const f = fixture();
    const { capability } = await f.issue();
    expect(await f.relay.revokeSource({ sourceSlot: 1, threadId: T })).toBe(1);
    await expect(f.relay.read(capability, f.caller)).rejects.toThrow("unavailable");
    const newGrant = await f.issue("continue", 1_000);
    f.advance(1000);
    await expect(f.relay.read(newGrant.capability, f.caller)).rejects.toThrow("unavailable");
  });

  test("source relogin, destination relogin, or owner route replacement invalidates a grant", async () => {
    for (const slot of [1, 2]) {
      const f = fixture();
      const { capability } = await f.issue();
      f.profiles.set(slot, binding(slot, slot === 1 ? "2" : "5"));
      await expect(f.relay.read(capability, f.caller)).rejects.toThrow("binding");
      await expect(f.relay.read(capability, f.caller)).rejects.toThrow("unavailable");
    }
  });

  test("continued turn executes on the original source, advances its revision and exact retry is idempotent", async () => {
    const f = fixture();
    const { capability } = await f.issue("continue");
    const view = await f.relay.read(capability, f.caller);
    expect(view.revision).toBe(OLD_REV);
    const input = f.continueInput(capability);
    const first = await f.relay.continue(input);
    expect(first).toMatchObject({ threadId: T, turnId: TURN, state: "completed", revision: NEW_REV });
    expect(f.counts()).toEqual({ continues: 1, revision: NEW_REV });
    expect(await f.relay.continue(input)).toEqual(first);
    expect(f.counts().continues).toBe(1);
    await expect(f.relay.continue({ ...input, message: "different private instruction" }))
      .rejects.toThrow("reused");
  });

  test("read grants cannot write; stale revision and active original writer cannot be overridden", async () => {
    const f = fixture();
    const read = await f.issue("read");
    await expect(f.relay.continue(f.continueInput(read.capability))).rejects.toThrow("reading only");
    const write = await f.issue("continue");
    f.setRevision(NEW_REV);
    await expect(f.relay.continue(f.continueInput(write.capability))).rejects.toThrow("advanced");
    f.setRevision(OLD_REV);
    f.setStatus("active");
    await expect(f.relay.continue(f.continueInput(write.capability))).rejects.toThrow("idle");
    expect(f.counts().continues).toBe(0);
  });

  test("two destination writes to the same original thread cannot execute simultaneously", async () => {
    const f = fixture();
    const { capability } = await f.issue("continue");
    const secondGrant = await f.issue("continue");
    const latch = f.holdContinue();
    const first = f.relay.continue(f.continueInput(capability));
    await latch.started;
    await expect(f.relay.continue(f.continueInput(secondGrant.capability))).rejects.toThrow("writer");
    latch.release();
    expect((await first).state).toBe("completed");
    expect(f.counts().continues).toBe(1);
  });

  test("a lost acknowledgement after dispatch makes the owner thread uncertain: no blind duplicate writer", async () => {
    const f = fixture();
    const { capability } = await f.issue("continue");
    f.setContinueFailure(true);
    const attempt = f.continueInput(capability);
    await expect(f.relay.continue(attempt)).rejects.toThrow("transport lost");
    await expect(f.relay.continue(attempt)).rejects.toThrow("never retry");
    const other = await f.issue("continue");
    await expect(f.relay.continue(f.continueInput(other.capability))).rejects.toThrow("uncertain writer");
    expect(f.counts().continues).toBe(1);
  });

  test("bounded original input forbids oversized or unsupported delegated Native requests", async () => {
    const f = fixture();
    const { capability } = await f.issue("continue");
    await expect(f.relay.continue({
      ...f.continueInput(capability), message: "x".repeat(8193),
    })).rejects.toThrow("too large");
    await expect(f.relay.continue({
      ...f.continueInput(capability), message: "invalid\u0000tool-escape",
    })).rejects.toThrow("invalid");
    expect(f.counts().continues).toBe(0);
  });
});
