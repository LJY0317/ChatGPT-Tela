import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { diagnosticDurationMs, emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  readServiceRuntimeDescriptor,
  removeServiceRuntimeDescriptor,
  type ServiceRuntimeDescriptor,
  type ServiceStatus,
  type TelaServiceId,
} from "@chatgpt-tela/service-protocol";
import {
  LocalServiceClient,
  ServiceHttpError,
  ServiceStatusValidationError,
  descriptorForService,
} from "@chatgpt-tela/service-protocol/client";

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
// Codex closes owned Desktop/profile runtimes through their normal OS lifecycle.
// A single Desktop quit can take 15s and its profile child can take 20s more;
// the service supervisor must not declare failure while that safe drain runs.
const DEFAULT_CODEX_STOP_TIMEOUT_MS = 60_000;
const START_LOCK_STALE_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function deadlineSignal(timeoutMs: number): { readonly signal: AbortSignal; close(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("service request timed out")), timeoutMs);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

async function acquireStartLock(path: string, timeoutMs: number): Promise<() => Promise<void>> {
  const lockPath = `${path}.start.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => { await rm(lockPath, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const current = await stat(lockPath);
        if (Date.now() - current.mtimeMs > START_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for Tela service start lock");
      await sleep(50);
    }
  }
}

export interface RunningService<S extends TelaServiceId = TelaServiceId> {
  readonly descriptor: ServiceRuntimeDescriptor & { readonly service: S };
  readonly status: ServiceStatus & { readonly service: S };
}

export interface EnsureServiceInput<S extends TelaServiceId> {
  readonly service: S;
  readonly descriptorPath: string;
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly logPath: string;
  readonly startTimeoutMs?: number;
}

class ServiceEndpointUnavailableError extends Error {}

export class LocalServiceSupervisor {
  readonly #installId: string;
  readonly #observedStatus = new Map<TelaServiceId, string>();

  constructor(input: { readonly installId: string }) {
    if (!input.installId.trim() || /[\u0000\r\n]/.test(input.installId)) throw new Error("Tela install id is invalid");
    this.#installId = input.installId;
  }

  async current<S extends TelaServiceId>(input: {
    readonly service: S;
    readonly descriptorPath: string;
    readonly requestTimeoutMs?: number;
    readonly shutdownReadiness?: boolean;
  }): Promise<RunningService<S> | undefined> {
    const startedAt = Date.now();
    const descriptor = readServiceRuntimeDescriptor(input.descriptorPath);
    if (!descriptor) {
      if (this.#observedStatus.get(input.service) !== "absent") {
        emitDiagnosticEvent("chatgpt_tela_service", "descriptor_absent", { service: input.service });
        this.#observedStatus.set(input.service, "absent");
      }
      return undefined;
    }
    if (descriptor.installId !== this.#installId) {
      throw new Error(`${input.service} runtime belongs to a different Tela install instance`);
    }
    const exact = descriptorForService(descriptor, input.service);
    const deadline = deadlineSignal(input.requestTimeoutMs ?? 1_500);
    try {
      const status = await new LocalServiceClient(exact).status(deadline.signal, { shutdownReadiness: input.shutdownReadiness === true });
      const observation = `${exact.instanceId}:${status.state}`;
      if (this.#observedStatus.get(input.service) !== observation) {
        emitDiagnosticEvent("chatgpt_tela_service", "status_ready", {
          service: input.service, state: status.state, duration_ms: diagnosticDurationMs(startedAt),
        });
        this.#observedStatus.set(input.service, observation);
      }
      return Object.freeze({ descriptor: exact, status: status as ServiceStatus & { readonly service: S } });
    } catch (error) {
      this.#observedStatus.delete(input.service);
      if (error instanceof ServiceHttpError || error instanceof ServiceStatusValidationError) throw error;
      if (pidAlive(exact.pid)) {
        emitDiagnosticEvent("chatgpt_tela_service", "status_endpoint_failed", {
          service: input.service,
          duration_ms: diagnosticDurationMs(startedAt),
        });
        throw new ServiceEndpointUnavailableError(`${input.service} process is alive but its private service endpoint is unavailable`, { cause: error });
      }
      // Observation never unlinks a shared pathname: a successor may publish
      // at any time. The runtime owner cleans up; a new owner publishes atomically.
      emitDiagnosticEvent("chatgpt_tela_service", "stale_descriptor_observed", {
        service: input.service,
        duration_ms: diagnosticDurationMs(startedAt),
      });
      return undefined;
    } finally {
      deadline.close();
    }
  }

  /** Observe an OS-started service without spawning or taking shutdown authority. */
  async waitUntilReady<S extends TelaServiceId>(input: {
    readonly service: S;
    readonly descriptorPath: string;
    readonly timeoutMs: number;
  }): Promise<RunningService<S>> {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 60_000) {
      throw new Error("service readiness budget is invalid");
    }
    const deadline = Date.now() + input.timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const current = await this.current({ ...input, requestTimeoutMs: Math.min(500, deadline - Date.now()) });
        if (current?.status.state === "ready" && Date.now() < deadline) return current;
      } catch (error) {
        // A process can publish its descriptor before it accepts requests.
        // Identity/schema failures are terminal, not readiness transitions.
        if (!(error instanceof ServiceEndpointUnavailableError)) throw error;
        lastError = error;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleep(Math.min(100, remaining));
    }
    throw new Error(`${input.service} runtime did not become ready`, lastError ? { cause: lastError } : undefined);
  }

  async ensure<S extends TelaServiceId>(input: EnsureServiceInput<S>): Promise<RunningService<S>> {
    const startedAt = Date.now();
    const timeoutMs = input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const release = await acquireStartLock(input.descriptorPath, timeoutMs);
    try {
      const existing = await this.current({ service: input.service, descriptorPath: input.descriptorPath }).catch(error => {
        throw error;
      });
      if (existing) {
        emitDiagnosticEvent("chatgpt_tela_service", "ensure_reused", {
          service: input.service,
          duration_ms: diagnosticDurationMs(startedAt),
        });
        return existing;
      }
      mkdirSync(dirname(input.logPath), { recursive: true, mode: 0o700 });
      const logFd = openSync(input.logPath, "a", 0o600);
      let child;
      try {
        const diagnosticLogPath = `${input.logPath}.diagnostics.jsonl`;
        child = spawn(input.command[0], input.command.slice(1), {
          cwd: input.cwd,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          windowsHide: true,
          env: {
            ...process.env,
            ...input.environment,
            CHATGPT_TELA_DIAGNOSTIC_FILE: diagnosticLogPath,
          },
        });
        child.unref();
        emitDiagnosticEvent("chatgpt_tela_service", "spawned", { service: input.service });
      } finally {
        closeSync(logFd);
      }
      const deadline = Date.now() + timeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        await sleep(100);
        try {
          const descriptor = readServiceRuntimeDescriptor(input.descriptorPath);
          if (!descriptor) {
            if (child.exitCode !== null || !pidAlive(child.pid ?? -1)) break;
            continue;
          }
          if (descriptor.installId !== this.#installId) {
            throw new Error(`${input.service} daemon wrote a descriptor for a different install instance`);
          }
          const exact = descriptorForService(descriptor, input.service);
          const requestDeadline = deadlineSignal(500);
          try {
            const status = await new LocalServiceClient(exact).status(requestDeadline.signal);
            emitDiagnosticEvent("chatgpt_tela_service", "ensure_ready", {
              service: input.service,
              duration_ms: diagnosticDurationMs(startedAt),
            });
            return Object.freeze({ descriptor: exact, status: status as ServiceStatus & { readonly service: S } });
          } finally {
            requestDeadline.close();
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (child.pid && pidAlive(child.pid)) child.kill("SIGTERM");
      emitDiagnosticEvent("chatgpt_tela_service", "ensure_failed", {
        service: input.service,
        duration_ms: diagnosticDurationMs(startedAt),
      });
      const detail = existsSync(input.logPath) ? readFileSync(input.logPath, "utf8").slice(-4000).trim() : "";
      throw new Error(`${input.service} daemon did not become ready${detail ? `: ${detail}` : ""}`, lastError ? { cause: lastError } : undefined);
    } finally {
      await release();
    }
  }

  async shutdown(input: {
    readonly service: TelaServiceId;
    readonly descriptorPath: string;
    readonly stopTimeoutMs?: number;
  }): Promise<boolean> {
    const startedAt = Date.now();
    const budget = input.stopTimeoutMs ?? (input.service === "codex" ? DEFAULT_CODEX_STOP_TIMEOUT_MS : DEFAULT_STOP_TIMEOUT_MS);
    if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("service shutdown budget is invalid");
    const deadline = startedAt + budget;
    const running = await this.current({ service: input.service, descriptorPath: input.descriptorPath });
    if (!running) {
      emitDiagnosticEvent("chatgpt_tela_service", "shutdown_already_stopped", { service: input.service });
      return false;
    }
    emitDiagnosticEvent("chatgpt_tela_service", "shutdown_start", { service: input.service });
    if (Date.now() >= deadline) throw new Error("service shutdown deadline expired before request");
    const requestDeadline = deadlineSignal(input.service === "codex"
      ? deadline - Date.now() : Math.min(2_000, deadline - Date.now()));
    try {
      await new LocalServiceClient(running.descriptor).shutdown(requestDeadline.signal);
    } finally {
      requestDeadline.close();
    }
    while (Date.now() < deadline) {
      // Descriptor disappearance is not process-exit evidence. A daemon can
      // still be draining children; never restore over an unfinished shutdown.
      if (!pidAlive(running.descriptor.pid)) {
        removeServiceRuntimeDescriptor(input.descriptorPath, running.descriptor);
        emitDiagnosticEvent("chatgpt_tela_service", "shutdown_complete", {
          service: input.service,
          duration_ms: diagnosticDurationMs(startedAt),
        });
        return true;
      }
      await sleep(100);
    }
    emitDiagnosticEvent("chatgpt_tela_service", "shutdown_timeout", {
      service: input.service,
      duration_ms: diagnosticDurationMs(startedAt),
    });
    throw new Error(`${input.service} did not stop through its normal service lifecycle`);
  }
}
