import { randomBytes } from "node:crypto";
import type {
  BrowserHost,
  BrowserSurfaceCapability,
  BrowserSurfaceLease,
} from "./index";

export interface BrowserSurfaceController {
  navigate(url: string): Promise<void>;
  reveal(): Promise<void>;
  hide(): Promise<void>;
  close(): Promise<void>;
  capability?<T>(capability: BrowserSurfaceCapability<T>): T | undefined;
}

export type BrowserSurfaceControllerFactory = (input: {
  readonly taskId: string;
  readonly epochId: string;
}) => Promise<BrowserSurfaceController>;

interface OwnedSurface {
  readonly key: string;
  readonly controller: BrowserSurfaceController;
}

function surfaceKey(taskId: string, epochId: string): string {
  return `${taskId}\u0000${epochId}`;
}

function leaseId(): string {
  return `surface_${randomBytes(24).toString("base64url")}`;
}

/**
 * BrowserHost lifecycle owner independent of Electron/Playwright implementation details.
 * One task/epoch pair owns one live surface; release closes it, and host shutdown closes every
 * remaining surface exactly once. The injected controller factory is where platform UI lives.
 */
export class ControlledBrowserHost implements BrowserHost {
  readonly #factory: BrowserSurfaceControllerFactory;
  readonly #surfaces = new Map<string, OwnedSurface>();
  readonly #leaseByKey = new Map<string, string>();
  #closed = false;

  constructor(factory: BrowserSurfaceControllerFactory) {
    this.#factory = factory;
  }

  async acquire(input: { taskId: string; epochId: string }): Promise<BrowserSurfaceLease> {
    if (this.#closed) throw new Error("browser host is closed");
    if (!input.taskId.trim() || !input.epochId.trim()) {
      throw new Error("browser surface task and epoch ids must be non-empty");
    }
    const key = surfaceKey(input.taskId, input.epochId);
    if (this.#leaseByKey.has(key)) {
      throw new Error("browser surface already has an active owner for this task epoch");
    }

    const controller = await this.#factory(input);
    const id = leaseId();
    this.#surfaces.set(id, { key, controller });
    this.#leaseByKey.set(key, id);
    return Object.freeze({
      leaseId: id,
      taskId: input.taskId,
      epochId: input.epochId,
      navigate: (url: string) => controller.navigate(url),
      reveal: () => controller.reveal(),
      hide: () => controller.hide(),
      capability: <T>(capability: BrowserSurfaceCapability<T>) => controller.capability?.(capability),
    });
  }

  async release(id: string): Promise<void> {
    const owned = this.#surfaces.get(id);
    if (!owned) throw new Error("browser surface lease is unknown or already released");
    this.#surfaces.delete(id);
    this.#leaseByKey.delete(owned.key);
    await owned.controller.close();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const surfaces = [...this.#surfaces.entries()];
    this.#surfaces.clear();
    this.#leaseByKey.clear();
    const results = await Promise.allSettled(surfaces.map(([, surface]) => surface.controller.close()));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} browser surface(s) failed to close`);
    }
  }

  get activeSurfaceCount(): number {
    return this.#surfaces.size;
  }

  singleActiveCapability<T>(capability: BrowserSurfaceCapability<T>): {
    readonly activeSurfaceCount: number;
    readonly capability?: T;
  } {
    const activeSurfaceCount = this.#surfaces.size;
    if (activeSurfaceCount !== 1) return Object.freeze({ activeSurfaceCount });
    const surface = this.#surfaces.values().next().value as OwnedSurface | undefined;
    const value = surface?.controller.capability?.(capability);
    return Object.freeze({
      activeSurfaceCount,
      ...(value === undefined ? {} : { capability: value }),
    });
  }
}
