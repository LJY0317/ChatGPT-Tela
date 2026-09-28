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
import {
  readServiceRuntimeDescriptor,
  removeServiceRuntimeDescriptor,
  type ServiceRuntimeDescriptor,
  type ServiceStatus,
  type TelaServiceId,
} from "@chatgpt-tela/service-protocol";
import {
  LocalServiceClient,
  descriptorForService,
} from "@chatgpt-tela/service-protocol/client";

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
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

export class LocalServiceSupervisor {
  readonly #installId: string;

  constructor(input: { readonly installId: string }) {
    if (!input.installId.trim() || /[\u0000\r\n]/.test(input.installId)) throw new Error("Tela install id is invalid");
    this.#installId = input.installId;
  }

  async current<S extends TelaServiceId>(input: {
    readonly service: S;
    readonly descriptorPath: string;
    readonly requestTimeoutMs?: number;
  }): Promise<RunningService<S> | undefined> {
    const descriptor = readServiceRuntimeDescriptor(input.descriptorPath);
    if (!descriptor) return undefined;
    if (descriptor.installId !== this.#installId) {
      throw new Error(`${input.service} runtime belongs to a different Tela install instance`);
    }
    const exact = descriptorForService(descriptor, input.service);
    const deadline = deadlineSignal(input.requestTimeoutMs ?? 1_500);
    try {
      const status = await new LocalServiceClient(exact).status(deadline.signal);
      return Object.freeze({ descriptor: exact, status: status as ServiceStatus & { readonly service: S } });
    } catch (error) {
      if (pidAlive(exact.pid)) {
        throw new Error(`${input.service} process is alive but its private service endpoint is unavailable`, { cause: error });
      }
      removeServiceRuntimeDescriptor(input.descriptorPath);
      return undefined;
    } finally {
      deadline.close();
    }
  }

  async ensure<S extends TelaServiceId>(input: EnsureServiceInput<S>): Promise<RunningService<S>> {
    const timeoutMs = input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const release = await acquireStartLock(input.descriptorPath, timeoutMs);
    try {
      const existing = await this.current({ service: input.service, descriptorPath: input.descriptorPath }).catch(error => {
        throw error;
      });
      if (existing) return existing;
      mkdirSync(dirname(input.logPath), { recursive: true, mode: 0o700 });
      const logFd = openSync(input.logPath, "a", 0o600);
      let child;
      try {
        child = spawn(input.command[0], input.command.slice(1), {
          cwd: input.cwd,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          windowsHide: true,
          env: { ...process.env, ...input.environment },
        });
        child.unref();
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
            return Object.freeze({ descriptor: exact, status: status as ServiceStatus & { readonly service: S } });
          } finally {
            requestDeadline.close();
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (child.pid && pidAlive(child.pid)) child.kill("SIGTERM");
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
    const running = await this.current({ service: input.service, descriptorPath: input.descriptorPath });
    if (!running) return false;
    const requestDeadline = deadlineSignal(2_000);
    try {
      await new LocalServiceClient(running.descriptor).shutdown(requestDeadline.signal);
    } finally {
      requestDeadline.close();
    }
    const deadline = Date.now() + (input.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (!existsSync(input.descriptorPath) || !pidAlive(running.descriptor.pid)) {
        if (!pidAlive(running.descriptor.pid)) removeServiceRuntimeDescriptor(input.descriptorPath);
        return true;
      }
      await sleep(100);
    }
    throw new Error(`${input.service} did not stop through its normal service lifecycle`);
  }
}
