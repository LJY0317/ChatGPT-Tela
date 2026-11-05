import { createHash } from "node:crypto";
import { dirname } from "node:path";
import {
  resolveChatGptTelaBrowserProfile,
  type ChatGptTelaBrowserProfile,
} from "@chatgpt-tela/development-runtime/browser-profile";
import {
  ensureOwnershipManifest,
  prepareOwnedDirectory,
  readOwnershipManifest,
  type OwnershipManifest,
  type PrepareOwnedDirectoryResult,
  type ProductPaths,
} from "@chatgpt-tela/product-lifecycle";

export interface ProfileOwnershipPreparation {
  readonly profile: ChatGptTelaBrowserProfile;
  readonly browserProfile: PrepareOwnedDirectoryResult;
  readonly accountBindings: PrepareOwnedDirectoryResult;
}

function directoryResourceId(manifest: OwnershipManifest, legacyId: string, path: string): string {
  const qualifiedId = `${legacyId}:${createHash("sha256").update(path).digest("hex")}`;
  const matching = manifest.resources.find(resource => resource.kind === "directory"
    && resource.path === path && (resource.id === legacyId || resource.id === qualifiedId));
  if (matching) return matching.id;
  const legacy = manifest.resources.find(resource => resource.id === legacyId);
  if (!legacy) return legacyId;
  // A relocated profile is a separate owned directory; do not replace the old marker or manifest entry.
  return qualifiedId;
}

/**
 * Claim only persistent profile state that this install creates itself.
 * Existing unmarked profile/cookie data remains external and uninstall-ineligible.
 */
export async function prepareProfileOwnership(input: {
  readonly slot: number;
  readonly productPaths: ProductPaths;
  readonly productVersion: string;
  readonly profileRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<ProfileOwnershipPreparation> {
  const manifest = await ensureOwnershipManifest({
    path: input.productPaths.installManifest,
    productVersion: input.productVersion,
  });
  const profile = resolveChatGptTelaBrowserProfile({
    slot: input.slot,
    ...(input.profileRoot ? { profileRoot: input.profileRoot } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
  });
  const browserProfile = await prepareOwnedDirectory({
    manifestPath: input.productPaths.installManifest,
    installId: manifest.installId,
    productVersion: manifest.productVersion,
    resource: {
      kind: "directory",
      id: directoryResourceId(manifest, `browser-profile:${profile.slot}`, profile.userDataDir),
      owner: "codex",
      path: profile.userDataDir,
      dataClass: "browser-profile",
    },
  });
  const accountBindings = await prepareOwnedDirectory({
    manifestPath: input.productPaths.installManifest,
    installId: manifest.installId,
    productVersion: manifest.productVersion,
    resource: {
      kind: "directory",
      id: directoryResourceId(manifest, "account-bindings", dirname(profile.accountBindingPath)),
      owner: "codex",
      path: dirname(profile.accountBindingPath),
      dataClass: "state",
    },
  });
  return Object.freeze({ profile, browserProfile, accountBindings });
}

/** Installed Codex connections use setup's persistent profile registration. */
export async function prepareInstalledProfileOwnership(input: {
  readonly slot: number;
  readonly productPaths: ProductPaths;
  readonly installId: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<ProfileOwnershipPreparation> {
  const ownership = readOwnershipManifest(input.productPaths.installManifest);
  if (!ownership || ownership.installId !== input.installId) throw Error("Codex profile requires the current installed owner");
  return prepareProfileOwnership({
    slot: input.slot, productPaths: input.productPaths, productVersion: ownership.productVersion,
    ...(input.environment ? { environment: input.environment } : {}),
  });
}
