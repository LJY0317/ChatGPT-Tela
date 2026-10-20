import { randomBytes } from "node:crypto";
import type {
  BrowserHost,
  BrowserSurfaceCapability,
  BrowserSurfaceLease,
} from "./index";

export interface BrowserSurfaceController {
  displayName?(): string;
  onLabelChange?(listener: () => void): () => void;
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
  readonly lease: BrowserSurfaceLease;
  readonly key: string;
  readonly controller: BrowserSurfaceController;
  readonly detachLabel?: () => void;
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
/** Never display injected Native transport text as a conversation title. */
export function safeSurfaceLabel(title: string | undefined, index: number): string {
  const value = title?.trim() ?? "";
  return !value || /\$chatgpt-tela|chatgpt_tela_transport_contract|Act as the model backend/i.test(value)
    ? `Web session ${index + 1}` : value.slice(0, 200);
}

export class ControlledBrowserHost implements BrowserHost {
  readonly #factory: BrowserSurfaceControllerFactory;
  readonly #surfaces = new Map<string, OwnedSurface>();
  readonly #leaseByKey = new Map<string, string>();
  readonly #creating = new Map<string, Promise<BrowserSurfaceController>>();
  #listeners = new Set<() => void>();
  #revision = 0;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(factory: BrowserSurfaceControllerFactory) {
    this.#factory = factory;
  }

  async acquire(input: { taskId: string; epochId: string }): Promise<BrowserSurfaceLease> {
    if (this.#closed) throw new Error("browser host is closed");
    if (!input.taskId.trim() || !input.epochId.trim()) {
      throw new Error("browser surface task and epoch ids must be non-empty");
    }
    const key = surfaceKey(input.taskId, input.epochId);
    if (this.#leaseByKey.has(key) || this.#creating.has(key)) {
      throw new Error("browser surface already has an active owner for this task epoch");
    }

    // Reserve the key before the platform factory starts. Shutdown owns pending creations too.
    const creation = Promise.resolve().then(() => this.#factory(input));
    this.#creating.set(key, creation);
    let controller: BrowserSurfaceController;
    try {
      controller = await creation;
      if (this.#closed) throw new Error("browser host is closed");
    } finally {
      this.#creating.delete(key);
    }
    const id = leaseId();
    const lease: BrowserSurfaceLease = Object.freeze({
      leaseId: id,
      taskId: input.taskId,
      epochId: input.epochId,
      navigate: (url: string) => controller.navigate(url),
      reveal: () => controller.reveal(),
      hide: () => controller.hide(),
      capability: <T>(capability: BrowserSurfaceCapability<T>) => controller.capability?.(capability),
    });
    const detachLabel = controller.onLabelChange?.(() => this.#changed());
    this.#surfaces.set(id, { key, controller, lease, ...(detachLabel ? { detachLabel } : {}) });
    this.#leaseByKey.set(key, id);
    this.#changed();
    return lease;
  }

  async release(id: string): Promise<void> {
    const owned = this.#surfaces.get(id);
    if (!owned) throw new Error("browser surface lease is unknown or already released");
    this.#surfaces.delete(id);
    this.#leaseByKey.delete(owned.key);
    owned.detachLabel?.();
    this.#changed();
    await owned.controller.close();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const surfaces = [...this.#surfaces.entries()];
    this.#surfaces.clear();
    this.#leaseByKey.clear();
    for (const [, surface] of surfaces) surface.detachLabel?.();
    this.#changed();
    this.#listeners.clear();
    const creations = [...this.#creating.values()];
    this.#closing = (async () => {
      const results = await Promise.allSettled([
        ...surfaces.map(([, surface]) => surface.controller.close()),
        ...creations.map(creation => creation.then(controller => controller.close(), () => {})),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} browser surface(s) failed to close`);
      }
    })();
    return this.#closing;
  }

  get activeSurfaceCount(): number {
    return this.#surfaces.size;
  }

  get surfaceRevision(): number { return this.#revision; }
  onSurfacesChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  #changed(): void {
    this.#revision++;
    for (const listener of this.#listeners) listener();
  }

  /** Disposable leases select a view; they never grant task authority. */
  listSurfaces(): readonly { readonly id: string; readonly label: string }[] {
    return [...this.#surfaces].map(([id, surface], index) => Object.freeze({
      id, label: safeSurfaceLabel(surface.controller.displayName?.(), index),
    }));
  }

  /** Internal read-only inspection uses the exact existing lease, never a reconstructed owner. */
  selectedSurfaceLease(id: string): BrowserSurfaceLease {
    const surface = this.#surfaces.get(id);
    if (!surface) throw new Error("selected browser surface is no longer owned");
    return surface.lease;
  }

  selectedCapability<T>(id: string, capability: BrowserSurfaceCapability<T>): T | undefined {
    const surface = this.#surfaces.get(id);
    if (!surface) throw new Error("selected browser surface is no longer owned");
    return surface.controller.capability?.(capability);
  }

  async revealSurface(id: string): Promise<void> {
    const surface = this.#surfaces.get(id);
    if (!surface) throw new Error("selected browser surface is no longer owned");
    await surface.controller.reveal();
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
