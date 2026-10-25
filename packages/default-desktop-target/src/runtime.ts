import { randomBytes } from "node:crypto";
import { diagnosticFingerprint, diagnosticFailureFields, emitDiagnosticEvent, type DiagnosticScalar, type NativeIngressMediaRegistry, type NativeLiveTurnRegistry } from "@chatgpt-tela/core";
import { execFile, spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { createOwnedBackendStop, waitForOwnedProcessExit as waitForExit } from "./owned-process";
import { connectCodexAppServerWebSocket, interruptLoadedAppServerTurns } from "@chatgpt-tela/codex";
import {
  createDefaultDesktopLaunch,
  defaultDesktopProcessIds,
  requestDefaultDesktopNormalQuit,
  waitForDefaultDesktopExit,
  DesktopNormalQuitError,
  type DefaultDesktopInstallation,
} from "./platform";
import {
  startDefaultDesktopAppServerProxy,
  type DefaultDesktopAppServerModelListAugmenter,
  type DefaultDesktopAppServerProxy,
} from "./proxy";
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
  readonly ingressMedia: NativeIngressMediaRegistry;
  readonly liveTurnProof: NativeLiveTurnRegistry;
  stop(): Promise<void>;
}

interface BackendOwnership {
  beginSpawn(): void;
  attachBackend(pid: number): void;
  proveBackendExit(): void;
  cancelBeforeSpawn(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
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

/** Read account-specific Native metadata without blocking browser startup or launching Desktop. */
export function readDefaultDesktopNativeCatalog(input: {
  readonly installation: DefaultDesktopInstallation;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...(input.environment ?? {}), CODEX_HOME: input.installation.codexHome };
  // The Web route capability must never become a Native discovery account header.
  delete environment.OPENAI_ORGANIZATION;
  return new Promise((resolve, reject) => {
    execFile(input.installation.codexExecutable, ["debug", "models"], {
      env: environment, timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
      ...(input.signal ? { signal: input.signal } : {}),
      encoding: "utf8", windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(error.name === "AbortError"
          ? "Native model catalog discovery was cancelled"
          : "Native model catalog discovery failed"));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("Native model catalog discovery returned invalid JSON")); }
    });
  });
}

export async function startDefaultDesktopTargetRuntime(input: {
  readonly installation: DefaultDesktopInstallation;
  readonly route: DefaultDesktopResponsesRoute;
  readonly credential: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly normalQuit?: (installation: DefaultDesktopInstallation, pid: number) => Promise<void>;
  readonly processIds?: (installation: DefaultDesktopInstallation) => Promise<readonly number[]>;
  readonly augmentModelList?: DefaultDesktopAppServerModelListAugmenter;
  readonly augmentNativeCatalog?: (catalog: unknown) => unknown;
  /** Seeded remote mode requires a verified owned engine capability at the product boundary. */
  readonly catalogMode?: "static" | "seeded-remote";
  /** Same-launch read-only preparation; never a persistent correctness cache. */
  readonly nativeCatalog?: Promise<unknown>;
  /** Prepare the backend in parallel, but admit Desktop only after caller proofs complete. */
  readonly beforeDesktopLaunch?: () => Promise<void>;
  readonly acquireBackendOwnership?: () => Promise<BackendOwnership | undefined>;
  readonly onDiagnostic?: (stage: string, fields: Readonly<Record<string, DiagnosticScalar>>) => void;
}): Promise<DefaultDesktopTargetRuntime> {
  const started = performance.now();
  const fingerprint = randomBytes(12).toString("hex");
  let backendPid: number | undefined;
  let desktopPid: number | undefined;
  let phase = "checking";
  let backendOwnership: BackendOwnership | undefined;
  let quitRequested = false;
  const diagnostic = (stage: string, fields: Readonly<Record<string, DiagnosticScalar>> = {}) => {
    try {
      const structural = { operation_fingerprint: fingerprint,
        runtime_process_fingerprint: diagnosticFingerprint(String(process.pid)),
        ...(backendPid !== undefined ? { backend_process_fingerprint: diagnosticFingerprint(String(backendPid)) } : {}),
        ...(desktopPid !== undefined ? { desktop_process_fingerprint: diagnosticFingerprint(String(desktopPid)) } : {}),
        phase, platform: input.installation.platform,
        duration_ms: Math.max(0, Math.round(performance.now() - started)), ...fields };
      if (input.onDiagnostic) input.onDiagnostic(stage, structural);
      else emitDiagnosticEvent("chatgpt_tela_codex", stage, structural);
    } catch { /* Diagnostics cannot alter startup, rollback, or stop. */ }
  };
  const step = (next: string) => { phase = next; diagnostic("desktop_start_phase"); };
  try {
  step("checking");
  if (input.catalogMode === "seeded-remote" && !input.augmentNativeCatalog) {
    throw new Error("seeded remote discovery requires a real initial catalog");
  }
  if (!input.installation.normalQuitSupported && !input.normalQuit) {
    throw new Error(`built-in default Desktop runtime requires a normal quit lifecycle on ${input.installation.platform}`);
  }
  const processIds = input.processIds ?? defaultDesktopProcessIds;
  const alreadyRunning = await processIds(input.installation);
  if (alreadyRunning.length > 0) {
    throw new Error("official ChatGPT Desktop is already running outside Tela; quit it normally once before starting the default Tela profile");
  }
  if (input.credential.length < 32) throw new Error("default Desktop Responses credential is too short");

  step("backend_ownership");
  backendOwnership = await input.acquireBackendOwnership?.();

  const backendEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...(input.environment ?? {}),
    CODEX_HOME: input.installation.codexHome,
    [input.route.envKey]: input.credential,
  };
  const inheritedOrganization = backendEnvironment.OPENAI_ORGANIZATION;
  if (inheritedOrganization && inheritedOrganization !== input.credential) {
    throw new Error("default Desktop Responses route cannot replace an existing OPENAI_ORGANIZATION value");
  }
  backendEnvironment.OPENAI_ORGANIZATION = input.credential;
  let catalogDirectory: string | undefined;
  let catalogArguments: string[] = [];
  if (input.augmentNativeCatalog) {
    step("catalog");
    const catalog = await (input.nativeCatalog ?? readDefaultDesktopNativeCatalog({
      installation: input.installation, environment: backendEnvironment,
    }));
    const augmented = input.augmentNativeCatalog(catalog);
    catalogDirectory = mkdtempSync(join(tmpdir(), "tela-model-catalog-"));
    const path = join(catalogDirectory, "models.json");
    writeFileSync(path, JSON.stringify(augmented), { mode: 0o600 });
    catalogArguments = ["-c", `model_catalog_json=${JSON.stringify(path)}`];
    if (input.catalogMode === "seeded-remote") catalogArguments.push("-c", "features.tela_seeded_model_catalog=true");
  }
  backendOwnership?.beginSpawn();
  step("backend");
  const backend = spawn(input.installation.codexExecutable, [
    "app-server",
    ...defaultDesktopCodexConfigArguments(input.route),
    ...catalogArguments,
    "-c", "features.code_mode_host=true",
    "--analytics-default-enabled",
    "-c", "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true",
    "--listen", "ws://127.0.0.1:0",
  ], {
    cwd: dirname(input.installation.codexHome),
    env: backendEnvironment,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  }) as BackendProcess;
  backendPid = backend.pid;

  let proxy: DefaultDesktopAppServerProxy | undefined;
  let desktop: ChildProcess | undefined;
  try {
    backend.once("exit", () => {
      try { backendOwnership?.proveBackendExit(); }
      catch { diagnostic("desktop_backend_ownership_failed", { reason_class: "exit_checkpoint_retained" }); }
    });
    backend.once("error", () => {
      if (!backend.pid) try { backendOwnership?.proveBackendExit(); } catch { /* Retain uncertain ownership. */ }
    });
    if (backend.pid) backendOwnership?.attachBackend(backend.pid);
    const appServerEndpoint = await waitForAppServerEndpoint(backend);
    backend.stderr.resume();
    step("handshake");
    const rpc = await connectCodexAppServerWebSocket(appServerEndpoint);
    await rpc.close();
    step("proxy");
    proxy = await startDefaultDesktopAppServerProxy({
      upstreamEndpoint: appServerEndpoint,
      route: input.route,
      shutdownRequested: () => quitRequested,
      ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
      ...(input.augmentModelList ? { augmentModelList: input.augmentModelList } : {}),
    });

    step("admission");
    await input.beforeDesktopLaunch?.();

    const desktopEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      ...(input.environment ?? {}),
    };
    delete desktopEnvironment[input.route.envKey];
    const launch = createDefaultDesktopLaunch(input.installation, proxy.endpoint, desktopEnvironment);
    step("launching");
    desktop = spawn(launch.command, [...launch.arguments], {
      cwd: dirname(input.installation.codexHome),
      env: launch.environment,
      stdio: "ignore",
      windowsHide: true,
    });
    if (!desktop.pid) throw new Error("ChatGPT Desktop did not expose a process id");
    step("connecting");
    await waitForProxyClient(proxy, desktop);
    step("identity");
    if (input.installation.platform === "darwin") {
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (!alive(desktop)) throw new Error("macOS application launcher exited before Desktop identity was established");
        const pids = await processIds(input.installation);
        if (pids.length > 1) throw new Error("macOS Desktop process identity is ambiguous");
        if (pids[0]) { desktopPid = pids[0]; break; }
        await sleep(50);
      }
      if (!desktopPid) throw new Error("macOS Desktop process identity was not established");
    } else { desktopPid = desktop.pid; }

    step("ready");
    diagnostic("desktop_start_complete");
    const normalQuit = input.normalQuit ?? requestDefaultDesktopNormalQuit;
    const stopBackend = createOwnedBackendStop(backend, STOP_TIMEOUT_MS);
    let stopping: Promise<void> | undefined;
    let nativeWorkSettled = false;
    return Object.freeze({
      installation: input.installation,
      desktopPid: desktopPid!,
      backendPid: backend.pid!,
      appServerEndpoint,
      proxyEndpoint: proxy.endpoint,
      responsesRouteFingerprint: input.route.fingerprint,
      ingressMedia: proxy.ingressMedia,
      liveTurnProof: proxy.liveTurnProof,
      stop() {
        if (stopping) return stopping;
        const stopStarted = performance.now();
        let stopPhase = "ownership";
        let stopFailureReason = "unknown";
        diagnostic("desktop_stop_phase", { phase: stopPhase, duration_ms: 0 });
        stopping = (async () => {
          // Prove and settle work before closing Desktop or its owner proxy. SIGTERM alone
          // drains Native turns and can otherwise leave the old backend holding chat locks.
          if (!nativeWorkSettled && alive(backend)) {
            stopPhase = "native_work_settlement";
            diagnostic("desktop_stop_phase", { phase: stopPhase, duration_ms: Math.round(performance.now() - stopStarted) });
            const count = await interruptLoadedAppServerTurns(appServerEndpoint, { signal: AbortSignal.timeout(STOP_TIMEOUT_MS) });
            nativeWorkSettled = true;
            diagnostic("desktop_native_work_settled", { phase: stopPhase, count,
              duration_ms: Math.round(performance.now() - stopStarted) });
          }
          if (desktop && (alive(desktop) || input.installation.platform === "darwin")) {
            // Re-prove that the exact Desktop pid spawned by this runtime still exists as the
            // configured official Desktop before asking the OS to quit it. If the user/OS has
            // already replaced that process, preserve the replacement and tear down only Tela's
            // proxy/backend resources. This also handles an unreaped stale ChildProcess handle.
            const currentDesktopPids = await processIds(input.installation);
            if (currentDesktopPids.includes(desktopPid!)) {
              stopPhase = "normal_quit";
              diagnostic("desktop_stop_phase", { phase: stopPhase, duration_ms: Math.round(performance.now() - stopStarted) });
              try {
                quitRequested = true;
                await normalQuit(input.installation, desktopPid!);
                diagnostic("desktop_quit_requested", { phase: stopPhase, request_state: "accepted",
                  duration_ms: Math.round(performance.now() - stopStarted) });
              } catch (error) {
                quitRequested = false;
                stopFailureReason = error instanceof DesktopNormalQuitError ? error.reasonClass : "request_failed";
                throw error;
              }
              if (input.installation.platform === "darwin") {
                if (!await waitForDefaultDesktopExit(input.installation, desktopPid!, {
                  timeoutMs: STOP_TIMEOUT_MS, processIds,
                })) {
                  stopFailureReason = "exit_timeout";
                  throw new Error("ChatGPT did not close after normal quit; owned app preserved");
                }
                // Only the helper we spawned may now be reaped. The actual
                // app's disappearance was independently proved above.
                await terminateOwned(desktop);
              } else if (!await waitForExit(desktop, STOP_TIMEOUT_MS)) {
                stopFailureReason = "exit_timeout";
                throw new Error("ChatGPT did not close after normal quit; owned app preserved");
              }
            }
          }
          stopPhase = "proxy_cleanup";
          diagnostic("desktop_stop_phase", { phase: stopPhase, duration_ms: Math.round(performance.now() - stopStarted) });
          await proxy!.close();
          stopPhase = "backend_cleanup";
          diagnostic("desktop_stop_phase", { phase: stopPhase, duration_ms: Math.round(performance.now() - stopStarted) });
          await stopBackend();
          if (catalogDirectory) rmSync(catalogDirectory, { recursive: true, force: true });
          diagnostic("desktop_stop_complete", { phase: "closed", duration_ms: Math.round(performance.now() - stopStarted) });
        })().catch(error => {
          quitRequested = false;
          diagnostic("desktop_stop_failed", { phase: stopPhase,
            reason_class: stopFailureReason === "unknown" && ["proxy_cleanup", "backend_cleanup"].includes(stopPhase) ? "cleanup_failed" : stopFailureReason,
            duration_ms: Math.round(performance.now() - stopStarted) });
          stopping = undefined;
          throw error;
        });
        return stopping;
      },
    });
  } catch (error) {
    try { backendOwnership?.cancelBeforeSpawn(); } catch { /* Keep the checkpoint on uncertainty. */ }
    diagnostic("desktop_rollback_begin", {
      ...diagnosticFailureFields(error),
      desktop_exit_observed: desktop?.exitCode !== null && desktop?.exitCode !== undefined,
      ...(desktop?.exitCode !== null && desktop?.exitCode !== undefined ? { desktop_exit_code: desktop.exitCode } : {}),
      desktop_signaled: desktop?.signalCode !== null && desktop?.signalCode !== undefined,
      backend_exit_observed: backend.exitCode !== null,
      ...(backend.exitCode !== null ? { backend_exit_code: backend.exitCode } : {}),
      backend_signaled: backend.signalCode !== null,
      proxy_connection_count: proxy?.activeConnectionCount ?? 0,
    });
    const failures: unknown[] = [error];
    if (desktop && alive(desktop)) {
      try {
        const normalQuit = input.normalQuit ?? requestDefaultDesktopNormalQuit;
        if (desktopPid !== undefined) await normalQuit(input.installation, desktopPid);
        if (!await waitForExit(desktop, 2_000)) await terminateOwned(desktop);
      } catch (quitError) {
        failures.push(quitError);
        await terminateOwned(desktop).catch(cleanupError => failures.push(cleanupError));
      }
    }
    if (proxy) await proxy.close().catch(cleanupError => failures.push(cleanupError));
    await terminateOwned(backend).catch(cleanupError => failures.push(cleanupError));
    if (catalogDirectory) rmSync(catalogDirectory, { recursive: true, force: true });
    diagnostic(failures.length > 1 ? "desktop_rollback_failed" : "desktop_rollback_complete", { count: failures.length - 1 });
    if (failures.length > 1) throw new AggregateError(failures, "default Desktop startup rollback was incomplete");
    throw error;
  }
  } catch (error) {
    diagnostic("desktop_start_failed");
    try { backendOwnership?.cancelBeforeSpawn(); } catch { /* Keep the checkpoint on uncertainty. */ }
    throw error;
  }
}
