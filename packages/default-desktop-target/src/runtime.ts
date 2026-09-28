import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { connectCodexAppServerWebSocket } from "@chatgpt-tela/codex";
import {
  defaultDesktopProcessIds,
  requestDefaultDesktopNormalQuit,
  type DefaultDesktopInstallation,
} from "./platform";
import { startDefaultDesktopAppServerProxy, type DefaultDesktopAppServerProxy } from "./proxy";
import {
  defaultDesktopCodexConfigArguments,
  type DefaultDesktopResponsesRoute,
} from "./route";

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;
const MAX_STARTUP_STDERR_BYTES = 64 * 1024;

type BackendProcess = ChildProcessByStdio<null, null, Readable>;

export interface DefaultDesktopTargetRuntime {
  readonly installation: DefaultDesktopInstallation;
  readonly desktopPid: number;
  readonly backendPid: number;
  readonly appServerEndpoint: string;
  readonly proxyEndpoint: string;
  readonly responsesRouteFingerprint: string;
  stop(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!alive(child)) return true;
  return new Promise(resolvePromise => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", exited);
      resolvePromise(value);
    };
    const exited = () => finish(true);
    child.once("exit", exited);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function terminateOwned(child: ChildProcess): Promise<void> {
  if (!alive(child)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2_000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 1_000);
}

function loopbackEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.port) {
    throw new Error("Codex app-server readiness returned a non-loopback WebSocket endpoint");
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("Codex app-server readiness returned an invalid WebSocket endpoint");
  }
  url.pathname = "/";
  return url.href;
}

async function waitForAppServerEndpoint(child: BackendProcess): Promise<string> {
  let buffered = Buffer.alloc(0);
  let total = 0;
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      callback();
    };
    const fail = (message: string, cause?: unknown) => finish(() => rejectPromise(new Error(message, cause ? { cause } : undefined)));
    const onData = (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_STARTUP_STDERR_BYTES) return fail("Codex app-server readiness output exceeded the bounded limit");
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) return;
        const line = buffered.subarray(0, newline).toString("utf8").trim();
        buffered = buffered.subarray(newline + 1);
        const match = /\blistening on:\s+(ws:\/\/\S+)\s*$/.exec(line);
        if (!match) continue;
        let endpoint: string;
        try { endpoint = loopbackEndpoint(match[1]!); }
        catch (error) { return fail("Codex app-server emitted an invalid readiness endpoint", error); }
        finish(() => resolvePromise(endpoint));
        return;
      }
    };
    const onError = (error: Error) => fail("Codex app-server failed to start", error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(`Codex app-server exited before readiness (code=${code ?? "null"} signal=${signal ?? "none"})`);
    };
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    const timer = setTimeout(() => fail("Codex app-server readiness timed out"), START_TIMEOUT_MS);
  });
}

async function waitForProxyClient(proxy: DefaultDesktopAppServerProxy, desktop: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proxy.activeConnectionCount > 0) return;
    if (!alive(desktop)) throw new Error("ChatGPT Desktop exited before connecting to the owned app-server proxy");
    await sleep(50);
  }
  throw new Error("ChatGPT Desktop did not connect to the owned app-server proxy before startup timeout");
}

export async function startDefaultDesktopTargetRuntime(input: {
  readonly installation: DefaultDesktopInstallation;
  readonly route: DefaultDesktopResponsesRoute;
  readonly credential: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly normalQuit?: (installation: DefaultDesktopInstallation, pid: number) => Promise<void>;
}): Promise<DefaultDesktopTargetRuntime> {
  if (!input.installation.normalQuitSupported && !input.normalQuit) {
    throw new Error(`built-in default Desktop runtime requires a normal quit lifecycle on ${input.installation.platform}`);
  }
  const alreadyRunning = await defaultDesktopProcessIds(input.installation);
  if (alreadyRunning.length > 0) {
    throw new Error("official ChatGPT Desktop is already running outside Tela; quit it normally once before starting the default Tela profile");
  }
  if (input.credential.length < 32) throw new Error("default Desktop Responses credential is too short");

  const backendEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...(input.environment ?? {}),
    CODEX_HOME: input.installation.codexHome,
    [input.route.envKey]: input.credential,
  };
  const backend = spawn(input.installation.codexExecutable, [
    ...defaultDesktopCodexConfigArguments(input.route),
    "-c", "features.code_mode_host=true",
    "app-server",
    "--analytics-default-enabled",
    "-c", "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true",
    "--listen", "ws://127.0.0.1:0",
  ], {
    cwd: dirname(input.installation.codexHome),
    env: backendEnvironment,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  }) as BackendProcess;

  let proxy: DefaultDesktopAppServerProxy | undefined;
  let desktop: ChildProcess | undefined;
  try {
    const appServerEndpoint = await waitForAppServerEndpoint(backend);
    backend.stderr.resume();
    const rpc = await connectCodexAppServerWebSocket(appServerEndpoint);
    await rpc.close();
    proxy = await startDefaultDesktopAppServerProxy({ upstreamEndpoint: appServerEndpoint, route: input.route });

    const desktopEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      ...(input.environment ?? {}),
      CODEX_HOME: input.installation.codexHome,
      CODEX_ELECTRON_USER_DATA_PATH: input.installation.userDataDir,
      CODEX_APP_SERVER_WS_URL: proxy.endpoint,
    };
    delete desktopEnvironment[input.route.envKey];
    desktop = spawn(input.installation.chatGptExecutable, [
      `--user-data-dir=${input.installation.userDataDir}`,
    ], {
      cwd: dirname(input.installation.codexHome),
      env: desktopEnvironment,
      stdio: "ignore",
      windowsHide: true,
    });
    if (!desktop.pid) throw new Error("ChatGPT Desktop did not expose a process id");
    await waitForProxyClient(proxy, desktop);

    const normalQuit = input.normalQuit ?? requestDefaultDesktopNormalQuit;
    let stopping: Promise<void> | undefined;
    return Object.freeze({
      installation: input.installation,
      desktopPid: desktop.pid,
      backendPid: backend.pid!,
      appServerEndpoint,
      proxyEndpoint: proxy.endpoint,
      responsesRouteFingerprint: input.route.fingerprint,
      stop() {
        if (stopping) return stopping;
        stopping = (async () => {
          if (desktop && alive(desktop)) {
            await normalQuit(input.installation, desktop.pid!);
            if (!await waitForExit(desktop, STOP_TIMEOUT_MS)) {
              // The pid belongs to the exact child this runtime spawned, so a bounded fallback is safe.
              desktop.kill("SIGTERM");
              if (!await waitForExit(desktop, 2_000)) desktop.kill("SIGKILL");
              await waitForExit(desktop, 1_000);
            }
          }
          await proxy!.close();
          await terminateOwned(backend);
        })().catch(error => {
          stopping = undefined;
          throw error;
        });
        return stopping;
      },
    });
  } catch (error) {
    const failures: unknown[] = [error];
    if (desktop && alive(desktop)) {
      try {
        const normalQuit = input.normalQuit ?? requestDefaultDesktopNormalQuit;
        await normalQuit(input.installation, desktop.pid!);
        if (!await waitForExit(desktop, 2_000)) await terminateOwned(desktop);
      } catch (quitError) {
        failures.push(quitError);
        await terminateOwned(desktop).catch(cleanupError => failures.push(cleanupError));
      }
    }
    if (proxy) await proxy.close().catch(cleanupError => failures.push(cleanupError));
    await terminateOwned(backend).catch(cleanupError => failures.push(cleanupError));
    if (failures.length > 1) throw new AggregateError(failures, "default Desktop startup rollback was incomplete");
    throw error;
  }
}
