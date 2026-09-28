export interface BrowserSurfaceCapability<T> {
  readonly key: symbol;
  readonly name: string;
  /** Type-only anchor for the capability payload. */
  readonly __type?: T;
}

export function createBrowserSurfaceCapability<T>(name: string): BrowserSurfaceCapability<T> {
  if (!name.trim()) throw new Error("browser surface capability name must be non-empty");
  return Object.freeze({ key: Symbol(name), name });
}

export interface BrowserSurfaceLease {
  readonly leaseId: string;
  readonly taskId: string;
  readonly epochId: string;
  navigate(url: string): Promise<void>;
  reveal(): Promise<void>;
  hide(): Promise<void>;
  capability<T>(capability: BrowserSurfaceCapability<T>): T | undefined;
}

export interface BrowserHost {
  acquire(input: { taskId: string; epochId: string }): Promise<BrowserSurfaceLease>;
  release(leaseId: string): Promise<void>;
  close(): Promise<void>;
}

export * from "./controlled";
export * from "./page-automation";
