import { dirname } from "node:path";
import {
  resolveChatGptTelaBrowserProfile,
  type ChatGptTelaBrowserProfile,
} from "@chatgpt-tela/development-runtime/browser-profile";
import {
  ensureOwnershipManifest,
  prepareOwnedDirectory,
  type PrepareOwnedDirectoryResult,
  type ProductPaths,
} from "@chatgpt-tela/product-lifecycle";

export interface ProfileOwnershipPreparation {
  readonly profile: ChatGptTelaBrowserProfile;
  readonly browserProfile: PrepareOwnedDirectoryResult;
  readonly accountBindings: PrepareOwnedDirectoryResult;
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
      id: `browser-profile:${profile.slot}`,
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
      id: "account-bindings",
      owner: "codex",
      path: dirname(profile.accountBindingPath),
      dataClass: "state",
    },
  });
  return Object.freeze({ profile, browserProfile, accountBindings });
}
