import { existsSync, lstatSync } from "node:fs";
import {
  parseOwnedResource,
  readOwnershipManifest,
  readOwnershipMarker,
  writeOwnershipMarker,
  type OwnedResource,
} from "./ownership";
import {
  registerOwnedResource,
} from "./ownership-store";

type DirectoryResource = Extract<OwnedResource, { readonly kind: "directory" }>;

export type PrepareOwnedDirectoryResult =
  | { readonly state: "created-owned"; readonly resource: DirectoryResource }
  | { readonly state: "already-owned"; readonly resource: DirectoryResource }
  | { readonly state: "external-existing"; readonly resource: DirectoryResource };

function sameResource(left: OwnedResource, right: OwnedResource): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Prepare one persistent product directory without silently adopting pre-existing user state.
 *
 * The manifest intent is written before a new directory marker. If an existing directory has no Tela
 * marker, it is usable by the caller but remains external and therefore outside uninstall authority.
 * A marker from another install/resource fails closed instead of being replaced.
 */
export async function prepareOwnedDirectory(input: {
  readonly manifestPath: string;
  readonly installId: string;
  readonly productVersion: string;
  readonly resource: DirectoryResource;
}): Promise<PrepareOwnedDirectoryResult> {
  const resource = parseOwnedResource(input.resource) as DirectoryResource;
  const manifest = readOwnershipManifest(input.manifestPath);
  if (!manifest || manifest.installId !== input.installId) {
    throw new Error("owned directory preparation requires the exact current install manifest");
  }
  const recorded = manifest.resources.find(candidate => candidate.id === resource.id);
  if (recorded && !sameResource(recorded, resource)) {
    throw new Error("owned directory resource id already records a different identity");
  }

  if (existsSync(resource.path)) {
    const stat = lstatSync(resource.path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("owned directory path is unsafe or replaced");
    }
    const marker = readOwnershipMarker(resource.path);
    if (!marker) {
      return Object.freeze({ state: "external-existing", resource });
    }
    if (marker.installId !== input.installId || marker.resourceId !== resource.id) {
      throw new Error("owned directory marker belongs to a different install or resource");
    }
    if (!recorded) {
      throw new Error("owned directory marker exists without matching manifest authority");
    }
    return Object.freeze({ state: "already-owned", resource });
  }

  if (!recorded) {
    await registerOwnedResource({
      path: input.manifestPath,
      installId: input.installId,
      productVersion: input.productVersion,
      resource,
    });
  }
  const current = readOwnershipManifest(input.manifestPath);
  if (!current || current.installId !== input.installId) {
    throw new Error("install manifest changed during owned directory preparation");
  }
  writeOwnershipMarker(resource.path, current, resource.id);
  return Object.freeze({ state: "created-owned", resource });
}
