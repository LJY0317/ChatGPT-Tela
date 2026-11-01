import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { readOwnershipManifest, withOwnedResource, type OwnedResource } from "./ownership";
import { mutateOwnershipManifest, registerOwnedResource, unregisterOwnedResource } from "./ownership-store";
import type { OwnershipObservation } from "./uninstall";

type Entry = Extract<OwnedResource, { kind: "marketplace-entry" }>;
const ID = "local-chat-personal-marketplace";
const NAME = "tela-local-chat";
type Marketplace = Record<string, unknown> & { plugins: Record<string, unknown>[] };

function fingerprint(entry: unknown): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function load(path: string): Marketplace | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("personal marketplace is not a regular file");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!object(value) || !Array.isArray(value.plugins) || !value.plugins.every(object)) {
    throw Error("personal marketplace has no valid plugins array");
  }
  return value as Marketplace;
}
function write(path: string, value: Marketplace): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.marketplace-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
function ownedEntry(value: Marketplace | undefined, resource: Entry): Record<string, unknown> | undefined {
  return value?.plugins.find(x => x.name === resource.pluginName);
}
export function observeLocalMarketplaceEntry(resource: Entry): OwnershipObservation {
  if (resource.state === "pending") return "unknown";
  try {
    const marketplace = load(resource.path);
    const entry = ownedEntry(marketplace, resource);
    if (!entry) return "missing";
    if (marketplace!.plugins.filter(x => x.name === resource.pluginName).length !== 1) return "dirty";
    return fingerprint(entry) === resource.entryFingerprint ? "owned" : "dirty";
  } catch { return "unsafe"; }
}
export function removeLocalMarketplaceEntry(resource: Entry): { removed: boolean; detail: string } {
  // One snapshot for validation and mutation. Product writers share a transition
  // lock; rename does not provide compare-and-swap against external writers.
  let marketplace: Marketplace | undefined;
  try { marketplace = load(resource.path); } catch {
    return { removed: false, detail: "personal marketplace unreadable; preserved" };
  }
  const entry = ownedEntry(marketplace, resource);
  if (resource.state === "pending" || !entry
    || marketplace!.plugins.filter(x => x.name === resource.pluginName).length !== 1
    || fingerprint(entry) !== resource.entryFingerprint) {
    return { removed: false, detail: "personal marketplace entry changed; preserved" };
  }
  if (!marketplace) return { removed: false, detail: "personal marketplace absent; preserved" };
  const rest = marketplace.plugins.filter(x => x.name !== resource.pluginName);
  if (resource.createdFile && rest.length === 0
    && Object.keys(marketplace).sort().join(",") === "name,plugins"
    && marketplace.name === "tela-local-development") {
    rmSync(resource.path);
  } else {
    write(resource.path, { ...marketplace, plugins: rest });
  }
  return { removed: true, detail: "exact product-created marketplace entry removed" };
}

/** An explicit local-file operation; host plugin installation and account permissions remain separate. */
export async function registerLocalMarketplace(input: {
  manifestPath: string; marketplacePath: string; pluginPath: string;
}): Promise<"registered" | "already-registered" | "preserved-user-change"> {
  const manifest = readOwnershipManifest(input.manifestPath);
  if (!manifest) throw Error("local marketplace registration requires installed product ownership");
  const path = resolve(input.marketplacePath);
  const marketplaceRoot = resolve(dirname(path), "..", "..");
  const rel = relative(marketplaceRoot, resolve(input.pluginPath));
  if (!rel || isAbsolute(rel)) throw Error("invalid local plugin path");
  const entry = { name: NAME, source: { source: "local", path: "./" + rel.split(sep).join("/") },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" };
  const existing = manifest.resources.find(x => x.id === ID);
  if (existing && (existing.kind !== "marketplace-entry" || existing.path !== path)) {
    throw Error("local marketplace resource identity changed");
  }
  if (existing?.kind === "marketplace-entry") {
    if (existing.state !== "pending") {
      return observeLocalMarketplaceEntry(existing) === "owned" ? "already-registered" : "preserved-user-change";
    }
    // A pending intent is never proof of creation. Resume only when the name
    // remains absent; an identical external entry must never be adopted.
    const current = load(path);
    if (existing.entryFingerprint !== fingerprint(entry) || current?.plugins.some(x => x.name === NAME)) {
      return "preserved-user-change";
    }
    write(path, { ...(current ?? { name: "tela-local-development", plugins: [] }),
      plugins: [...(current?.plugins ?? []), entry] });
    await mutateOwnershipManifest({ path: input.manifestPath, installId: manifest.installId,
      productVersion: manifest.productVersion, mutate(currentManifest) {
        if (JSON.stringify(currentManifest.resources.find(x => x.id === ID)) !== JSON.stringify(existing)) throw Error("marketplace intent changed");
        return withOwnedResource({ ...currentManifest, resources: currentManifest.resources.filter(x => x.id !== ID) },
          { ...existing, state: "owned" });
      } });
    return "registered";
  }
  const current = load(path);
  if (current?.plugins.some(x => x.name === NAME)) return "preserved-user-change";
  const resource: Entry = { kind: "marketplace-entry", id: ID, owner: "product",
    path, pluginName: NAME, entryFingerprint: fingerprint(entry), createdFile: !current, state: "pending" };
  // Persist exact intent before touching the shared file, allowing uninstall to resume after interruption.
  await registerOwnedResource({ path: input.manifestPath, installId: manifest.installId,
    productVersion: manifest.productVersion, resource });
  try {
    const latest = load(path);
    if (latest?.plugins.some(x => x.name === NAME)) return "preserved-user-change";
    write(path, { ...(latest ?? { name: "tela-local-development", plugins: [] }), plugins: [...(latest?.plugins ?? []), entry] });
    await mutateOwnershipManifest({ path: input.manifestPath, installId: manifest.installId,
      productVersion: manifest.productVersion, mutate(currentManifest) {
        if (JSON.stringify(currentManifest.resources.find(x => x.id === ID)) !== JSON.stringify(resource)) throw Error("marketplace intent changed");
        return withOwnedResource({ ...currentManifest, resources: currentManifest.resources.filter(x => x.id !== ID) },
          { ...resource, state: "owned" });
      } });
  } catch (error) {
    if (observeLocalMarketplaceEntry(resource) === "missing") {
      await unregisterOwnedResource({ path: input.manifestPath, installId: manifest.installId,
        productVersion: manifest.productVersion, resourceId: ID });
    }
    throw error;
  }
  return "registered";
}
