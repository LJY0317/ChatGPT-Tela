import { test, expect } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { WebDelegationStore, type WebDelegationRecord } from "./web-delegation";

test("separate OS processes claim one notice; stale save, ownership and orphan sweep", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-notice-process-"));
  const children: ChildProcessWithoutNullStreams[] = [];
  try {
    const store = new WebDelegationStore(root), id = randomUUID(), threadId = randomUUID();
    const base: WebDelegationRecord = { id, slot: 1, cwd: root, createdAt: Date.now(), state: "running",
      threadId, turnId: randomUUID(), owner: { slot: 1, accountFingerprint: "a".repeat(64),
        sessionFingerprint: "b".repeat(64), routeFingerprint: "c".repeat(64) },
      session: { slot: 1, runtimeProcessId: 10, responsesRouteFingerprint: "c".repeat(64),
        terminalEndpoint: "ws://127.0.0.1:1234" },
      coordinator: { slot: 1, threadId: randomUUID(), accountFingerprint: "a".repeat(64) } };
    writeFileSync(join(root, `${id}.json`), JSON.stringify(base));
    const effects = join(root, "mock-queue-effects"), messageIds = [randomUUID(), randomUUID()];
    const launch = (messageId: string) => {
      const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/coordinator-notice-process-worker.ts"), root, id, messageId, effects],
        { stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      const lines = createInterface({ input: child.stdout });
      const pending: Array<(value: string) => void> = [], buffered: string[] = [];
      lines.on("line", line => { const waiter = pending.shift(); if (waiter) waiter(line); else buffered.push(line); });
      const next = () => buffered.length ? Promise.resolve(buffered.shift()!) : new Promise<string>(resolve => pending.push(resolve));
      return { child, next, send: (command: string) => child.stdin.write(`${command}\n`) };
    };
    const workers = messageIds.map(launch);
    expect(await Promise.all(workers.map(worker => worker.next()))).toEqual(["ready", "ready"]);
    expect(new Set(workers.map(worker => worker.child.pid)).size).toBe(2);
    workers.forEach(worker => worker.send("claim"));
    const claims = await Promise.all(workers.map(worker => worker.next()));
    expect([...claims].sort()).toEqual(["claimed", "rejected"]);
    const winnerIndex = claims.indexOf("claimed");
    const winner = workers[winnerIndex]!;
    const loser = workers[claims.indexOf("rejected")]!;
    winner.send("publish");
    expect(await winner.next()).toBe("published");
    const winnerExit = new Promise<void>(resolve => winner.child.once("exit", () => resolve()));
    winner.send("exit");
    winner.child.stdin.end();
    await winnerExit; // Notice claim survives the owning OS process exiting.
    loser.send("claim");
    expect(await loser.next()).toBe("rejected");
    expect(readFileSync(effects, "utf8").trim().split("\n")).toHaveLength(1);
    expect(store.get(id)).toMatchObject({ coordinatorNotice: "queued", coordinatorQueueItemId: messageIds[winnerIndex] });
    loser.send("reconcile");
    expect(await loser.next()).toBe("settled:failed:turn_complete");
    const failed = store.get(id)!;
    expect(failed).toMatchObject({ state: "failed", failure: "turn_failed",
      failureStage: "turn_complete", failureNextAction: "inspect_diagnostics" });
    loser.send("stale");
    expect(await loser.next()).toBe("saved");
    expect(store.get(id)).toMatchObject({ state: "failed", failureStage: "turn_complete",
      failureClass: failed.failureClass, failureIncidentState: failed.failureIncidentState,
      failureNextAction: "inspect_diagnostics",
      coordinatorNotice: "queued", coordinatorQueueItemId: messageIds[winnerIndex] });
    store.pruneOrphanedExcludedReceipts();
    expect(existsSync(join(root, `${id}.json.notice`))).toBe(true);
    unlinkSync(join(root, `${id}.json`));
    unlinkSync(join(root, `${id}.json.failed`));
    store.pruneOrphanedExcludedReceipts();
    expect(existsSync(join(root, `${id}.json.notice`))).toBe(false);
    expect(store.get(id)).toBeUndefined(); // No job recreation after an interrupted cleanup.
    const loserExit = new Promise<void>(resolve => loser.child.once("exit", () => resolve()));
    loser.send("exit");
    loser.child.stdin.end();
    await loserExit;
    expect(readFileSync(effects, "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
