import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import type { LocalProfileBinding } from "./cross-profile-thread-relay";
import type { TrustedNativeProfileSession } from "./cross-profile-account-proof";
import {
  createOwnedNewNativeThreadTarget, isExactDeletedNativeThreadAbsent,
} from "./one-chat-native-destination";

const THREAD = "abcdef12-1234-4123-8123-123456789abc";
const TURN = "abcdef12-abcd-4cde-8abc-123456789abc";
const fp = (c: string) => c.repeat(64);
const folders = new Set<string>();
afterEach(() => {
  for (const folder of folders) rmSync(folder, { force: true, recursive: true });
  folders.clear();
});

function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tela-destination-native-")));
  folders.add(cwd);
  let binding: LocalProfileBinding = {
    slot: 2, accountFingerprint: fp("a"), sessionFingerprint: fp("b"), routeFingerprint: fp("c"),
  };
  let session: TrustedNativeProfileSession = {
    slot: 2, runtimeProcessId: 1234, responsesRouteFingerprint: fp("c"),
    terminalEndpoint: "ws://127.0.0.1:45555",
  };
  let remoteStatus = "idle";
  let ambiguousStart = false, ambiguousSeed = false, failAfterSeed = false;
  let starts = 0, seeds = 0, connects = 0, closes = 0;
  let onStart: (() => void) | undefined, onSeed: (() => void) | undefined;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const destination = createOwnedNewNativeThreadTarget({
    async profile(slot) {
      if (slot !== 2) throw Error("Unknown destination owner");
      return binding;
    },
    async session(slot) {
      if (slot !== 2) throw Error("No exact Native session");
      return session;
    },
    async connect(endpoint) {
      if (endpoint !== session.terminalEndpoint) throw Error("Unsafe endpoint");
      connects++;
      return {
        async request(method, params) {
          calls.push({ method, params: params as Record<string, unknown> });
          if (method === "thread/start") {
            starts++;
            onStart?.();
            if (ambiguousStart) return { thread: {} };
            return { thread: { id: THREAD, cwd, ephemeral: false, status: { type: "idle" } } };
          }
          if (method === "thread/read") {
            return { thread: { id: THREAD, cwd, status: { type: remoteStatus } } };
          }
          if (method === "turn/start") {
            seeds++;
            onSeed?.();
            if (failAfterSeed) throw Error("Transport acknowledgement lost after turn/start");
            return { turn: { id: ambiguousSeed ? "" : TURN, status: "inProgress" } };
          }
          throw Error("No unrelated thread/list or private Native RPC");
        },
        async close() { closes++; },
      } as Pick<CodexAppServerRpc, "request" | "close">;
    },
  });
  return {
    cwd, destination, calls,
    counts: () => ({ starts, seeds, connects, closes }),
    switchAccount: () => { binding = { ...binding, accountFingerprint: fp("d") }; },
    replaceRuntime: () => { session = { ...session, runtimeProcessId: 54321 }; },
    setEndpoint: (url: string) => { session = { ...session, terminalEndpoint: url }; },
    setThreadStatus: (status: string) => { remoteStatus = status; },
    onStart: (callback: () => void) => { onStart = callback; },
    onSeed: (callback: () => void) => { onSeed = callback; },
    ambiguousStart: () => { ambiguousStart = true; },
    ambiguousSeed: () => { ambiguousSeed = true; },
    failAfterSeed: () => { failAfterSeed = true; },
  };
}

describe("official Native new-thread destination under its OWN profile", () => {
  test("post-delete absence proof rejects transport and empty-rollout errors", () => {
    expect(isExactDeletedNativeThreadAbsent(new Error(`thread not loaded: ${THREAD}`), THREAD)).toBe(true);
    expect(isExactDeletedNativeThreadAbsent(new Error(`thread not found: ${THREAD}`), THREAD)).toBe(true);
    expect(isExactDeletedNativeThreadAbsent(new Error("Socket closed"), THREAD)).toBe(false);
    expect(isExactDeletedNativeThreadAbsent(new Error("rollout is empty"), THREAD)).toBe(false);
    expect(isExactDeletedNativeThreadAbsent(new Error("thread not loaded: " + TURN), THREAD)).toBe(false);
  });
  test("reserves one fresh destination thread then sends one safe read-only initial receipt turn", async () => {
    const f = fixture();
    const created = await f.destination.start({ destinationSlot: 2, cwd: f.cwd });
    expect(created).toEqual({ threadId: THREAD });
    const seeded = await f.destination.seed({
      destinationSlot: 2, threadId: created.threadId, message: "Synthetic bounded checkpoint only",
    });
    expect(seeded).toEqual({ turnId: TURN });
    expect(f.calls.map(x => x.method)).toEqual(["thread/start", "turn/start"]);
    expect(f.calls[0]?.params).toMatchObject({
      cwd: f.cwd, ephemeral: false, sandbox: "read-only", approvalPolicy: "never",
    });
    expect(f.calls[1]?.params).toMatchObject({
      threadId: THREAD, input: [{ type: "text", text: "Synthetic bounded checkpoint only" }],
      approvalPolicy: "never",
    });
    expect(f.counts()).toEqual({ starts: 1, seeds: 1, connects: 2, closes: 2 });
  });

  test("cannot reuse a bootstrap ID or send twice even if the ACK is lost", async () => {
    const f = fixture();
    const created = await f.destination.start({ destinationSlot: 2, cwd: f.cwd });
    f.failAfterSeed();
    await expect(f.destination.seed({
      destinationSlot: 2, threadId: created.threadId, message: "Only first send",
    })).rejects.toThrow("Transport acknowledgement lost");
    await expect(f.destination.seed({
      destinationSlot: 2, threadId: created.threadId, message: "Only first send",
    })).rejects.toThrow("not from this exact");
    expect(f.counts()).toMatchObject({ starts: 1, seeds: 1 });
  });

  test("account changed after thread reservation prevents sending checkpoint", async () => {
    const f = fixture();
    const created = await f.destination.start({ destinationSlot: 2, cwd: f.cwd });
    f.switchAccount();
    await expect(f.destination.seed({
      destinationSlot: 2, threadId: created.threadId, message: "Do not send",
    })).rejects.toThrow("changed before");
    expect(f.counts()).toMatchObject({ starts: 1, seeds: 0 });
  });

  test("owner change during start fails without allowing followup on uncertain owner", async () => {
    const f = fixture();
    f.onStart(() => f.replaceRuntime());
    await expect(f.destination.start({ destinationSlot: 2, cwd: f.cwd }))
      .rejects.toThrow("changed after");
    expect(f.counts()).toMatchObject({ starts: 1, seeds: 0, closes: 1 });
  });

  test("ambiguous initial Native start/turn acknowledgements do not create a verified receipt", async () => {
    const start = fixture(); start.ambiguousStart();
    await expect(start.destination.start({ destinationSlot: 2, cwd: start.cwd }))
      .rejects.toThrow("fresh owned Native conversation");
    expect(start.counts().seeds).toBe(0);
    const turn = fixture();
    const created = await turn.destination.start({ destinationSlot: 2, cwd: turn.cwd });
    turn.ambiguousSeed();
    await expect(turn.destination.seed({ destinationSlot: 2, threadId: created.threadId, message: "Do not retry" }))
      .rejects.toThrow("acknowledgement was ambiguous");
    expect(turn.counts().seeds).toBe(1);
  });

  test("only the newly reserved thread can be seeded once: not an arbitrary ID or foreign owner", async () => {
    const f = fixture();
    const created = await f.destination.start({ destinationSlot: 2, cwd: f.cwd });
    await expect(f.destination.seed({ destinationSlot: 2,
      threadId: "99999999-9999-4999-8999-999999999999", message: "Foreign" }))
      .rejects.toThrow("not from this exact");
    expect(f.counts().seeds).toBe(0);
    await expect(f.destination.seed({ destinationSlot: 1, threadId: created.threadId, message: "Wrong account" }))
      .rejects.toThrow("not from this exact");
    expect(f.counts().seeds).toBe(0);
    expect(await f.destination.seed({ destinationSlot: 2, threadId: THREAD,
      message: "First new thread without a readable empty rollout" })).toEqual({ turnId: TURN });
    expect(f.calls.map(x => x.method)).toEqual(["thread/start", "turn/start"]);
  });

  test("foreign destinations, invalid worktree, oversized prompts and non-loopback sessions fail closed", async () => {
    const f = fixture();
    await expect(f.destination.start({ destinationSlot: 1, cwd: f.cwd }))
      .rejects.toThrow("Unknown destination owner");
    await expect(f.destination.start({ destinationSlot: 2, cwd: "relative" }))
      .rejects.toThrow("exact absolute");
    f.setEndpoint("ws://192.0.2.1:7070");
    await expect(f.destination.start({ destinationSlot: 2, cwd: f.cwd }))
      .rejects.toThrow("exact loopback");
    f.setEndpoint("ws://127.0.0.1:45555");
    const created = await f.destination.start({ destinationSlot: 2, cwd: f.cwd });
    await expect(f.destination.seed({ destinationSlot: 2, threadId: created.threadId, message: "x".repeat(30_000) }))
      .rejects.toThrow("oversized");
    expect(f.counts().seeds).toBe(0);
  });
});
