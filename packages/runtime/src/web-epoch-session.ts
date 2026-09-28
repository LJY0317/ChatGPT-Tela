import type { BrowserHost, BrowserSurfaceLease } from "@chatgpt-tela/browser-host";

interface RetainedEpoch {
  readonly epochId: string;
  readonly surface: BrowserSurfaceLease;
  busy: boolean;
}

/**
 * Own one physical browser conversation per Native task/Web epoch.
 *
 * A completed turn keeps the surface idle for exact retained continuation. Any failed/ambiguous
 * turn retires the physical surface so later work can never inherit uncertain browser state. A new
 * epoch for the same Native task first retires the previous physical conversation.
 */
export class RetainedBrowserEpochRegistry {
  readonly #browserHost: BrowserHost;
  readonly #byTask = new Map<string, RetainedEpoch>();

  constructor(browserHost: BrowserHost) {
    this.#browserHost = browserHost;
  }

  async acquire(taskId: string, epochId: string): Promise<{
    readonly surface: BrowserSurfaceLease;
    readonly reused: boolean;
  }> {
    if (!taskId.trim() || !epochId.trim()) throw new Error("retained browser task/epoch ids must be non-empty");
    const current = this.#byTask.get(taskId);
    if (current?.busy) throw new Error("native task already has an active retained Web turn");
    if (current && current.epochId === epochId) {
      current.busy = true;
      return Object.freeze({ surface: current.surface, reused: true });
    }
    if (current) {
      this.#byTask.delete(taskId);
      await this.#browserHost.release(current.surface.leaseId);
    }
    const surface = await this.#browserHost.acquire({ taskId, epochId });
    this.#byTask.set(taskId, { epochId, surface, busy: true });
    return Object.freeze({ surface, reused: false });
  }

  complete(taskId: string, epochId: string): void {
    const current = this.#byTask.get(taskId);
    if (!current || current.epochId !== epochId || !current.busy) {
      throw new Error("retained browser completion does not own the active task epoch");
    }
    current.busy = false;
  }

  async fail(taskId: string, epochId: string): Promise<void> {
    const current = this.#byTask.get(taskId);
    if (!current || current.epochId !== epochId) return;
    this.#byTask.delete(taskId);
    await this.#browserHost.release(current.surface.leaseId);
  }

  async retire(taskId: string): Promise<void> {
    const current = this.#byTask.get(taskId);
    if (!current) return;
    if (current.busy) throw new Error("cannot retire a busy retained browser epoch");
    this.#byTask.delete(taskId);
    await this.#browserHost.release(current.surface.leaseId);
  }

  get size(): number {
    return this.#byTask.size;
  }
}
