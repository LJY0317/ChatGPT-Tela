import { ownedServiceShutdown } from "./service-shutdown";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  cancelSignedPackagedUpgrade,
  planSignedPackagedUpgradeCancellation,
  applySignedPackagedInstallFromPayload,
  applySignedPackagedRepairFromPayload,
  applySignedPackagedUpgradeWithRecovery,
  assertPackagedUpgradeRecoveryArtifact,
  reviewPackagedRecoveryArtifact,
  PackagedPlatformServiceController,
  planSignedPackagedInstallFromPayload,
  planSignedPackagedRepairFromPayload,
  planSignedPackagedUpgradeFromPayload,
  readPackagedPayloadSignature,
  type PackagedPayloadTrustedKeys,
  type ServiceRegistrationCommandRunner,
  type TelaServiceId,
} from "@chatgpt-tela/product-lifecycle";
import { payloadRootForLauncherExecutable } from "./runtime";

export type PackagedLifecycleCommand = "install" | "repair" | "upgrade" | "cancel-upgrade";
export type PackagedLifecycleMode = "dry-run" | "apply";

export interface ParsedPackagedLifecycleCommand {
  readonly command: PackagedLifecycleCommand;
  readonly mode: PackagedLifecycleMode;
  readonly trustedPublicKeyPath: string;
  readonly payloadSourcePath?: string;
  readonly recoveryPayloadPath?: string;
  readonly recoveryPublicKeyPath?: string;
  /** Caller-supplied out-of-band public keys for already-owned historical recovery slots. */
  readonly retainedRecoveryKeys: readonly { readonly keyId: string; readonly path: string }[];
}

export interface PackagedLifecycleOptions {
  readonly defaultPayloadRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
  readonly userId?: number;
  readonly shutdownService?: (service: TelaServiceId) => Promise<void>;
  readonly prepareShutdownService?: (service: TelaServiceId) => Promise<void>;
}

function oneValue(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parsePackagedLifecycleCommand(arguments_: readonly string[]): ParsedPackagedLifecycleCommand {
  const command = arguments_[0];
  if (!(command === "install" || command === "repair" || command === "upgrade" || command === "cancel-upgrade")) {
    throw new Error("packaged lifecycle command must be install, repair, upgrade, or cancel-upgrade");
  }
  let mode: PackagedLifecycleMode | undefined;
  let trustedPublicKeyPath: string | undefined;
  let payloadSourcePath: string | undefined;
  let recoveryPayloadPath: string | undefined, recoveryPublicKeyPath: string | undefined;
  const retainedRecoveryKeys: { keyId: string; path: string }[] = [];
  for (let index = 1; index < arguments_.length; index += 1) {
    const item = arguments_[index]!;
    if (item === "--dry-run" || item === "--apply") {
      const nextMode: PackagedLifecycleMode = item === "--dry-run" ? "dry-run" : "apply";
      if (mode) throw new Error("choose exactly one of --dry-run or --apply");
      mode = nextMode;
      continue;
    }
    if (item === "--trusted-public-key") {
      if (trustedPublicKeyPath) throw new Error("--trusted-public-key may be specified only once");
      trustedPublicKeyPath = oneValue(arguments_, index, item);
      index += 1;
      continue;
    }
    if (item === "--payload") {
      if (payloadSourcePath) throw new Error("--payload may be specified only once");
      payloadSourcePath = oneValue(arguments_, index, item);
      index += 1;
      continue;
    }
    if (item === "--recovery-payload" || item === "--recovery-public-key") {
      const value = oneValue(arguments_, index, item);
      if (item === "--recovery-payload") {
        if (recoveryPayloadPath) throw new Error("duplicate recovery payload");
        recoveryPayloadPath = value;
      } else {
        if (recoveryPublicKeyPath) throw new Error("duplicate recovery public key");
        recoveryPublicKeyPath = value;
      }
      index += 1; continue;
    }
    if (item === "--retained-recovery-key") {
      const keyId = oneValue(arguments_, index, item);
      const path = oneValue(arguments_, index + 1, item);
      if (!/^[a-zA-Z0-9._-]{1,128}$/.test(keyId)
        || retainedRecoveryKeys.some(entry => entry.keyId === keyId)) {
        throw new Error("retained recovery key id is invalid or duplicated");
      }
      retainedRecoveryKeys.push({ keyId, path });
      index += 2; continue;
    }
    throw new Error(`unknown packaged lifecycle argument: ${item}`);
  }
  if (!mode) throw new Error("choose exactly one of --dry-run or --apply");
  if (!trustedPublicKeyPath) throw new Error("--trusted-public-key is required");
  if (command === "cancel-upgrade" && !payloadSourcePath) throw new Error("cancel-upgrade requires --payload for the signed source package");
  if (Boolean(recoveryPayloadPath) !== Boolean(recoveryPublicKeyPath)
    || (recoveryPayloadPath && command !== "upgrade")) throw new Error("upgrade recovery requires both signed source payload and public key");
  if (retainedRecoveryKeys.length && (command !== "upgrade" || !recoveryPayloadPath)) {
    throw new Error("historical recovery keys require an explicit signed upgrade recovery source");
  }
  return Object.freeze({
    command,
    mode,
    trustedPublicKeyPath,
    retainedRecoveryKeys: Object.freeze(retainedRecoveryKeys.map(item => Object.freeze(item))),
    ...(payloadSourcePath ? { payloadSourcePath } : {}),
    ...(recoveryPayloadPath ? { recoveryPayloadPath, recoveryPublicKeyPath: recoveryPublicKeyPath! } : {}),
  });
}

function realRegularFile(path: string, field: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${field} is missing: ${absolute}`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${field} must be a real regular file`);
  return realpathSync(absolute);
}

function realDirectory(path: string, field: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${field} is missing: ${absolute}`);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${field} must be a real directory`);
  return realpathSync(absolute);
}

function trustedKeys(payloadSourcePath: string, trustedPublicKeyPath: string): PackagedPayloadTrustedKeys {
  const envelope = readPackagedPayloadSignature(payloadSourcePath);
  const publicKey = readFileSync(realRegularFile(trustedPublicKeyPath, "trusted release public key"));
  return Object.freeze({ [envelope.keyId]: publicKey });
}

function lifecycleEnvironment(input: PackagedLifecycleOptions) {
  return {
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.home ? { home: input.home } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
  };
}

export async function runPackagedLifecycleCommand(
  arguments_: readonly string[],
  options: PackagedLifecycleOptions = {},
): Promise<unknown> {
  const parsed = parsePackagedLifecycleCommand(arguments_);
  const payloadSourcePath = realDirectory(
    parsed.payloadSourcePath ?? options.defaultPayloadRoot ?? payloadRootForLauncherExecutable(),
    "packaged payload",
  );
  const keys = trustedKeys(payloadSourcePath, parsed.trustedPublicKeyPath);
  const environment = lifecycleEnvironment(options);

  if (parsed.command === "cancel-upgrade") {
    const input = { sourcePayloadPath: payloadSourcePath, trustedKeys: keys, ...environment };
    const reviewed = await planSignedPackagedUpgradeCancellation(input);
    if (parsed.mode === "dry-run") return Object.freeze({ command: parsed.command, mode: parsed.mode,
      installId: reviewed.journal.installId, productVersion: reviewed.journal.fromVersion,
      abandonedVersion: reviewed.journal.toVersion, phase: reviewed.journal.phase,
      services: reviewed.journal.resumeServices, checkpoint: reviewed.journal, payload: { action: "preserve" } });
    const services = new PackagedPlatformServiceController({ blueprint: reviewed.blueprint,
      shutdownService: async () => { throw new Error("upgrade cancellation must not shut down a service"); },
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.userId === undefined ? {} : { userId: options.userId }) });
    const result = await cancelSignedPackagedUpgrade({ ...input, services });
    return Object.freeze({ command: parsed.command, mode: parsed.mode, productVersion: reviewed.journal.fromVersion, ...result });
  }

  if (parsed.command === "install") {
    const planned = await planSignedPackagedInstallFromPayload({
      payloadSourcePath,
      trustedKeys: keys,
      ...environment,
    });
    if (parsed.mode === "dry-run") {
      return Object.freeze({
        command: parsed.command,
        mode: parsed.mode,
        productVersion: planned.plan.productVersion,
        installId: planned.plan.installId,
        plan: planned.plan,
      });
    }
    const result = await applySignedPackagedInstallFromPayload({
      planned,
      payloadSourcePath,
      trustedKeys: keys,
      ...environment,
    });
    return Object.freeze({
      command: parsed.command,
      mode: parsed.mode,
      productVersion: result.manifest.productVersion,
      installId: result.manifest.installId,
      apply: result.apply,
      verify: result.verify,
    });
  }

  if (parsed.command === "repair") {
    const plan = await planSignedPackagedRepairFromPayload({
      payloadSourcePath,
      trustedKeys: keys,
      ...environment,
    });
    if (parsed.mode === "dry-run") {
      return Object.freeze({
        command: parsed.command,
        mode: parsed.mode,
        productVersion: plan.productVersion,
        installId: plan.installId,
        payload: plan.payload,
        services: plan.services,
      });
    }
    const shutdown = ownedServiceShutdown(plan.installId, plan.blueprint.paths);
    const services = new PackagedPlatformServiceController({
      blueprint: plan.blueprint,
      shutdownService: options.shutdownService ?? shutdown,
      prepareShutdownService: options.prepareShutdownService ?? (options.shutdownService ? undefined : shutdown.prepare),
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.userId === undefined ? {} : { userId: options.userId }),
    });
    const result = await applySignedPackagedRepairFromPayload({
      plan,
      payloadSourcePath,
      trustedKeys: keys,
      services,
      ...environment,
    });
    return Object.freeze({ command: parsed.command, mode: parsed.mode, ...result });
  }

  const plan = await planSignedPackagedUpgradeFromPayload({
    payloadSourcePath,
    trustedKeys: keys,
    ...environment,
  });
  const recovery = parsed.recoveryPayloadPath ? {
    sourcePayloadPath: realDirectory(parsed.recoveryPayloadPath, "signed recovery payload"),
    // These are explicitly out-of-band caller keys, never untrusted cached
    // recovery-slot keys. The existing recovery journal verifies every older
    // slot against the caller's corresponding key before retirement.
    trustedKeys: (() => {
      const sourceKeys = trustedKeys(parsed.recoveryPayloadPath!, parsed.recoveryPublicKeyPath!);
      for (const item of parsed.retainedRecoveryKeys) {
        if (Object.hasOwn(sourceKeys, item.keyId)) throw Error("retained key duplicates current recovery source authority");
      }
      return {
        ...sourceKeys,
        ...Object.fromEntries(parsed.retainedRecoveryKeys.map(({ keyId, path }) =>
          [keyId, readFileSync(realRegularFile(path, "trusted historical recovery public key"))])),
      } satisfies PackagedPayloadTrustedKeys;
    })(),
  } : undefined;
  if (recovery) assertPackagedUpgradeRecoveryArtifact(plan, recovery);
  const recoveryKeys = recovery?.trustedKeys ?? keys;
  const recoveryReview = reviewPackagedRecoveryArtifact(plan, recoveryKeys, recovery);
  if (parsed.mode === "dry-run") {
    return Object.freeze({
      command: parsed.command,
      mode: parsed.mode,
      installId: plan.installId,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      recoveryVerified: true,
      recoverySource: recoveryReview.origin,
      payload: Object.freeze({ action: "replace" as const }),
      services: Object.freeze(plan.targetBlueprint.services.map(service => Object.freeze({
        service: service.service,
        action: "preserve-registration" as const,
      }))),
    });
  }
  const shutdown = ownedServiceShutdown(plan.installId, plan.targetBlueprint.paths);
  const services = new PackagedPlatformServiceController({
    blueprint: plan.targetBlueprint,
    shutdownService: options.shutdownService ?? shutdown,
    prepareShutdownService: options.prepareShutdownService ?? (options.shutdownService ? undefined : shutdown.prepare),
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.userId === undefined ? {} : { userId: options.userId }),
  });
  const upgradeInput = {
    plan,
    payloadSourcePath,
    trustedKeys: keys,
    services,
    ...environment,
  };
  const result = await applySignedPackagedUpgradeWithRecovery({ ...upgradeInput, ...(recovery ? { recovery } : {}) });
  return Object.freeze({ command: parsed.command, mode: parsed.mode, ...result });
}
