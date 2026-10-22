import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { ChatWorkspaceRegistry } from "./workspaces";
import { ChatProcessManager } from "./processes";
import { ProcessExecutionJournal } from "./process-execution-journal";
import { ProcessCompletionArchive } from "./process-completion-archive";
import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";

const removeFixture = registerTemporaryFixtureCleanup();

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tela-chat-process-"));
  const root = join(base, "project");
  mkdirSync(root);
  const registry = new ChatWorkspaceRegistry({ allowedRoots: [root], storePath: join(base, "workspaces.json") });
  const workspace = registry.open(root);
  const storePath = join(base, "operations.json");
  return { base, root, registry, workspace, storePath,
    manager: new ChatProcessManager({ workspaces: registry, storePath }) };
}

describe("Tela Chat process operations", () => {
  test("recent completed reservations above the former 256 limit are not discarded", async () => {
    const f = fixture();
    const now = new Date().toISOString();
    const previous = Array.from({ length: 256 }, (_, index) => ({
      operationId: randomUUID(), serverInstanceId: randomUUID(), workspaceId: f.workspace.id,
      sessionId: index + 1, state: "exited", startedAt: now, updatedAt: now,
      endedAt: now, exitCode: 0,
    }));
    writeFileSync(f.storePath, JSON.stringify({ version: 1, nextSessionId: 257, operations: previous }));
    const recovered = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
    try {
      const newRun = await recovered.exec({
        workspaceId: f.workspace.id, command: "printf capacity-headroom", yieldTimeMs: 1000,
      });
      expect(newRun.state).toBe("exited");
      expect(newRun.sessionId).toBe(257);
      expect(newRun.output).toBe("capacity-headroom");
      const stored = JSON.parse(readFileSync(f.storePath, "utf8"));
      // Startup transfers existing completed entries into independent,
      // authenticated SQLite receipts. New completions do not occupy hot
      // unresolved capacity after their output has been committed.
      expect(stored.operations).toHaveLength(0);
      expect(recovered.status(f.workspace.id, previous[0]!.operationId).state).toBe("exited");
      expect(recovered.list({ workspaceId: f.workspace.id }).capacity.archivedTerminalCount).toBe(257);
      expect(stored.nextSessionId).toBe(258);
    } finally { await recovered.close(); await f.manager.close(); removeFixture(f.base); }
  });
  test("failed completion commit retains uncertainty and blocks shutdown across restart", async () => {
    if (process.platform === "win32") return;
    const f = fixture(), backup = `${f.storePath}.saved`;
    let blocked = false, sessionId: number | undefined;
    try {
      const live = await f.manager.exec({ workspaceId: f.workspace.id,
        command: "read value; printf completed", interactive: true, yieldTimeMs: 10 });
      sessionId = live.sessionId;
      expect(live.state).toBe("running");
      const saved = readFileSync(f.storePath, "utf8");
      renameSync(f.storePath, backup); mkdirSync(f.storePath); blocked = true;
      const result = await f.manager.writeStdin({ workspaceId: f.workspace.id, sessionId,
        chars: "finish\n", yieldTimeMs: 1000 });
      expect(result.state).toBe("unknown");
      expect(result.output).toBe("completed");
      expect(result.ioAvailable).toBe(false);
      expect(readFileSync(backup, "utf8")).toBe(saved);
      await expect(f.manager.close()).rejects.toThrow("unresolved execution");
      rmSync(f.storePath, { recursive: true }); renameSync(backup, f.storePath); blocked = false;
      const reopened = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
      expect(reopened.status(f.workspace.id, live.operationId).state).toBe("unknown");
      expect(reopened.status(f.workspace.id, live.operationId).ioAvailable).toBe(false);
      await expect(reopened.close()).rejects.toThrow("unresolved execution");
    } finally {
      if (blocked) { rmSync(f.storePath, { recursive: true }); renameSync(backup, f.storePath); }
      if (sessionId) await f.manager.writeStdin({ workspaceId: f.workspace.id, sessionId,
        yieldTimeMs: 1000 });
      await expect(f.manager.close()).rejects.toThrow("unresolved execution");
      removeFixture(f.base);
    }
  });

  test("one-shot input reader receives EOF without blocking shutdown", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    try {
      const result = await f.manager.exec({ workspaceId: f.workspace.id,
        command: "read value || :; printf settled", yieldTimeMs: 1000 });
      expect(result.state).toBe("exited");
      expect(result.output).toBe("settled");
      expect(result.ioAvailable).toBe(false);
      expect(() => f.manager.assertCanClose()).not.toThrow();
    } finally { await f.manager.close(); removeFixture(f.base); }
  });

  test("output wait remains available after a command closes its stdin", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    try {
      const live = await f.manager.exec({ workspaceId: f.workspace.id,
        command: "exec 0<&-; printf ready; sleep 0.15; printf finished", yieldTimeMs: 10 });
      expect(live.state).toBe("running");
      const result = await f.manager.writeStdin({ workspaceId: f.workspace.id,
        sessionId: live.sessionId, yieldTimeMs: 1000 });
      expect(result.state).toBe("exited");
      expect(result.output).toContain("finished");
    } finally { await f.manager.close(); removeFixture(f.base); }
  });

  test("normal shutdown refuses live direct execution and preserves stdin until completion", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    let sessionId: number | undefined;
    let completedAndClosed = false;
    try {
      const live = await f.manager.exec({ workspaceId: f.workspace.id,
        command: "read value; printf '%s' \"$value\"", interactive: true, yieldTimeMs: 10 });
      sessionId = live.sessionId;
      const before = readFileSync(f.storePath, "utf8");
      expect(() => f.manager.assertCanClose()).toThrow("unresolved execution");
      await expect(f.manager.close()).rejects.toThrow("unresolved execution");
      expect(readFileSync(f.storePath, "utf8")).toBe(before);
      expect(f.manager.status(f.workspace.id, live.operationId).ioAvailable).toBe(true);
      const completed = await f.manager.writeStdin({ workspaceId: f.workspace.id, sessionId,
        chars: "completed\n", yieldTimeMs: 1000 });
      expect(completed.state).toBe("exited");
      expect(completed.output).toBe("completed");
      await f.manager.close();
      completedAndClosed = true;
    } finally {
      if (sessionId && !completedAndClosed) await f.manager.writeStdin({ workspaceId: f.workspace.id, sessionId,
        chars: "cleanup\n", yieldTimeMs: 1000 });
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("version-1 transition preserves reserved identity and writes an explicit version-2 boundary", async () => {
    const f = fixture();
    const operationId = randomUUID(), ownerId = randomUUID(), key = "1".repeat(64);
    const original = { version: 1, requestKey: key, nextSessionId: 1024, operations: [{
      operationId, serverInstanceId: ownerId, workspaceId: f.workspace.id, sessionId: 17,
      state: "unknown", startedAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" }] };
    writeFileSync(f.storePath, JSON.stringify(original));
    const recovered = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
    try {
      const saved = JSON.parse(readFileSync(f.storePath, "utf8"));
      expect(saved).toEqual({ ...original, version: 2 });
      expect(recovered.status(f.workspace.id, operationId).serverInstanceId).toBe(ownerId);
      const result = await recovered.exec({ workspaceId: f.workspace.id, command: "printf transition", yieldTimeMs: 1000 });
      expect(result.sessionId).toBe(1024);
      expect(result.output).toBe("transition");
      expect(JSON.parse(readFileSync(f.storePath, "utf8")).nextSessionId).toBe(1025);
    } finally { await expect(recovered.close()).rejects.toThrow("unresolved execution"); await f.manager.close(); removeFixture(f.base); }
  });
  test("version-2 missing authority or unknown versions never rewrite evidence", async () => {
    const f = fixture();
    try {
      for (const value of [
        { version: 2, operations: [], requestKey: "1".repeat(64) },
        { version: 2, operations: [], nextSessionId: 1024 },
        { version: 3, operations: [], requestKey: "1".repeat(64), nextSessionId: 1024 },
      ]) {
        const bytes = JSON.stringify(value); writeFileSync(f.storePath, bytes);
        expect(() => new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath })).toThrow();
        expect(readFileSync(f.storePath, "utf8")).toBe(bytes);
      }
    } finally { await f.manager.close(); removeFixture(f.base); }
  });
  test("a regressed session high-water mark refuses startup without rewriting evidence", async () => {
    const f = fixture();
    try {
      const bytes = JSON.stringify({ version: 1, nextSessionId: 1, operations: [{ operationId: randomUUID(),
        serverInstanceId: randomUUID(),workspaceId:f.workspace.id,sessionId:2,state:"unknown",startedAt:"2000-01-01T00:00:00.000Z",updatedAt:"2000-01-01T00:00:00.000Z" }] });
      writeFileSync(f.storePath,bytes);
      expect(() => new ChatProcessManager({workspaces:f.registry,storePath:f.storePath})).toThrow("high-water mark");
      expect(readFileSync(f.storePath,"utf8")).toBe(bytes);
    } finally { await f.manager.close(); removeFixture(f.base); }
  });
  test("retirement preserves the session high-water mark across another restart", async () => {
    const f = fixture(); const old = "2000-01-01T00:00:00.000Z";
    const operations = Array.from({ length: 1024 }, (_, index) => ({ operationId: randomUUID(),
      serverInstanceId: randomUUID(), workspaceId: f.workspace.id, sessionId: index + 1,
      state: index === 1023 ? "exited" : "unknown", startedAt: old, updatedAt: old }));
    writeFileSync(f.storePath, JSON.stringify({ version: 1, nextSessionId: 2048, operations }));
    const retired = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
    try {
      expect(JSON.parse(readFileSync(f.storePath, "utf8")).nextSessionId).toBe(2048);
      await expect(retired.close()).rejects.toThrow("unresolved execution"); const reopened = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
      try { const result = await reopened.exec({ workspaceId: f.workspace.id, command: "printf high-water", yieldTimeMs: 1000 });
        expect(result.sessionId).toBe(2048); expect(result.output).toBe("high-water");
        expect(JSON.parse(readFileSync(f.storePath, "utf8")).nextSessionId).toBe(2049);
      } finally { await expect(reopened.close()).rejects.toThrow("unresolved execution"); }
    } finally { await expect(retired.close()).rejects.toThrow("unresolved execution"); await f.manager.close(); removeFixture(f.base); }
  });
  test("invalid interrupted retirement evidence preserves archived authority and blocks a new command", async () => {
    const f = fixture(), old = "2000-01-01T00:00:00.000Z", retiredId = randomUUID();
    const operations = Array.from({ length: 1023 }, (_, index) => ({
      operationId: index === 1022 ? retiredId : randomUUID(), serverInstanceId: randomUUID(),
      workspaceId: f.workspace.id, sessionId: index + 1,
      state: index === 1022 ? "exited" : "unknown", startedAt: old, updatedAt: old,
    }));
    writeFileSync(f.storePath, JSON.stringify({ version: 2, requestKey: "1".repeat(64), nextSessionId: 1024, operations }));
    const manager = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
    const pending = `${f.storePath}.retirement.json`, command = "printf once >> started";
    try {
      expect(manager.status(f.workspace.id, retiredId).state).toBe("exited");
      const saved = readFileSync(f.storePath, "utf8");
      writeFileSync(pending, "incomplete synthetic retirement plan");
      await expect(manager.exec({ workspaceId: f.workspace.id, command, yieldTimeMs: 1000 })).rejects.toThrow();
      expect(manager.status(f.workspace.id, retiredId).state).toBe("exited");
      expect(readFileSync(f.storePath, "utf8")).toBe(saved);
      expect(readFileSync(pending, "utf8")).toBe("incomplete synthetic retirement plan");
      expect(existsSync(`${f.storePath}.retirement.json`)).toBe(true);
      expect(existsSync(join(f.root, "started"))).toBe(false);
      // Only the synthetic fixture removes its injected obstruction; product never adopts it.
      rmSync(pending);
      const resumed = await manager.exec({ workspaceId: f.workspace.id, command, yieldTimeMs: 1000 });
      expect(resumed.state).toBe("exited");
      expect(resumed.sessionId).toBe(1024);
      expect(readFileSync(join(f.root, "started"), "utf8")).toBe("once");
      expect(existsSync(`${f.storePath}.retirement.json`)).toBe(false);
      expect(() => manager.status(f.workspace.id, retiredId)).toThrow();
      const store = JSON.parse(readFileSync(f.storePath, "utf8"));
      expect(store.nextSessionId).toBe(1025);
      expect(store.operations).toHaveLength(1022);
    } finally {
      await expect(manager.close()).rejects.toThrow("unresolved execution");
      await f.manager.close();
      removeFixture(f.base);
    }
  });
  test("owned terminal retirement authenticates and removes its complete bounded evidence set", async () => {
    const f = fixture(); const old = "2000-01-01T00:00:00.000Z", key = "1".repeat(64);
    const operationId = randomUUID(), serverInstanceId = randomUUID(), requestFingerprint = "a".repeat(64), output = Buffer.from("fixture-owned-output");
    const resultFingerprint = createHmac("sha256", Buffer.from(key, "hex"))
      .update(JSON.stringify(["tela-chat-result-v1", operationId, f.workspace.id])).update(output).digest("hex");
    const journal = new ProcessExecutionJournal({ root: `${f.storePath}.executions`, key });
    const claim = journal.reserve({ operationId, workspaceId: f.workspace.id, launchingServerId: serverInstanceId, requestFingerprint });
    journal.publishLive(claim, { version: 1, ownerId: claim.ownerId, operationId, workspaceId: f.workspace.id, endpoint: "http://127.0.0.1:9/v1/operation", secret: "2".repeat(64) });
    journal.publishCompletion(claim, { state: "exited", endedAt: old, exitCode: 0, resultFingerprint, resultTruncated: false });
    mkdirSync(`${f.storePath}.results`); writeFileSync(join(`${f.storePath}.results`, `${operationId}.bin`), output);
    const operations = Array.from({ length: 1023 }, (_, index) => ({ operationId: randomUUID(), serverInstanceId: randomUUID(), workspaceId: f.workspace.id, sessionId: index + 1, state: "unknown", startedAt: old, updatedAt: old }));
    writeFileSync(f.storePath, JSON.stringify({ version: 1, requestKey: key, operations: [...operations,
      { operationId, serverInstanceId, workspaceId: f.workspace.id, sessionId: 1024, state: "exited", executionMode: "owned-worker-v1", requestFingerprint,
        startedAt: old, updatedAt: old, endedAt: old, exitCode: 0, resultFingerprint, resultTruncated: false }] }));
    const recovered = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
    try {
      expect(JSON.parse(readFileSync(f.storePath, "utf8")).operations).toHaveLength(1023);
      for (const phase of ["claim", "live", "completed"]) expect(existsSync(`${f.storePath}.executions/${operationId}.${phase}.json`)).toBe(false);
      expect(existsSync(`${f.storePath}.results/${operationId}.bin`)).toBe(false);
      expect(existsSync(`${f.storePath}.retirement.json`)).toBe(false);
    } finally { await expect(recovered.close()).rejects.toThrow("unresolved execution"); await f.manager.close(); removeFixture(f.base); }
  });
  test("command byte limit rejects multibyte bootstrap overflow before reserving execution", async () => {
    const f = fixture();
    try {
      for (const command of ["a\0b", "한".repeat(24 * 1024)]) {
        await expect(f.manager.exec({ workspaceId: f.workspace.id, command, yieldTimeMs: 0 })).rejects.toThrow("command");
      }
      expect(existsSync(f.storePath)).toBe(false);
    } finally { await f.manager.close(); removeFixture(f.base); }
  });
  test("uncertain owner launch preserves its reservation and never falls back to direct execution", async () => {
    const f = fixture();
    const manager = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath,
      ownerWorker: { executable: join(f.base, "missing-worker"), workspaceStorePath: join(f.base, "workspaces.json"),
        approvedRootsPath: join(f.base, "approval.json") } });
    const operationId = randomUUID();
    const input = { workspaceId: f.workspace.id, operationId, command: "echo forbidden > replay.txt", yieldTimeMs: 0 };
    try {
      await expect(manager.exec(input)).rejects.toThrow("owner");
      const persisted = JSON.parse(readFileSync(f.storePath, "utf8"));
      expect(persisted.operations).toHaveLength(1);
      expect(persisted.operations[0].executionMode).toBe("owned-worker-v1");
      expect(persisted.operations[0].state).toBe("unknown");
      await expect(manager.exec(input)).rejects.toThrow();
      expect(existsSync(join(f.root, "replay.txt"))).toBe(false);
      await expect(manager.close()).rejects.toThrow();
    } finally {
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("ambiguous persisted execution identities fail before store rewrite", async () => {
    const f = fixture();
    const now = new Date().toISOString();
    const first = { operationId: randomUUID(), workspaceId: f.workspace.id, serverInstanceId: randomUUID(),
      sessionId: 1, state: "unknown", startedAt: now, updatedAt: now };
    try {
      for (const second of [
        { ...first, sessionId: 2 },
        { ...first, operationId: first.operationId.toUpperCase(), sessionId: 2 },
        { ...first, operationId: randomUUID() },
      ]) {
        const original = JSON.stringify({ version: 1, operations: [first, second] });
        writeFileSync(f.storePath, original);
        expect(() => new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath })).toThrow("duplicate execution identities");
        expect(readFileSync(f.storePath, "utf8")).toBe(original);
      }
    } finally {
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("oversized registry is rejected without changing prior evidence", async () => {
    const f = fixture();
    try {
      const original = " ".repeat(1024 * 1024 + 1);
      writeFileSync(f.storePath, original);
      expect(() => new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath })).toThrow("oversized");
      expect(readFileSync(f.storePath, "utf8")).toBe(original);
    } finally {
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("old unresolved reservations survive restart and reject capacity before spawn", async () => {
    const f = fixture();
    const old = "2000-01-01T00:00:00.000Z";
    const operations = Array.from({ length: 1024 }, (_, index) => ({
      operationId: randomUUID(), serverInstanceId: randomUUID(), workspaceId: f.workspace.id,
      sessionId: index + 1, state: index === 0 ? "running" : "unknown", startedAt: old, updatedAt: old,
    }));
    writeFileSync(f.storePath, JSON.stringify({ version: 1, operations }));
    const recovered = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
    try {
      await expect(recovered.exec({ workspaceId: f.workspace.id, command: "echo should-not-run > spawned.txt",
        yieldTimeMs: 0 })).rejects.toThrow("at capacity");
      expect(existsSync(join(f.root, "spawned.txt"))).toBe(false);
      expect(JSON.parse(readFileSync(f.storePath, "utf8")).operations).toHaveLength(1024);
      for (const operation of operations) expect(recovered.status(f.workspace.id, operation.operationId).state).toBe("unknown");
    } finally {
      await expect(recovered.close()).rejects.toThrow("unresolved execution");
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("operation replay cannot cross workspace authority", async () => {
    const f = fixture();
    const secondRoot = join(f.root, "second");
    mkdirSync(secondRoot);
    const second = f.registry.open(secondRoot);
    const operationId = randomUUID();
    const now = new Date().toISOString();
    writeFileSync(f.storePath, JSON.stringify({ version: 1, operations: [{
      operationId, serverInstanceId: randomUUID(), workspaceId: f.workspace.id, sessionId: 1,
      state: "exited", startedAt: now, updatedAt: now, endedAt: now, exitCode: 0,
    }] }));
    const recovered = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
    try {
      await expect(recovered.exec({ workspaceId: second.id, operationId, command: "echo wrong > spawned.txt",
        yieldTimeMs: 0 })).rejects.toThrow("another workspace");
      expect(existsSync(join(secondRoot, "spawned.txt"))).toBe(false);
      expect(recovered.status(f.workspace.id, operationId).state).toBe("exited");
    } finally {
      await recovered.close();
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("capacity reclaims only proven terminal records", async () => {
    const f = fixture();
    const old = "2000-01-01T00:00:00.000Z";
    const operations = Array.from({ length: 1024 }, (_, index) => ({
      operationId: randomUUID(), serverInstanceId: randomUUID(), workspaceId: f.workspace.id,
      sessionId: index + 1, state: index === 1023 ? "exited" : "unknown", startedAt: old, updatedAt: old,
    }));
    writeFileSync(f.storePath, JSON.stringify({ version: 1, operations }));
    const recovered = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
    try {
      const result = await recovered.exec({ workspaceId: f.workspace.id, command: "echo reclaimed", yieldTimeMs: 1000 });
      expect(result.state).toBe("exited");
      expect(result.output).toContain("reclaimed");
      const saved = JSON.parse(readFileSync(f.storePath, "utf8")).operations;
      expect(saved).toHaveLength(1023);
      expect(saved.filter((row: { state: string }) => row.state === "unknown")).toHaveLength(1023);
      expect(() => recovered.status(f.workspace.id, operations[1023]!.operationId)).toThrow("unknown process operation");
    } finally {
      await expect(recovered.close()).rejects.toThrow("unresolved execution");
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("explicit operation ids deduplicate response-loss retries", async () => {
    const f = fixture();
    const operationId = randomUUID();
    try {
      const first = await f.manager.exec({ workspaceId: f.workspace.id, operationId,
        command: process.platform === "win32" ? "echo once" : "printf once", yieldTimeMs: 1000 });
      const second = await f.manager.exec({ workspaceId: f.workspace.id, operationId,
        command: process.platform === "win32" ? "echo once" : "printf once", yieldTimeMs: 0 });
      expect(first.operationId).toBe(operationId);
      expect(first.output).toContain("once");
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.output).toBe("");
    } finally {
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("request identity survives restart and refuses changed command or directory", async () => {
    const f = fixture();
    const operationId = randomUUID();
    mkdirSync(join(f.root, "nested"));
    const command = "echo original";
    let recovered: ChatProcessManager | undefined;
    try {
      const first = await f.manager.exec({ workspaceId: f.workspace.id, operationId, command, yieldTimeMs: 1000 });
      await f.manager.close();
      recovered = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
      const same = await recovered.exec({ workspaceId: f.workspace.id, operationId, command, workingDirectory: ".", yieldTimeMs: 0 });
      expect(same.sessionId).toBe(first.sessionId);
      expect(same.output).toBe(first.output);
      expect(same.outputRecovered).toBe(true);
      await expect(recovered.exec({ workspaceId: f.workspace.id, operationId,
        command: "echo changed > spawned.txt", yieldTimeMs: 0 })).rejects.toThrow("does not match");
      await expect(recovered.exec({ workspaceId: f.workspace.id, operationId, command,
        workingDirectory: "nested", yieldTimeMs: 0 })).rejects.toThrow("does not match");
      expect(existsSync(join(f.root, "spawned.txt"))).toBe(false);
      const store = readFileSync(f.storePath, "utf8");
      expect(store).not.toContain(command);
      expect(store).not.toContain(f.root);
      expect(same).not.toHaveProperty("requestFingerprint");
    } finally {
      await recovered?.close();
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("retained output corruption rejects recovery without repeating file writes", async () => {
    const f = fixture();
    const operationId = randomUUID();
    const command = "echo once >> count.txt";
    let recovered: ChatProcessManager | undefined;
    try {
      await f.manager.exec({ workspaceId: f.workspace.id, operationId, command, yieldTimeMs: 1000 });
      await f.manager.close();
      writeFileSync(join(`${f.storePath}.results`, `${operationId}.bin`), "replaced");
      recovered = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
      await expect(recovered.exec({ workspaceId: f.workspace.id, operationId, command })).rejects.toThrow("does not match");
      expect(readFileSync(join(f.root, "count.txt"), "utf8").trim()).toBe("once");
    } finally {
      await recovered?.close();
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("expired completed result is removed with its verified reservation at capacity", async () => {
    const f = fixture();
    const operationId = randomUUID();
    let recovered: ChatProcessManager | undefined;
    try {
      await f.manager.exec({ workspaceId: f.workspace.id, operationId, command: "echo retained", yieldTimeMs: 1000 });
      await f.manager.close();
      const store = JSON.parse(readFileSync(f.storePath, "utf8"));
      // Recreate a supported pre-archival hot receipt in this isolated
      // fixture. Do not edit an authenticated SQLite receipt in place.
      const archive = new ProcessCompletionArchive(`${f.storePath}.completed.sqlite`, store.requestKey);
      try {
        const previous = archive.get(operationId)!;
        archive.remove(previous);
        store.operations.push({ ...previous, updatedAt: "2000-01-01T00:00:00.000Z" });
      } finally { archive.close(); }
      for (let index = 0; index < 1023; index++) store.operations.push({
        operationId: randomUUID(), workspaceId: f.workspace.id, serverInstanceId: randomUUID(),
        sessionId: index + 2, state: "unknown", startedAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z",
      });
      store.nextSessionId = 1025; // The synthetic inserted sessions must preserve the real counter invariant.
      writeFileSync(f.storePath, JSON.stringify(store));
      recovered = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
      expect(existsSync(join(`${f.storePath}.results`, `${operationId}.bin`))).toBe(false);
      expect(JSON.parse(readFileSync(f.storePath, "utf8")).operations).toHaveLength(1023);
    } finally {
      if (recovered) await expect(recovered.close()).rejects.toThrow("unresolved execution");
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("result storage failure retains unresolved reservation instead of replaying", async () => {
    const f = fixture();
    const operationId = randomUUID();
    writeFileSync(`${f.storePath}.results`, "blocked-directory");
    const command = "echo once >> count.txt";
    try {
      const first = await f.manager.exec({ workspaceId: f.workspace.id, operationId, command, yieldTimeMs: 1000 });
      expect(first.state).toBe("unknown");
      const retry = await f.manager.exec({ workspaceId: f.workspace.id, operationId, command });
      expect(retry.state).toBe("unknown");
      expect(retry.outputRecovered).toBe(false);
      expect(readFileSync(join(f.root, "count.txt"), "utf8").trim()).toBe("once");
    } finally {
      await expect(f.manager.close()).rejects.toThrow("unresolved execution");
      removeFixture(f.base);
    }
  });

  test("large completed output is bounded and restored with truncation evidence", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const operationId = randomUUID();
    const command = "head -c 700000 /dev/zero";
    let recovered: ChatProcessManager | undefined;
    try {
      const first = await f.manager.exec({ workspaceId: f.workspace.id, operationId, command, yieldTimeMs: 1000 });
      expect(Buffer.byteLength(first.output)).toBe(512 * 1024);
      expect(first.outputTruncated).toBe(true);
      await f.manager.close();
      recovered = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
      const retry = await recovered.exec({ workspaceId: f.workspace.id, operationId, command });
      expect(retry.output).toBe(first.output);
      expect(retry.outputRecovered).toBe(true);
      expect(retry.outputTruncated).toBe(true);
    } finally {
      await recovered?.close();
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("preexisting operations without request proof permit status but never execution replay", async () => {
    const f = fixture();
    const operationId = randomUUID();
    const now = new Date().toISOString();
    writeFileSync(f.storePath, JSON.stringify({ version: 1, operations: [{
      operationId, workspaceId: f.workspace.id, serverInstanceId: randomUUID(), sessionId: 1,
      state: "unknown", startedAt: now, updatedAt: now,
    }] }));
    const recovered = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
    try {
      await expect(recovered.exec({ workspaceId: f.workspace.id, operationId,
        command: "echo no > spawned.txt", yieldTimeMs: 0 })).rejects.toThrow("identity is unavailable");
      expect(recovered.status(f.workspace.id, operationId).state).toBe("unknown");
      expect(existsSync(join(f.root, "spawned.txt"))).toBe(false);
    } finally {
      await expect(recovered.close()).rejects.toThrow("unresolved execution");
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("invalid wait options reject before reserving or starting a command", async () => {
    const f = fixture();
    const operationId = randomUUID();
    try {
      await expect(f.manager.exec({ workspaceId: f.workspace.id, operationId,
        command: "echo no > spawned.txt", yieldTimeMs: -1 })).rejects.toThrow("yieldTime");
      expect(existsSync(join(f.root, "spawned.txt"))).toBe(false);
      expect(() => f.manager.status(f.workspace.id, operationId)).toThrow("unknown process operation");
    } finally {
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("longer commands expose status and incremental output without persisting command text", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const operationId = randomUUID();
    try {
      const first = await f.manager.exec({ workspaceId: f.workspace.id, operationId,
        command: "printf start; sleep 0.15; printf end", yieldTimeMs: 10 });
      expect(first.state).toBe("running");
      expect(f.manager.status(f.workspace.id, operationId).liveness).toBe("alive");
      expect(f.manager.status(f.workspace.id, operationId).ioAvailable).toBe(false);
      const final = await f.manager.writeStdin({ workspaceId: f.workspace.id, sessionId: first.sessionId,
        yieldTimeMs: 1000 });
      expect(final.state).toBe("exited");
      expect(final.output).toContain("end");
      const persisted = readFileSync(f.storePath, "utf8");
      expect(persisted).not.toContain("printf start");
      expect(persisted).not.toContain(f.root);
    } finally {
      await f.manager.close();
      removeFixture(f.base);
    }
  });

  test("restart never reattaches stdin/stdout to a prior running pid", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const operationId = randomUUID();
    let sessionId: number | undefined;
    try {
      const running = await f.manager.exec({ workspaceId: f.workspace.id, operationId,
        command: "sleep 2", yieldTimeMs: 5 });
      sessionId = running.sessionId;
      expect(running.state).toBe("running");
      const reopened = new ChatProcessManager({ workspaces: f.registry, storePath: f.storePath });
      try {
        const status = reopened.status(f.workspace.id, operationId);
        expect(status.state).toBe("unknown");
        expect(status.ioAvailable).toBe(false);
        expect(status.liveness).toBe("unknown");
        expect(status.serverInstanceId).toBe(running.serverInstanceId);
        expect(status.pid).toBe(running.pid);
        expect(status.startedAt).toBe(running.startedAt);
      } finally {
        await expect(reopened.close()).rejects.toThrow("unresolved execution");
      }
    } finally {
      if (sessionId) await f.manager.writeStdin({ workspaceId: f.workspace.id, sessionId, yieldTimeMs: 3000 });
      await f.manager.close();
      removeFixture(f.base);
    }
  });
});
