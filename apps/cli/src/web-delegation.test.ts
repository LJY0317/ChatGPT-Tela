import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnershipManifest, resolveProductPaths, writeOwnershipManifest } from "@chatgpt-tela/product-lifecycle";
import { writeServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import { WebDelegationStore, type WebDelegationRecord } from "../../../packages/codex-service/src/web-delegation";
import { runWebDelegationCommand } from "./web-delegation";

test("original input export and explicit review work offline after source chat deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-request-cli-"));
  const paths = resolveProductPaths({ platform: "darwin", home: root, environment: {} });
  const store = new WebDelegationStore(join(paths.serviceState("codex"), "web-delegations"));
  const record: WebDelegationRecord = { id: randomUUID(), slot: 1, cwd: root, createdAt: Date.now(), state: "reserved",
    threadId: randomUUID(), turnId: randomUUID(),
    owner: { slot: 1, accountFingerprint: "a".repeat(64), routeFingerprint: "b".repeat(64), sessionFingerprint: "c".repeat(64) },
    session: { slot: 1, runtimeProcessId: 10, responsesRouteFingerprint: "b".repeat(64), terminalEndpoint: "ws://127.0.0.1:1" } };
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    store.reserve(record);
    const input = { prompt: "Read the supplied image", images: ["data:image/png;base64,aGVsbG8="] };
    store.requests.capture(record, input);
    store.save({ ...record, state: "failed", failure: "turn_failed" });
    store.removeDeletedThread({ slot: 1, accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId! });
    await runWebDelegationCommand(["unanswered"], paths);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).data[0].execution.state).toBe("failed");
    await runWebDelegationCommand(["request", "--job", record.id], paths);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ prompt: input.prompt, imageCount: 1 });
    expect(log.mock.calls.at(-1)![0]).not.toContain("base64");
    const output = join(root, "original.json");
    await runWebDelegationCommand(["request", "--job", record.id, "--output", output], paths);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(input);
    // Windows permissions are enforced by ACLs, not POSIX mode bits.
    if (process.platform !== "win32") expect(statSync(output).mode & 0o777).toBe(0o600);
    await expect(runWebDelegationCommand(["request", "--job", record.id, "--output", output], paths)).rejects.toThrow();
    const answer = { ...record, id: randomUUID(), threadId: randomUUID() };
    store.reserve(answer);
    store.requests.capture(answer, { prompt: "Replacement question" });
    store.save({ ...answer, state: "completed", answer: "Reviewed answer", finalEvidence: "explicit-final-phase" });
    store.settleRequest(answer.id, answer.id);
    store.removeDeletedThread({ slot: answer.slot, accountFingerprint: answer.owner.accountFingerprint, threadId: answer.threadId });
    await runWebDelegationCommand(["settle-request", "--job", record.id, "--answer-job", answer.id], paths);
    expect(store.requests.input(record.id).recoveredAnswer).toBe("Reviewed answer");
    expect(store.requests.list().data).toEqual([]);
  } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("cleanup details reuse the running service observation while default capacity remains offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-cleanup-cli-"));
  const paths = resolveProductPaths({ platform: "darwin", home: root, environment: {} });
  const store = new WebDelegationStore(join(paths.serviceState("codex"), "web-delegations"));
  const threadId = randomUUID();
  store.observeCleanup(2, { observedAt: new Date().toISOString(), unarchived: 1, target: 32,
    uncertain: false, protected: { manually_managed: 1 }, protectedThreads: [{ threadId,
      reason: "manually_managed", nextAction: "keep_manual_control" }] });
  const requests: string[] = [], token = "c".repeat(48), installId = randomUUID(), instanceId = randomUUID();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
    const url = new URL(request.url);
    requests.push(url.pathname + url.search);
    return Response.json(url.pathname === "/v1/status"
      ? { contractVersion: 1, service: "codex", instanceId, state: "ready" }
      : store.capacity(2, undefined, url.searchParams.get("cleanup-details") === "1"));
  } });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    writeOwnershipManifest(paths.installManifest, createOwnershipManifest("fixture", new Date(), installId));
    writeServiceRuntimeDescriptor(join(paths.serviceRuntime("codex"), "descriptor.json"), {
      version: 1, service: "codex", instanceId, installId, pid: process.pid,
      endpoint: server.url.href, bearerToken: token, startedAt: new Date().toISOString(),
    });
    await runWebDelegationCommand(["capacity", "--slot", "2"], paths);
    expect(requests).toEqual([]);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).cleanup).toBeUndefined();
    await runWebDelegationCommand(["capacity", "--slot", "2", "--cleanup"], paths);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).cleanup.protectedThreads).toEqual([
      { threadId, reason: "manually_managed", nextAction: "keep_manual_control" },
    ]);
    expect(requests).toEqual(["/v1/status", "/v1/codex/profiles/2/web-delegation-capacity?cleanup-details=1"]);
  } finally { log.mockRestore(); server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
