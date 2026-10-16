import type { BrowserHost, BrowserSurfaceLease } from "@chatgpt-tela/browser-host";

interface RetainedEpoch {
  readonly epochId: string;
  readonly surface: BrowserSurfaceLease;
  busy: boolean;
  retiring?: boolean;
  lastCompleted: number;
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
  readonly #acquiring = new Set<string>();
  readonly #maxIdleEpochs: number | undefined;
  readonly #onRetire: ((taskId: string, surfaceLeaseId: string) => void) | undefined;
  #completed = 0;

  constructor(browserHost: BrowserHost, options: {
    readonly maxIdleEpochs?: number;
    readonly onRetire?: (taskId: string, surfaceLeaseId: string) => void;
  } = {}) {
    if (options.maxIdleEpochs !== undefined
      && (!Number.isSafeInteger(options.maxIdleEpochs) || options.maxIdleEpochs < 1)) {
      throw new Error("idle browser epoch limit must be a positive safe integer");
    }
    this.#browserHost = browserHost;
    this.#maxIdleEpochs = options.maxIdleEpochs;
    this.#onRetire = options.onRetire;
  }

  async acquire(taskId: string, epochId: string): Promise<{
    readonly surface: BrowserSurfaceLease;
    readonly reused: boolean;
  }> {
    if (!taskId.trim() || !epochId.trim()) throw new Error("retained browser task/epoch ids must be non-empty");
    const current = this.#byTask.get(taskId);
    if (current?.retiring) throw new Error("prior Web surface retirement is unresolved");
    if (current?.busy || this.#acquiring.has(taskId)) {
      throw new Error("native task already has an active retained Web turn");
    }
    this.#acquiring.add(taskId);
    try {
      if (current && current.epochId === epochId) {
        current.busy = true;
        return Object.freeze({ surface: current.surface, reused: true });
      }
      if (current) {
        await this.#release(taskId, current);
      }
      const surface = await this.#browserHost.acquire({ taskId, epochId });
      this.#byTask.set(taskId, { epochId, surface, busy: true, lastCompleted: 0 });
      return Object.freeze({ surface, reused: false });
    } finally {
      this.#acquiring.delete(taskId);
    }
  }

  async complete(taskId: string, epochId: string, commit?: () => void): Promise<void> {
    const current = this.#byTask.get(taskId);
    if (!current || current.epochId !== epochId || !current.busy) {
      throw new Error("retained browser completion does not own the active task epoch");
    }
    // Publish the anchor while this exact surface is still busy and cannot be retired by a peer.
    commit?.();
    current.busy = false;
    current.lastCompleted = ++this.#completed;
    if (this.#maxIdleEpochs === undefined) return;
    const idle = [...this.#byTask.entries()].filter(([task, entry]) => !entry.busy && !this.#acquiring.has(task))
      .sort(([, left], [, right]) => left.lastCompleted - right.lastCompleted);
    for (const [task, entry] of idle.slice(0, Math.max(0, idle.length - this.#maxIdleEpochs))) {
      // Recheck after asynchronous releases: a peer may have started its next turn meanwhile.
      if (this.#byTask.get(task) === entry && !entry.busy && !this.#acquiring.has(task)) {
        await this.#release(task, entry);
      }
    }
  }

  async fail(taskId: string, epochId: string): Promise<void> {
    const current = this.#byTask.get(taskId);
    if (!current || current.epochId !== epochId) return;
    await this.#release(taskId, current);
  }

  async retire(taskId: string): Promise<void> {
    if (this.#acquiring.has(taskId)) throw new Error("cannot retire a busy retained browser epoch");
    const current = this.#byTask.get(taskId);
    if (!current) return;
    if (current.busy) throw new Error("cannot retire a busy retained browser epoch");
    await this.#release(taskId, current);
  }

  async #release(taskId: string, current: RetainedEpoch): Promise<void> {
    if (current.retiring) throw new Error("prior Web surface retirement is unresolved");
    current.retiring = true;
    this.#onRetire?.(taskId, current.surface.leaseId);
    await this.#browserHost.release(current.surface.leaseId);
    if (this.#byTask.get(taskId) === current) this.#byTask.delete(taskId);
  }

  get size(): number {
    return this.#byTask.size;
  }
}
