/** Run with `bun run packages/chat-service/src/process-completion-archive.integration.ts`.
 * This is a standalone process integration, not a Bun test-worker: the
 * macOS bun:test child-process sandbox has separately been observed to reject
 * even a bare /bin/sh spawn with EBADF, without any Tela code running.
 */
import { strict as assert } from "node:assert";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatWorkspaceRegistry } from "./workspaces";
import { ChatProcessManager } from "./processes";
import { ProcessCompletionArchive } from "./process-completion-archive";

type Fixture = ReturnType<typeof fixture>;
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tela-completed-reservations-e2e-"));
  const root = join(base, "workspace");
  mkdirSync(root);
  const registry = new ChatWorkspaceRegistry({ allowedRoots: [root], storePath: join(base, "workspaces.json") });
  const workspace = registry.open(root);
  const storePath = join(base, "operations.json");
  const key = "b".repeat(64);
  const now = new Date().toISOString();
  const previousCommand = "printf should-never-repeat > replay-marker.txt";
  const firstId = randomUUID();
  const priorRequestFingerprint = createHmac("sha256", Buffer.from(key, "hex"))
    .update(JSON.stringify(["tela-chat-exec-v1", workspace.id, workspace.root, previousCommand]))
    .digest("hex");
  const operations = Array.from({ length: 1024 }, (_, index) => ({
    operationId: index === 0 ? firstId : randomUUID(), serverInstanceId: randomUUID(),
    workspaceId: workspace.id, sessionId: index + 1,
    ...(index === 0 ? { requestFingerprint: priorRequestFingerprint } : {}),
    state: "exited" as const, startedAt: now, updatedAt: now, endedAt: now, exitCode: 0,
  }));
  writeFileSync(storePath, JSON.stringify({ version: 2, requestKey: key, nextSessionId: 1025, operations }));
  return { base, root, registry, workspace, storePath, key, firstId, previousCommand, operations };
}

async function exerciseRecentCompletions(f: Fixture) {
  let manager = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
  // A legacy full hot store is drained at startup, without an execution
  // request or a periodic timer. All 1,024 identities remain queryable.
  assert.equal(manager.list({ workspaceId: f.workspace.id }).capacity.registryCount, 0);
  assert.equal(manager.list({ workspaceId: f.workspace.id }).capacity.archivedTerminalCount, 1024);
  assert.equal(manager.list({ workspaceId: f.workspace.id }).capacity.admissionOutlook, "slot_available");
  const fresh = await manager.exec({ workspaceId: f.workspace.id, command: "printf new-command-executed", yieldTimeMs: 3000 });
  assert.equal(fresh.state, "exited");
  assert.equal(fresh.output, "new-command-executed");
  assert.equal(fresh.sessionId, 1025);
  assert.equal(manager.status(f.workspace.id, f.firstId).state, "exited");
  assert.equal(manager.list({ workspaceId: f.workspace.id }).capacity.registryCount, 0);
  assert.equal(manager.list({ workspaceId: f.workspace.id }).capacity.admissionOutlook, "slot_available");
  const retained = new ProcessCompletionArchive(`${f.storePath}.completed.sqlite`, f.key);
  try { assert.equal(retained.count(), 1025); assert.equal(retained.get(f.firstId)?.sessionId, 1); }
  finally { retained.close(); }
  assert.equal(manager.list({ workspaceId: f.workspace.id, includeCompleted: true, limit: 1 }).processes[0]?.operationId, f.firstId);
  await manager.close();
  manager = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
  try {
    const replay = await manager.exec({ workspaceId: f.workspace.id, operationId: f.firstId,
      command: f.previousCommand, yieldTimeMs: 0 });
    assert.equal(replay.operationId, f.firstId);
    assert.equal(replay.state, "exited");
    assert.equal(existsSync(join(f.root, "replay-marker.txt")), false);
    await assert.rejects(manager.exec({ workspaceId: f.workspace.id, operationId: f.firstId,
      command: "printf not-the-original-command", yieldTimeMs: 0 }), /does not match/);
    const recovered = await manager.exec({ workspaceId: f.workspace.id, operationId: fresh.operationId,
      command: "printf new-command-executed", yieldTimeMs: 0 });
    assert.equal(recovered.output, "new-command-executed");
    assert.equal(recovered.outputRecovered, true);
  } finally { await manager.close(); }
}

async function exerciseInterruptedArchival(f: Fixture) {
  const archive = new ProcessCompletionArchive(`${f.storePath}.completed.sqlite`, f.key);
  archive.save(f.operations[0]!);
  archive.close();
  const manager = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
  try {
    // Crash after archive publication but before hot-store publication must
    // neither duplicate discovery nor allow the original operation to rerun.
    const first = manager.list({ workspaceId: f.workspace.id, includeCompleted: true, limit: 10 });
    assert.equal(first.processes.filter(row => row.operationId === f.firstId).length, 1);
    const accepted = await manager.exec({ workspaceId: f.workspace.id, command: "printf crash-resumed", yieldTimeMs: 3000 });
    assert.equal(accepted.state, "exited");
    assert.equal(accepted.output, "crash-resumed");
    assert.equal(existsSync(join(f.root, "replay-marker.txt")), false);
  } finally { await manager.close(); }
}

async function exerciseIncrementalOutputAfterEagerArchival() {
  const f = fixture();
  // Verify the distinct fresh-store case too, not only legacy hot migration.
  rmSync(f.storePath);
  let manager = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
  const operationId = randomUUID();
  const command = "printf alpha; sleep 0.2; printf omega";
  try {
    const started = await manager.exec({ workspaceId: f.workspace.id,
      operationId, command, yieldTimeMs: 40 });
    assert.equal(started.state === "running" || started.state === "starting", true);
    assert.equal(started.output, "alpha");
    const completed = await manager.writeStdin({
      workspaceId: f.workspace.id, sessionId: started.sessionId, yieldTimeMs: 3000,
    });
    assert.equal(completed.state, "exited");
    assert.equal(completed.output, "omega");
    assert.equal(completed.outputRecovered, false);
    assert.equal(manager.list({ workspaceId: f.workspace.id }).capacity.registryCount, 0);
    assert.equal(manager.list({ workspaceId: f.workspace.id }).capacity.archivedTerminalCount, 1);
    const reread = await manager.writeStdin({ workspaceId: f.workspace.id,
      sessionId: started.sessionId, yieldTimeMs: 0 });
    assert.equal(reread.output, "");
    const duplicate = await manager.exec({ workspaceId: f.workspace.id,
      operationId, command, yieldTimeMs: 0 });
    assert.equal(duplicate.output, "");
    await assert.rejects(manager.exec({ workspaceId: f.workspace.id,
      operationId, command: "printf unauthorized-replay", yieldTimeMs: 0 }), /does not match/);
    await manager.close();
    manager = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
    const recovered = await manager.exec({ workspaceId: f.workspace.id,
      operationId, command, yieldTimeMs: 0 });
    assert.equal(recovered.output, "alphaomega");
    assert.equal(recovered.outputRecovered, true);
    assert.equal(manager.status(f.workspace.id, operationId).state, "exited");
    assert.equal(manager.list({ workspaceId: f.workspace.id }).capacity.registryCount, 0);
  } finally {
    await manager.close();
    rmSync(f.base, { recursive: true, force: true });
  }
}

async function main() {
  const first = fixture(), second = fixture();
  try {
    await exerciseRecentCompletions(first);
    await exerciseInterruptedArchival(second);
    await exerciseIncrementalOutputAfterEagerArchival();
    console.log("PASS: event-driven terminal separation, incremental output cursor, exact replay, restart, interrupted publication, stable high-water mark");
  } finally {
    rmSync(first.base, { recursive: true, force: true });
    rmSync(second.base, { recursive: true, force: true });
  }
}

await main();
