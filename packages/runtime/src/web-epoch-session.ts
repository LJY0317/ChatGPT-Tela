import type { BrowserHost, BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { diagnosticFailureClass, emitDiagnosticEvent, type BrowserRetentionObservation } from "@chatgpt-tela/core";

interface RetainedEpoch {
  readonly epochId: string;
  readonly surface: BrowserSurfaceLease;
  busy: boolean;
  retiring?: boolean;
  lastCompleted: number;
  idleSince?: number;
}

const IDLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Own one physical browser conversation per Native task/Web epoch.
 *
 * A completed turn keeps the surface idle for exact retained continuation. Any failed/ambiguous
 * turn cannot be reused. A delivery timeout keeps its surface viewable under idle retention. A new
 * epoch for the same Native task first retires the previous physical conversation.
 */
export class RetainedBrowserEpochRegistry {
  readonly #browserHost: BrowserHost;
  readonly #byTask = new Map<string, RetainedEpoch>();
  readonly #acquiring = new Set<string>();
  readonly #surfaceTarget: number;
  readonly #isTaskActive: (taskId: string) => boolean;
  readonly #onRetire: ((taskId: string, surfaceLeaseId: string) => void) | undefined;
  #completed = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  readonly #now: () => number;

  constructor(browserHost: BrowserHost, options: {
    readonly surfaceTarget?: number;
    readonly isTaskActive?: (taskId: string) => boolean;
    readonly onRetire?: (taskId: string, surfaceLeaseId: string) => void;
    readonly now?: () => number;
  } = {}) {
    if (options.surfaceTarget !== undefined
      && (!Number.isSafeInteger(options.surfaceTarget) || options.surfaceTarget < 1)) {
      throw new Error("browser surface target must be a positive safe integer");
    }
    this.#browserHost = browserHost;
    this.#surfaceTarget = options.surfaceTarget ?? 10;
    this.#isTaskActive = options.isTaskActive ?? (() => false);
    this.#onRetire = options.onRetire;
    this.#now = options.now ?? Date.now;
  }

  #active(taskId: string, entry: RetainedEpoch): boolean {
    return entry.busy || this.#acquiring.has(taskId) || this.#isTaskActive(taskId);
  }

  /** One next-expiry timer, owned by the runtime lifecycle. */
  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#disposed) return;
    const expiry = [...this.#byTask.entries()]
      .filter(([task, entry]) => !entry.retiring && !this.#active(task, entry) && entry.idleSince !== undefined)
      .reduce((first, [, entry]) => Math.min(first, entry.idleSince! + IDLE_RETENTION_MS), Infinity);
    if (expiry === Infinity) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.retireExpired().catch(() => {});
    }, Math.max(1, Math.min(expiry - this.#now(), 2_147_483_647)));
    this.#timer.unref?.();
  }

  /** Also callable directly for deterministic, clock-controlled verification. */
  async retireExpired(): Promise<void> {
    if (this.#disposed) return;
    try {
      for (const [task, entry] of this.#byTask) {
        if (this.#disposed) break;
        if (entry.idleSince === undefined || entry.retiring || this.#active(task, entry)
          || this.#now() - entry.idleSince < IDLE_RETENTION_MS) continue;
        await this.#release(task, entry);
      }
    } finally {
      this.#schedule();
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async acquire(taskId: string, epochId: string): Promise<{
    readonly surface: BrowserSurfaceLease;
    readonly reused: boolean;
  }> {
    if (this.#disposed) throw new Error("retained browser registry is disposed");
    if (!taskId.trim() || !epochId.trim()) throw new Error("retained browser task/epoch ids must be non-empty");
    const current = this.#byTask.get(taskId);
    if (current?.retiring) throw new Error("prior Web surface retirement is unresolved");
    if (current?.busy || this.#acquiring.has(taskId)) {
      throw new Error("native task already has an active retained Web turn");
    }
    this.#acquiring.add(taskId);
    try {
      if (current && current.epochId === epochId && current.lastCompleted > 0) {
        current.busy = true;
        delete current.idleSince;
        this.#schedule();
        return Object.freeze({ surface: current.surface, reused: true });
      }
      if (current) {
        await this.#release(taskId, current);
      }
      await this.#trim(1);
      const surface = await this.#browserHost.acquire({ taskId, epochId });
      this.#byTask.set(taskId, { epochId, surface, busy: true, lastCompleted: 0 });
      return Object.freeze({ surface, reused: false });
    } finally {
      this.#acquiring.delete(taskId);
      this.#schedule();
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
    current.idleSince = this.#now();
    this.#schedule();
    await this.#trim();
  }

  /** Read existing ownership only; observing never closes a browser or touches its page. */
  retention(surfaceId?: string): BrowserRetentionObservation {
    const total = Math.max(this.#browserHost.activeSurfaceCount ?? this.#byTask.size, this.#byTask.size);
    const counts = { active: 0, undelivered: 0, closing: 0, reclaimable: 0 };
    let surface: BrowserRetentionObservation["surface"];
    for (const [task, entry] of this.#byTask) {
      const state = entry.retiring ? "closing" : this.#active(task, entry) ? "active"
        : entry.lastCompleted === 0 ? "undelivered" : "reclaimable";
      counts[state]++;
      if (surfaceId === entry.surface.leaseId) surface = Object.freeze({ id: surfaceId, taskId: task, state,
        nextAction: ({ active: "wait_for_work", undelivered: "inspect_result",
          closing: "inspect_close", reclaimable: "allow_idle_cleanup" } as const)[state],
        ...(entry.idleSince === undefined ? {} : { idleExpiresAt: new Date(entry.idleSince + IDLE_RETENTION_MS).toISOString() }),
      });
    }
    return Object.freeze({ total, target: this.#surfaceTarget, ...counts,
      otherOwners: Math.max(0, total - this.#byTask.size), ...(surface ? { surface } : {}) });
  }

  /** On demand only. Count every host surface, but retire only settled task epochs.
   * Busy/creating operations and undelivered answers can exceed the soft target. */
  async #trim(reserved = 0): Promise<void> {
    const count = () => this.#browserHost.activeSurfaceCount ?? this.#byTask.size;
    if (count() + reserved <= this.#surfaceTarget) return;
    const idle = [...this.#byTask.entries()].filter(([task, entry]) =>
      !entry.retiring && entry.lastCompleted > 0 && !this.#active(task, entry))
      .sort(([, left], [, right]) => left.lastCompleted - right.lastCompleted);
    for (const [task, entry] of idle) {
      if (count() + reserved <= this.#surfaceTarget) break;
      // Recheck after asynchronous releases: a peer may have started its next turn meanwhile.
      if (this.#byTask.get(task) === entry && !entry.retiring && !this.#active(task, entry)) {
        try { await this.#release(task, entry); }
        catch (error) {
          // Cleanup cannot turn a completed answer or an independent new task into a failure.
          emitDiagnosticEvent("chatgpt_tela_work", "browser_retention_failed", {
            failure_class: diagnosticFailureClass(error), policy: "surface_target",
          });
        }
      }
    }
    emitDiagnosticEvent("chatgpt_tela_work", "browser_retention_observed", {
      surface_count: count(), target_count: this.#surfaceTarget, reserved_count: reserved,
      protected_count: [...this.#byTask.entries()].filter(([task, entry]) =>
        entry.retiring || entry.lastCompleted === 0 || this.#active(task, entry)).length,
    });
  }

  async fail(taskId: string, epochId: string, preserveSurface = false): Promise<void> {
    const current = this.#byTask.get(taskId);
    if (!current || current.epochId !== epochId) return;
    if (preserveSurface) {
      current.busy = false;
      current.lastCompleted = 0; // Viewable, never a committed context for reuse.
      current.idleSince = this.#now();
      this.#schedule();
      return;
    }
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
    this.#schedule();
    this.#onRetire?.(taskId, current.surface.leaseId);
    await this.#browserHost.release(current.surface.leaseId);
    if (this.#byTask.get(taskId) === current) this.#byTask.delete(taskId);
    this.#schedule();
  }

  get size(): number {
    return this.#byTask.size;
  }
}
