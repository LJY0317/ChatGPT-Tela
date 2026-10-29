import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatToolRuntime } from "./tools";
import { ChatWorkspaceRegistry } from "./workspaces";
import { ProcessExecutionJournal } from "./process-execution-journal";
import { startProcessOwnerControl } from "./process-owner";
import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";

const removeFixture = registerTemporaryFixtureCleanup();

async function fixture(options: { holdWait?: boolean; rejectCompletionReply?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tela-owner-status-")), stateRoot = join(root, "state");
  mkdirSync(stateRoot);
  const registry = new ChatWorkspaceRegistry({ allowedRoots: [root], storePath: join(stateRoot, "workspaces-v1.json") });
  const workspace = registry.open(root), operationId = randomUUID(), serverInstanceId = randomUUID();
  const requestKey = randomBytes(32).toString("hex"), requestFingerprint = randomBytes(32).toString("hex");
  const timestamp = new Date().toISOString(), storePath = join(stateRoot, "process-operations-v1.json");
  writeFileSync(storePath, JSON.stringify({ version: 1, requestKey, operations: [{ operationId, workspaceId: workspace.id,
    serverInstanceId, requestFingerprint, sessionId: 1, state: "running", executionMode: "owned-worker-v1", startedAt: timestamp, updatedAt: timestamp }] }), { mode: 0o600 });
  const journal = new ProcessExecutionJournal({ root: `${storePath}.executions`, key: requestKey });
  const claim = journal.reserve({ operationId, workspaceId: workspace.id, launchingServerId: serverInstanceId, requestFingerprint });
  let queries = 0, waits = 0, writes = 0, cancellations = 0, wrongOwner = false;
  let releaseWait!: () => void;
  let markWaitStarted!: () => void;
  const waitGate = new Promise<void>(resolve => { releaseWait = resolve; });
  const waitStarted = new Promise<void>(resolve => { markWaitStarted = resolve; });
  let releaseCompletion!: () => void;
  const completionGate = new Promise<void>(resolve => { releaseCompletion = resolve; });
  const running = () => ({ operationId, workspaceId: workspace.id, serverInstanceId: wrongOwner ? randomUUID() : serverInstanceId,
    sessionId: 1, state: "running", startedAt: timestamp, updatedAt: timestamp, pid: 321,
    ioAvailable: true, output: "", outputTruncated: false, outputRecovered: false });
  const control = await startProcessOwnerControl({ binding: { ownerId: claim.ownerId, operationId, workspaceId: workspace.id },
    secret: randomBytes(32).toString("hex"), authority: {
      status() { queries++; return running(); },
      async wait() {
        waits++; markWaitStarted();
        if (options.holdWait) await waitGate;
        return { operationId, workspaceId: workspace.id, serverInstanceId,
          sessionId: 1, state: "spawn_failed", startedAt: timestamp,
          updatedAt: new Date().toISOString(), ioAvailable: false,
          output: "", outputTruncated: false, outputRecovered: false };
      }, write() { writes++; },
      async awaitCompletion() {
        waits++; markWaitStarted(); await completionGate;
        if (options.rejectCompletionReply) throw Error("completion reply unavailable");
        return { operationId, workspaceId: workspace.id, serverInstanceId,
          sessionId: 1, state: "spawn_failed", startedAt: timestamp,
          updatedAt: new Date().toISOString(), ioAvailable: false,
          output: "", outputTruncated: false, outputRecovered: false };
      },
      async cancelOwnedExecution() { cancellations++; return running(); },
    } });
  journal.publishLive(claim, control.descriptor);
  const runtime = createChatToolRuntime({ allowedRoots: [root], stateRoot });
  let completed = false;
  const complete = () => {
    if (completed) return;
    journal.publishCompletion(claim, { state: "spawn_failed", endedAt: new Date().toISOString() });
    completed = true;
    releaseCompletion();
  };
  return { workspace, operationId, serverInstanceId, runtime, storePath,
    complete, waitStarted, releaseWait, counts: () => ({ queries, waits, writes }),
    cancelRequests: () => cancellations,
    corruptOwner: () => { wrongOwner = true; }, async close() {
      complete();
      await runtime.close(); await control.close(); removeFixture(root);
    } };
}

test("public process status authenticates the current owner on demand without consuming output or input", async () => {
  const f = await fixture();
  try {
    expect(f.runtime.processes.status(f.workspace.id, f.operationId).liveness).toBe("unknown");
    expect(f.counts().queries).toBe(0);
    const listed = await f.runtime.call("list_processes", { workspace_id: f.workspace.id }) as { observation: string; processes: { operationId: string; liveness: string }[] };
    expect(listed.observation).toBe("registry");
    expect(listed.processes).toHaveLength(1);
    expect(listed.processes[0]!.operationId).toBe(f.operationId);
    expect(listed.processes[0]!.liveness).toBe("unknown");
    expect(f.counts()).toEqual({ queries: 0, waits: 0, writes: 0 });
    const observed = await f.runtime.call("process_status", { workspace_id: f.workspace.id, operation_id: f.operationId }) as Record<string, unknown>;
    expect(observed.state).toBe("running"); expect(observed.liveness).toBe("alive"); expect(observed.ioAvailable).toBe(true);
    expect(observed.serverInstanceId).toBe(f.serverInstanceId); expect(observed.pid).toBe(321);
    expect(observed).not.toHaveProperty("output"); expect(observed).not.toHaveProperty("secret");
    expect(f.counts()).toEqual({ queries: 1, waits: 0, writes: 0 });
    await expect(f.runtime.call("process_status", { workspace_id: "unapproved-workspace", operation_id: f.operationId })).rejects.toThrow();
    expect(f.counts().queries).toBe(1);
  } finally { await f.close(); }
});

test.each([false, true])("shutdown wait trusts the terminal receipt even with a lost reply: %s", async rejectCompletionReply => {
  const f = await fixture({ rejectCompletionReply });
  try {
    const waiting = f.runtime.processes.waitUntilResolved();
    await f.waitStarted;
    expect(() => f.runtime.processes.assertCanClose()).toThrow("unresolved execution");
    f.complete();
    await waiting;
    expect(f.cancelRequests()).toBe(0);
    expect(f.runtime.processes.status(f.workspace.id, f.operationId).state).toBe("spawn_failed");
    expect(() => f.runtime.processes.assertCanClose()).not.toThrow();
  } finally { await f.close(); }
});

test("owned cancellation replies with one owner exchange and waits for signed terminal evidence before shutdown", async () => {
  const f = await fixture();
  try {
    const cancelled = await f.runtime.call("cancel_process", { workspace_id: f.workspace.id,
      operation_id: f.operationId }) as { state: string; liveness: string };
    expect(cancelled.state).toBe("running");
    expect(cancelled.liveness).toBe("alive");
    expect(f.cancelRequests()).toBe(1);
    expect(f.counts()).toEqual({ queries: 0, waits: 0, writes: 0 });
    expect(() => f.runtime.processes.assertCanClose()).toThrow("unresolved execution");
    f.complete();
    const terminal = await f.runtime.call("process_status", { workspace_id: f.workspace.id,
      operation_id: f.operationId }) as { state: string; liveness: string };
    expect(terminal.state).toBe("spawn_failed");
    expect(terminal.liveness).toBe("not_running");
    expect(() => f.runtime.processes.assertCanClose()).not.toThrow();
  } finally { await f.close(); }
});

test("a signed response from a different launch owner cannot become live process status", async () => {
  const f = await fixture();
  try {
    f.corruptOwner();
    await expect(f.runtime.call("process_status", { workspace_id: f.workspace.id, operation_id: f.operationId })).rejects.toThrow("snapshot");
    expect(f.runtime.processes.status(f.workspace.id, f.operationId).liveness).toBe("unknown");
    expect(f.counts()).toEqual({ queries: 1, waits: 0, writes: 0 });
  } finally { await f.close(); }
});


test("failed signed completion commit cannot leak a terminal registry state", async () => {
  const f = await fixture(), backup = `${f.storePath}.saved`;
  let blocked = false;
  try {
    f.complete();
    const saved = readFileSync(f.storePath, "utf8");
    renameSync(f.storePath, backup); mkdirSync(f.storePath); blocked = true;
    expect(() => f.runtime.processes.status(f.workspace.id, f.operationId)).toThrow();
    const listed = await f.runtime.call("list_processes", { workspace_id: f.workspace.id }) as {
      processes: { state: string }[];
    };
    expect(listed.processes).toHaveLength(1);
    expect(listed.processes[0]!.state).toBe("unknown");
    await expect(f.runtime.close()).rejects.toThrow();
    expect(readFileSync(backup, "utf8")).toBe(saved);
    expect(f.counts()).toEqual({ queries: 0, waits: 0, writes: 0 });
    rmSync(f.storePath, { recursive: true }); renameSync(backup, f.storePath); blocked = false;
    expect(f.runtime.processes.status(f.workspace.id, f.operationId).state).toBe("spawn_failed");
    await f.runtime.close();
  } finally {
    if (blocked) { rmSync(f.storePath, { recursive: true }); renameSync(backup, f.storePath); }
    await f.close();
  }
});

test("an in-flight owner wait accepts a completion archived by another authenticated observer", async () => {
  const f = await fixture({ holdWait: true });
  try {
    const waiting = f.runtime.processes.writeStdin({
      workspaceId: f.workspace.id, sessionId: 1, yieldTimeMs: 0,
    });
    await f.waitStarted;
    f.complete();
    expect(f.runtime.processes.status(f.workspace.id, f.operationId).state).toBe("spawn_failed");
    const capacity = f.runtime.processes.list({ workspaceId: f.workspace.id }).capacity;
    expect(capacity.registryCount).toBe(0);
    expect(capacity.archivedTerminalCount).toBe(1);
    f.releaseWait();
    const completed = await waiting;
    expect(completed.state).toBe("spawn_failed");
    expect(completed.operationId).toBe(f.operationId);
    expect(f.counts().waits).toBe(1);
  } finally { f.releaseWait(); await f.close(); }
});
