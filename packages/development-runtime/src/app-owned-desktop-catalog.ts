import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatGptWebModelFamily } from "@chatgpt-tela/chatgpt";
import {
  prepareOwnedDirectory,
  readOwnershipManifest,
  readOwnershipMarker,
  type ProductPaths,
} from "@chatgpt-tela/product-lifecycle";
import { augmentNativeCodexModelCatalog } from "./web-model-catalog";

export const APP_OWNED_DESKTOP_CATALOG_RESOURCE_ID = "app-owned-desktop-model-catalog";

/** A stable install-owned file, also used by explicit provider registration. */
export function appOwnedDesktopCatalogPath(paths: Pick<ProductPaths, "stateRoot">): string {
  return join(paths.stateRoot, "install", "desktop-model-catalog", "models.json");
}

function ownedCatalogDirectory(paths: ProductPaths, installId: string): {
  readonly path: string; readonly productVersion: string;
} {
  const manifest = readOwnershipManifest(paths.installManifest);
  if (!manifest || manifest.installId !== installId) {
    throw new Error("Desktop model catalog requires the current installed Tela owner");
  }
  return { path: dirname(appOwnedDesktopCatalogPath(paths)), productVersion: manifest.productVersion };
}

/** The registration command may consume only this install's prepared file. */
export function readPreparedAppOwnedDesktopCatalog(input: {
  readonly paths: ProductPaths;
  readonly installId: string;
}): string {
  const { path: directory } = ownedCatalogDirectory(input.paths, input.installId);
  const manifest = readOwnershipManifest(input.paths.installManifest)!;
  const resource = manifest.resources.find(resource => resource.id === APP_OWNED_DESKTOP_CATALOG_RESOURCE_ID);
  if (!resource || resource.kind !== "directory" || resource.owner !== "product"
    || resource.path !== directory || resource.dataClass !== "config") {
    throw new Error("Installed Desktop model catalog has no owned resource");
  }
  const marker = readOwnershipMarker(resource);
  if (!marker || marker.installId !== input.installId || marker.resourceId !== resource.id) {
    throw new Error("Installed Desktop model catalog ownership changed");
  }
  const file = appOwnedDesktopCatalogPath(input.paths);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Installed Desktop model catalog must be a regular file");
  const document: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!document || typeof document !== "object" || !Array.isArray((document as { models?: unknown }).models)) {
    throw new Error("Installed Desktop model catalog is not a Codex models document");
  }
  return file;
}

/** Publish once after the bound Web discovery succeeds; no separate catalog cache or engine lifecycle. */
export async function publishAppOwnedDesktopCatalog(input: {
  readonly paths: ProductPaths;
  readonly installId: string;
  readonly nativeCatalog: unknown;
  readonly webFamilies: readonly ChatGptWebModelFamily[];
  /** Re-prove the account after asynchronous Native discovery, immediately before publishing. */
  readonly assertCurrentAccount: () => void;
}): Promise<string> {
  const { path: directory, productVersion } = ownedCatalogDirectory(input.paths, input.installId);
  const prepared = await prepareOwnedDirectory({
    manifestPath: input.paths.installManifest,
    installId: input.installId,
    productVersion,
    resource: { kind: "directory", id: APP_OWNED_DESKTOP_CATALOG_RESOURCE_ID,
      owner: "product", path: directory, dataClass: "config" },
  });
  if (prepared.state === "external-existing") {
    throw new Error("Desktop model catalog directory belongs to another owner");
  }
  const content = `${JSON.stringify(augmentNativeCodexModelCatalog(input.nativeCatalog, input.webFamilies))}\n`;
  const path = appOwnedDesktopCatalogPath(input.paths);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Desktop model catalog file was replaced");
  }
  const temporary = join(directory, `.models-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: "wx", encoding: "utf8", mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs determine file permissions. */ }
    input.assertCurrentAccount();
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return readPreparedAppOwnedDesktopCatalog({ paths: input.paths, installId: input.installId });
}
