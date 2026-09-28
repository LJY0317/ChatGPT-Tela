import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createOwnershipManifest,
  parseOwnedResource,
  readOwnershipManifest,
  withOwnedResource,
  withoutOwnedResource,
  writeOwnershipManifest,
  type OwnedResource,
  type OwnershipManifest,
} from "./ownership";

const DEFAULT_LOCK_TIMEOUT_MS = 3_000;
const STALE_LOCK_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

async function acquireManifestLock(path: string, timeoutMs: number): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => { await rm(lockPath, { recursive: true, force: true }); };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const current = await stat(lockPath);
        if (Date.now() - current.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for Tela ownership manifest lock");
      await sleep(25);
    }
  }
}

export async function mutateOwnershipManifest(input: {
  readonly path: string;
  readonly installId: string;
  readonly productVersion: string;
  readonly mutate: (manifest: OwnershipManifest) => OwnershipManifest;
  readonly lockTimeoutMs?: number;
}): Promise<OwnershipManifest> {
  const release = await acquireManifestLock(input.path, input.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  try {
    const current = readOwnershipManifest(input.path)
      ?? createOwnershipManifest(input.productVersion, new Date(), input.installId);
    if (current.installId !== input.installId) {
      throw new Error("ownership manifest belongs to a different Tela install instance");
    }
    const next = input.mutate(current);
    if (next.installId !== current.installId) throw new Error("ownership manifest mutation changed install identity");
    writeOwnershipManifest(input.path, next);
    return next;
  } finally {
    await release();
  }
}

export async function ensureOwnershipManifest(input: {
  readonly path: string;
  readonly productVersion: string;
  readonly lockTimeoutMs?: number;
}): Promise<OwnershipManifest> {
  const release = await acquireManifestLock(input.path, input.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  try {
    const current = readOwnershipManifest(input.path);
    if (current) return current;
    const created = createOwnershipManifest(input.productVersion);
    writeOwnershipManifest(input.path, created);
    return created;
  } finally {
    await release();
  }
}

export async function registerOwnedResource(input: {
  readonly path: string;
  readonly installId: string;
  readonly productVersion: string;
  readonly resource: OwnedResource;
}): Promise<OwnershipManifest> {
  const normalized = parseOwnedResource(input.resource);
  return mutateOwnershipManifest({
    path: input.path,
    installId: input.installId,
    productVersion: input.productVersion,
    mutate(manifest) {
      const existing = manifest.resources.find(resource => resource.id === normalized.id);
      if (!existing) return withOwnedResource(manifest, normalized);
      if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
        throw new Error(`ownership resource id is already registered with different identity: ${normalized.id}`);
      }
      return manifest;
    },
  });
}

export async function unregisterOwnedResource(input: {
  readonly path: string;
  readonly installId: string;
  readonly productVersion: string;
  readonly resourceId: string;
}): Promise<OwnershipManifest> {
  return mutateOwnershipManifest({
    path: input.path,
    installId: input.installId,
    productVersion: input.productVersion,
    mutate: manifest => withoutOwnedResource(manifest, input.resourceId),
  });
}
