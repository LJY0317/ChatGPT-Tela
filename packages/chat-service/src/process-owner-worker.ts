import { createHmac } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { lstatSync, mkdirSync } from "node:fs";
import { ChatWorkspaceRegistry } from "./workspaces";
import { parseChatApprovedRootsConfig } from "./config";
import { resolveWorkspaceDirectory } from "./paths";
import { readBoundedProcessState, writeExclusiveProcessState } from "./process-state";
import { appendProcessOutput, consumeProcessOutput, type ProcessOutputState } from "./process-output";
import { ProcessExecutionJournal } from "./process-execution-journal";
import { startProcessOwnerControl } from "./process-owner";
import type { ProcessOperationState } from "./processes";
import { windowsCommandLine } from "./windows-command";

interface Bootstrap {
  readonly version: 1;
  readonly operationId: string;
  readonly storePath: string;
  readonly workspaceStorePath: string;
  readonly approvedRootsPath: string;
  readonly command: string;
  readonly workingDirectory?: string;
  readonly interactive?: boolean;
}

/** Only the freshly spawned, isolated owned-process tree is eligible. */
export async function terminateOwnedProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error("invalid owned process identity");
  if (process.platform === "win32") {
    // Windows has no POSIX process groups; taskkill /T targets this exact owned tree.
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", reject);
      killer.once("close", code => code === 0 ? resolve() : reject(Error("owned tree cancellation failed")));
    });
  } else {
    // The owned shell is a new session/group leader, never the worker's group.
    process.kill(-pid, "SIGTERM");
  }
}

/** Called only through the verified Chat executable's private operation-owner role. */
export async function runProcessOwnerWorker(): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > 128 * 1024) throw new Error("worker bootstrap exceeds its bound");
    chunks.push(buffer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Bootstrap;
  if (input.version !== 1 || typeof input.command !== "string" || !input.command.trim()
    || input.command.includes("\0") || Buffer.byteLength(input.command) > 64 * 1024) throw new Error("invalid worker bootstrap");
  const store = JSON.parse(readBoundedProcessState(input.storePath, 1024 * 1024).toString("utf8"));
  if (store.version !== 2 || !Number.isSafeInteger(store.nextSessionId) || store.nextSessionId < 1
    || store.nextSessionId >= Number.MAX_SAFE_INTEGER || !Array.isArray(store.operations) || store.operations.length > 256
    || typeof store.requestKey !== "string" || !/^[a-f0-9]{64}$/.test(store.requestKey)) throw new Error("invalid worker reservation store");
  const matches = store.operations.filter((row: { operationId: string }) => row.operationId === input.operationId);
  if (matches.length !== 1) throw new Error("worker reservation is missing or ambiguous");
  const operation = matches[0];
  if (operation.executionMode !== "owned-worker-v1" || operation.state !== "starting"
    || !Number.isSafeInteger(operation.sessionId) || operation.sessionId < 1
    || operation.sessionId >= store.nextSessionId) throw new Error("operation is not reserved for an owner worker");
  const workspace = () => {
    const approved = parseChatApprovedRootsConfig(JSON.parse(readBoundedProcessState(input.approvedRootsPath, 128 * 1024).toString("utf8")));
    return new ChatWorkspaceRegistry({ allowedRoots: approved.roots, storePath: input.workspaceStorePath }).get(operation.workspaceId);
  };
  const root = workspace();
  const cwd = resolveWorkspaceDirectory(root.root, input.workingDirectory);
  const fingerprint = createHmac("sha256", Buffer.from(store.requestKey, "hex"))
    .update(JSON.stringify(["tela-chat-exec-v1", root.id, cwd, input.command, input.interactive === true])).digest("hex");
  if (fingerprint !== operation.requestFingerprint) throw new Error("worker command does not match reservation");
  const journal = new ProcessExecutionJournal({ root: `${input.storePath}.executions`, key: store.requestKey });
  const claim = journal.reserve({ operationId: operation.operationId, workspaceId: root.id,
    launchingServerId: operation.serverInstanceId, requestFingerprint: fingerprint });
  const secret = createHmac("sha256", store.requestKey).update(`tela-owner-control-v1\0${claim.ownerId}`).digest("hex");
  const output: ProcessOutputState = { chunks: [], outputBytes: 0, baseOffset: 0, readOffset: 0, truncated: false };
  let state: ProcessOperationState = "starting", child: ChildProcessWithoutNullStreams | undefined;
  let exitCode: number | undefined, signal: string | undefined, endedAt: string | undefined;
  let resolveCompletion!: () => void;
  const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
  const snapshot = (consume = false) => {
    const collected = consume ? consumeProcessOutput(output) : { output: "", truncated: false };
    return { operationId: claim.operationId, workspaceId: claim.workspaceId, serverInstanceId: claim.launchingServerId,
      sessionId: operation.sessionId, state, startedAt: operation.startedAt, updatedAt: endedAt ?? operation.startedAt,
      ...(child?.pid ? { pid: child.pid } : {}), ...(endedAt ? { endedAt } : {}),
      ...(exitCode === undefined ? {} : { exitCode }), ...(signal ? { signal } : {}),
      ioAvailable: state === "running" && input.interactive === true,
      output: collected.output, outputTruncated: collected.truncated, outputRecovered: false };
  };
  const control = await startProcessOwnerControl({ binding: { ownerId: claim.ownerId, operationId: claim.operationId, workspaceId: claim.workspaceId }, secret, authority: {
    status: () => snapshot(),
    async wait(duration, observationSignal) {
      if (state === "starting" || state === "running") await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); observationSignal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, duration);
        observationSignal.addEventListener("abort", finish, { once: true });
        void completion.then(finish);
        if (observationSignal.aborted) finish();
      });
      return snapshot(!observationSignal.aborted);
    },
    write(chars) {
      workspace(); // Fresh approval and directory identity before new input authority.
      if (state !== "running" || !child || !input.interactive) throw new Error("worker input is not available");
      child.stdin.write(chars);
    },
    async cancelOwnedExecution() {
      workspace(); // Re-prove the original approved workspace before ending owned work.
      if (state !== "starting" && state !== "running") return snapshot();
      if (!child?.pid) throw Error("owned execution has no started process");
      await terminateOwnedProcessTree(child.pid);
      await completion;
      return snapshot();
    },
  } });
  const settle = (code: number | null, terminated: NodeJS.Signals | null, failed = false) => {
    endedAt = new Date().toISOString(); exitCode = code ?? -1; signal = terminated ?? undefined;
    try {
      if (failed) {
        state = "spawn_failed";
        journal.publishCompletion(claim, { state, endedAt });
      } else {
        const retained = Buffer.concat(output.chunks);
        const path = join(`${input.storePath}.results`, `${claim.operationId}.bin`);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("unsafe result directory");
        writeExclusiveProcessState(path, retained);
        const resultFingerprint = createHmac("sha256", Buffer.from(store.requestKey, "hex"))
          .update(JSON.stringify(["tela-chat-result-v1", claim.operationId, claim.workspaceId])).update(retained).digest("hex");
        state = terminated ? "signaled" : "exited";
        journal.publishCompletion(claim, terminated
          ? { state: "signaled", endedAt, signal: terminated, resultFingerprint, resultTruncated: output.truncated }
          : { state: "exited", endedAt, exitCode: code ?? -1, resultFingerprint, resultTruncated: output.truncated });
      }
    } catch { state = "unknown"; }
    resolveCompletion();
  };
  try {
    journal.publishLive(claim, control.descriptor);
    const executable = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", windowsCommandLine(input.command)] : ["-lc", input.command];
    child = spawn(executable, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    child.stdout.on("data", (chunk: Buffer) => appendProcessOutput(output, chunk));
    child.stderr.on("data", (chunk: Buffer) => appendProcessOutput(output, chunk));
    if (!input.interactive) child.stdin.end();
    child.once("spawn", () => { state = "running"; process.stdout.write("TELA_OPERATION_READY\n"); });
    child.once("error", () => settle(null, null, true));
    child.once("close", (code, terminated) => { if (state === "starting" || state === "running") settle(code, terminated); });
    await completion;
  } finally { await control.close(); }
}
