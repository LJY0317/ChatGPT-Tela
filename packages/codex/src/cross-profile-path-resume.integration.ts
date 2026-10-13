/**
 * Separate-process, no-model, disposable Codex App Server probe.
 *
 * This does NOT change or inspect a user's installed CODEX_HOME, credentials,
 * personal rollouts or profile services. It never calls turn/start.
 *
 * Explicit opt-in execution:
 *  CODEX_TEST_BINARY=/absolute/path/to/codex \
 *    bun run packages/codex/src/cross-profile-path-resume.integration.ts
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createInterface } from "node:readline";

const binary = process.env.CODEX_TEST_BINARY;
if (!binary || !isAbsolute(binary) || !existsSync(binary)) {
  throw new Error("Set CODEX_TEST_BINARY to the exact installed owned synthetic-test executable");
}

interface Rpc {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string): void;
  close(): Promise<void>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

class NativeIsolatedRpcRefused extends Error {
  constructor(readonly code?: number) {
    super("Official Native app-server rejected the isolated request");
  }
}

function fixtureServer(codexHome: string, home: string): Rpc {
  const child: ChildProcessWithoutNullStreams = spawn(binary!, ["app-server", "--listen", "stdio://"], {
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(home, "config"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      RUST_LOG: "error",
      TMPDIR: home,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const rejectAll = (reason: string) => {
    for (const promise of pending.values()) promise.reject(new Error(reason));
    pending.clear();
  };
  createInterface({ input: child.stdout }).on("line", line => {
    let result: Record<string, unknown> | undefined;
    try { result = object(JSON.parse(line)); } catch { return; }
    if (!result || typeof result.id !== "number") return;
    const registered = pending.get(result.id);
    if (!registered) return;
    pending.delete(result.id);
    if (result.error) {
      const code = object(result.error)?.code;
      registered.reject(new NativeIsolatedRpcRefused(typeof code === "number" ? code : undefined));
    }
    else registered.resolve(result.result);
  });
  // Bound evidence only: never log child stderr contents or Native payloads.
  child.once("exit", () => rejectAll("Isolated Native app-server exited"));
  child.once("error", () => rejectAll("Isolated Native app-server could not launch"));
  const request = async (method: string, params: unknown) => {
    const id = ++next;
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Isolated Native request timed out"));
      }, 12_000);
      pending.set(id, {
        resolve(value) { clearTimeout(timeout); resolve(value); },
        reject(error) { clearTimeout(timeout); reject(error); },
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  };
  let closed = false;
  return {
    request,
    notify(method) { child.stdin.write(JSON.stringify({ method }) + "\n"); },
    async close() {
      if (closed) return;
      closed = true;
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const settled = await Promise.race([
        new Promise<boolean>(resolve => child.once("exit", () => resolve(true))),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000)),
      ]);
      if (!settled) {
        // Only a child process spawned with a disposable CODEX_HOME by THIS
        // probe is eligible for explicit test cleanup, never an owned service.
        child.kill("SIGTERM");
        await new Promise<void>(resolve => child.once("exit", () => resolve()));
      }
    },
  };
}

async function initialize(client: Rpc) {
  await client.request("initialize", {
    clientInfo: { name: "tela_isolated_path_probe", title: "Isolated Native path probe", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized");
}

const root = mkdtempSync(join(tmpdir(), "tela-native-path-resume-"));
const sourceHome = join(root, "account-A");
const targetHome = join(root, "account-B");
const cwd = join(root, "synthetic-workspace");
for (const dir of [sourceHome, targetHome, cwd]) mkdirSync(dir, { recursive: true });
let source: Rpc | undefined;
let destination: Rpc | undefined;
try {
  source = fixtureServer(sourceHome, root);
  await initialize(source);
  const started = object(await source.request("thread/start", { cwd, ephemeral: false }));
  const first = object(started?.thread);
  const id = first?.id;
  const path = first?.path;
  if (typeof id !== "string" || typeof path !== "string") {
    throw new Error("Official source did not persist an isolated empty Native thread");
  }
  const saved = object(await source.request("thread/read", { threadId: id, includeTurns: false }));
  if (object(saved?.thread)?.id !== id) throw new Error("Source cannot re-read its exact synthetic thread");
  await source.close();
  source = undefined;

  destination = fixtureServer(targetHome, root);
  await initialize(destination);
  let resumedId = "";
  let outcome: "same_original_id" | "identity_changed" | "resume_rpc_denied" = "resume_rpc_denied";
  let rpcErrorCode: number | undefined;
  try {
    const resumed = object(await destination.request("thread/resume", {
      threadId: id, path, excludeTurns: true,
    }));
    resumedId = String(object(resumed?.thread)?.id ?? "");
    outcome = resumedId === id ? "same_original_id" : "identity_changed";
  } catch (error) {
    rpcErrorCode = error instanceof NativeIsolatedRpcRefused ? error.code : undefined;
  }
  const sourceRolloutFileExists = existsSync(path);
  console.log(JSON.stringify({
    fixture: "isolated-empty-thread-only",
    originalOwnerFullyExitedBeforeNextOwner: true,
    destinationDifferentCodexHome: true,
    outcome: sourceRolloutFileExists ? outcome : "inconclusive_no_persisted_rollout",
    threadIdentityPreserved: sourceRolloutFileExists && outcome === "same_original_id",
    sourceRolloutFileExists,
    rpcErrorCode: rpcErrorCode ?? null,
    modelTurnsStarted: 0,
    profileCredentialsUsed: false,
    actualTwoAccountShareProven: false,
  }));
} finally {
  await destination?.close();
  await source?.close();
  rmSync(root, { recursive: true, force: true });
}
