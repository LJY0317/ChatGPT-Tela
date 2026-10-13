import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalOriginalThreadOwner, LocalProfileBinding } from "./cross-profile-thread-relay";
import {
  handoffOneSelectedNativeConversation, type ExactNativeWorkspaceCheckpoint,
  type OneChatCheckpointHandoffAdapters,
} from "./one-chat-checkpoint-handoff";
import { SqliteOneChatHandoffJournal } from "./one-chat-handoff-journal";

const SOURCE = "12345678-1234-4123-8123-123456789abc";
const DEST = "abcdef12-1234-4123-8123-123456789abc";
const TURN = "abcdef12-abcd-4cde-8abc-123456789abc";
const OP = "55555555-5555-4555-8555-555555555555";
const REV = "a".repeat(64);
const WORKSPACE = "b".repeat(64);
const head = "c".repeat(64);
const binding = (slot: number, seed: string): LocalProfileBinding => ({
  slot, accountFingerprint: seed.repeat(64),
  sessionFingerprint: String((Number(seed) + 1) % 10).repeat(64),
  routeFingerprint: String((Number(seed) + 2) % 10).repeat(64),
});
const sourceBinding = binding(1, "1"), destBinding = binding(2, "4");
const open = new Set<SqliteOneChatHandoffJournal>();
const dirs = new Set<string>();
afterEach(() => {
  for (const journal of open) journal.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  open.clear(); dirs.clear();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tela-one-chat-native-handoff-"));
  dirs.add(dir);
  const journalFile = join(dir, "tela-private", "handoffs.sqlite");
  const journal = new SqliteOneChatHandoffJournal(journalFile);
  open.add(journal);
  let source = sourceBinding, destination = destBinding;
  let revision = REV;
  let sourceState: "idle" | "active" = "idle";
  let emptySource = false, includeOlder = true, hugeSource = false;
  let changeDuringSourceRead = false;
  let sourceReadCalls = 0, sourceProveCalls = 0, targetStarts = 0, targetSeeds = 0;
  let workspace: ExactNativeWorkspaceCheckpoint = {
    threadId: SOURCE, workspaceFingerprint: WORKSPACE,
    cwd: "/synthetic-project/owner-worktree",
    git: { branch: "development", commit: head, trackedChanges: 2, untrackedChanges: 1, conflicts: 0 },
    admission: "source-idle-no-other-writer",
  };
  let onStart: (() => void) | undefined, onSeed: (() => void) | undefined;
  let rejectStart = false, rejectSeed = false, ambiguousSeed = false;
  const owner: LocalOriginalThreadOwner = {
    async prove(threadId) {
      sourceProveCalls++;
      if (threadId !== SOURCE) throw new Error("Not the selected original conversation");
      return {
        threadId, owner: source, workspaceFingerprint: WORKSPACE,
        revision, state: sourceState,
      };
    },
    async read(threadId, maxBytes) {
      sourceReadCalls++;
      if (threadId !== SOURCE || maxBytes > 128 * 1024) throw new Error("Foreign or unbounded Native read");
      const observedRevision = revision;
      if (changeDuringSourceRead) revision = "d".repeat(64);
      return {
        threadId, revision: observedRevision, hasMore: includeOlder,
        turns: emptySource ? [] : [{
          threadId, turnId: TURN, state: "completed",
          text: hugeSource ? "old-private-user-text ".repeat(4000)
            : "User: fix synthetic one-chat CLI\nAssistant: tests passed, finish task A",
        }],
      };
    },
    async continue() { throw new Error("Never write in the original source during checkpoint transfer"); },
  };
  const calls: { method: "start" | "seed"; slot: number; id?: string; text?: string; cwd?: string }[] = [];
  const adapters: OneChatCheckpointHandoffAdapters = {
    journal,
    async profile(slot) {
      if (slot === 1) return source;
      if (slot === 2) return destination;
      throw new Error("Unowned target slot");
    },
    async source(slot) {
      if (slot !== 1) throw new Error("Unowned original");
      return owner;
    },
    async workspace(slot, threadId) {
      if (slot !== 1 || threadId !== SOURCE) throw new Error("Foreign worktree");
      return workspace;
    },
    destination: {
      async start(input) {
        targetStarts++;
        calls.push({ method: "start", slot: input.destinationSlot, cwd: input.cwd });
        onStart?.();
        if (rejectStart) throw new Error("New Native thread may have been created before network loss");
        return { threadId: DEST };
      },
      async seed(input) {
        targetSeeds++;
        calls.push({
          method: "seed", slot: input.destinationSlot,
          id: input.threadId, text: input.message,
        });
        onSeed?.();
        if (rejectSeed) throw new Error("Initial Native turn may have started before network loss");
        return ambiguousSeed ? { turnId: "" } : { turnId: TURN };
      },
    },
  };
  const input = {
    operationId: OP, sourceSlot: 1, destinationSlot: 2,
    sourceThreadId: SOURCE, explicitlySelectedAndApproved: true,
  };
  return {
    input, adapters, journal, journalFile, calls,
    run: () => handoffOneSelectedNativeConversation(input, adapters),
    counts: () => ({
      sourceReadCalls, sourceProveCalls, targetStarts, targetSeeds,
    }),
    setSourceState: (s: "idle" | "active") => { sourceState = s; },
    setRevision: (r: string) => { revision = r; },
    setEmpty: () => { emptySource = true; },
    setHuge: () => { hugeSource = true; },
    setChangeDuringSourceRead: () => { changeDuringSourceRead = true; },
    setHasMore: (v: boolean) => { includeOlder = v; },
    setWorkspace: (v: ExactNativeWorkspaceCheckpoint) => { workspace = v; },
    setDest: (v: LocalProfileBinding) => { destination = v; },
    mutateAfterStart: (fn: () => void) => { onStart = fn; },
    mutateAfterSeed: (fn: () => void) => { onSeed = fn; },
    rejectStart: () => { rejectStart = true; },
    rejectSeed: () => { rejectSeed = true; },
    ambiguousSeed: () => { ambiguousSeed = true; },
    reopen: () => {
      const x = new SqliteOneChatHandoffJournal(journalFile);
      open.add(x);
      return x;
    },
  };
}

describe("one explicitly selected native Work/Codex conversation -> new destination account thread", () => {
  test("one action seeds exactly one NEW destination Native thread with honest bounded continuity", async () => {
    const f = fixture();
    const receipt = await f.run();
    expect(receipt).toEqual({
      mode: "new_native_thread_with_bounded_checkpoint",
      sourceSlot: 1, destinationSlot: 2,
      sourceThreadId: SOURCE, destinationThreadId: DEST, destinationTurnId: TURN,
      startup: "initial_turn_accepted_not_yet_completed",
      sourceOriginalPreserved: true, sourceOwnershipTransferred: false,
      fullSourceHistoryTransferred: false, olderSourceTurnsOmitted: true,
    });
    expect(f.calls.map(x => x.method)).toEqual(["start", "seed"]);
    expect(f.calls[0]?.cwd).toBe("/synthetic-project/owner-worktree");
    expect(f.calls[1]?.slot).toBe(2);
    expect(f.calls[1]?.id).toBe(DEST);
    const message = f.calls[1]?.text ?? "";
    expect(message).toContain("WARNING: Earlier conversation turns were not transferred.");
    expect(message).toContain("finish task A");
    expect(message).toContain("tracked/untracked changes: 2/1");
    expect(message).toContain("Do not call tools, edit files");
    expect(message).toContain(SOURCE);
    expect(message).not.toContain("same original thread ID is now owned");
    expect(f.journal.get(OP)).toMatchObject({
      state: "seeded", destinationThreadId: DEST, destinationTurnId: TURN,
    });
    // No chat text or personal credentials persist in the SQLite receipt.
    expect(readFileSync(f.journalFile).includes(Buffer.from("finish task A"))).toBe(false);
  });

  test("a settled initial turn acceptance does not trigger another model call when clicked twice", async () => {
    const f = fixture();
    await f.run();
    await expect(f.run()).rejects.toThrow("never retry automatically");
    expect(f.counts()).toMatchObject({ targetStarts: 1, targetSeeds: 1 });
    const journalAfterRestart = f.reopen();
    expect(journalAfterRestart.get(OP)).toMatchObject({
      state: "seeded", destinationThreadId: DEST, destinationTurnId: TURN,
    });
    await expect(handoffOneSelectedNativeConversation(f.input, { ...f.adapters, journal: journalAfterRestart }))
      .rejects.toThrow("never retry automatically");
    expect(f.counts()).toMatchObject({ targetStarts: 1, targetSeeds: 1 });
  });

  test("source revision changed during checkpoint creation must not create a destination", async () => {
    const f = fixture();
    f.setChangeDuringSourceRead();
    await expect(f.run()).rejects.toThrow("changed before new thread admission");
    expect(f.counts()).toMatchObject({ targetStarts: 0, targetSeeds: 0 });
    expect(f.journal.get(OP)).toBeUndefined();
    const g = fixture();
    g.mutateAfterStart(() => undefined);
    g.setSourceState("active");
    await expect(g.run()).rejects.toThrow("idle");
    expect(g.counts()).toMatchObject({ targetStarts: 0, targetSeeds: 0 });
  });

  test("a new click ID cannot silently create a duplicate from the same source checkpoint", async () => {
    const f = fixture();
    await f.run();
    await expect(handoffOneSelectedNativeConversation({
      ...f.input, operationId: "99999999-9999-4999-8999-999999999999",
    }, f.adapters)).rejects.toThrow("already attempted");
    expect(f.counts()).toMatchObject({ targetStarts: 1, targetSeeds: 1 });
  });

  test("foreign selection, unknown source, same profile, and missing user approval never create a new chat", async () => {
    const f = fixture();
    for (const overrides of [
      { explicitlySelectedAndApproved: false },
      { sourceThreadId: "87654321-1234-4123-8123-abcdefabcdef" },
      { destinationSlot: 1 },
      { sourceSlot: 0 },
    ]) {
      await expect(handoffOneSelectedNativeConversation({ ...f.input, ...overrides }, f.adapters))
        .rejects.toThrow();
    }
    expect(f.counts()).toMatchObject({ targetStarts: 0, targetSeeds: 0 });
  });

  test("unknown/active checkout owner or conflicts fail before any destination effect", async () => {
    for (const issue of [
      (w: ExactNativeWorkspaceCheckpoint) => ({ ...w, admission: "unknown" as const }),
      (w: ExactNativeWorkspaceCheckpoint) => ({ ...w, workspaceFingerprint: "f".repeat(64) }),
      (w: ExactNativeWorkspaceCheckpoint) => ({ ...w, git: { ...w.git, conflicts: 1 } }),
      (w: ExactNativeWorkspaceCheckpoint) => ({ ...w, cwd: "relative/path" }),
    ]) {
      const f = fixture();
      const w = await f.adapters.workspace(1, SOURCE);
      f.setWorkspace(issue(w));
      await expect(f.run()).rejects.toThrow();
      expect(f.counts()).toMatchObject({ targetStarts: 0, targetSeeds: 0 });
      expect(f.journal.get(OP)).toBeUndefined();
    }
  });

  test("insufficient or huge source history blocks without new Native threads", async () => {
    const empty = fixture(); empty.setEmpty();
    await expect(empty.run()).rejects.toThrow("no bounded");
    const huge = fixture(); huge.setHuge();
    await expect(huge.run()).rejects.toThrow("too large");
    expect(huge.counts()).toMatchObject({ targetStarts: 0, targetSeeds: 0 });
    expect(empty.journal.get(OP)).toBeUndefined();
  });

  test("a lost thread/start reply is journaled uncertain and never retried", async () => {
    const f = fixture();
    f.rejectStart();
    await expect(f.run()).rejects.toThrow("may have happened");
    expect(f.journal.get(OP)).toMatchObject({ state: "uncertain" });
    expect(f.counts()).toMatchObject({ targetStarts: 1, targetSeeds: 0 });
    await expect(f.run()).rejects.toThrow("never retry automatically");
    expect(f.counts().targetStarts).toBe(1);
  });

  test("target account change AFTER creation records the partial thread but never seeds an unknown account", async () => {
    const f = fixture();
    f.mutateAfterStart(() => f.setDest(binding(2, "7")));
    await expect(f.run()).rejects.toThrow("inspect the exact destination");
    expect(f.counts()).toMatchObject({ targetStarts: 1, targetSeeds: 0 });
    expect(f.journal.get(OP)).toMatchObject({ state: "uncertain", destinationThreadId: DEST });
  });

  test("lost or invalid first turn acknowledgement leaves exact possible destination, no second send", async () => {
    for (const issue of ["transport", "ack"] as const) {
      const f = fixture();
      if (issue === "transport") f.rejectSeed();
      else f.ambiguousSeed();
      await expect(f.run()).rejects.toThrow("inspect the exact destination");
      expect(f.journal.get(OP)).toMatchObject({
        state: "uncertain", destinationThreadId: DEST,
      });
      await expect(f.run()).rejects.toThrow("never retry automatically");
      expect(f.counts()).toMatchObject({ targetStarts: 1, targetSeeds: 1 });
    }
  });
});
