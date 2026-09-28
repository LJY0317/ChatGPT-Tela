import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  applySignedPackagedInstallFromPayload,
  applySignedPackagedRepairFromPayload,
  applySignedPackagedUpgradeFromPayload,
  PackagedPlatformServiceController,
  planSignedPackagedInstallFromPayload,
  planSignedPackagedRepairFromPayload,
  planSignedPackagedUpgradeFromPayload,
  readPackagedPayloadSignature,
  type PackagedPayloadTrustedKeys,
  type ServiceRegistrationCommandRunner,
} from "@chatgpt-tela/product-lifecycle";
import { payloadRootForLauncherExecutable } from "./runtime";

export type PackagedLifecycleCommand = "install" | "repair" | "upgrade";
export type PackagedLifecycleMode = "dry-run" | "apply";

export interface ParsedPackagedLifecycleCommand {
  readonly command: PackagedLifecycleCommand;
  readonly mode: PackagedLifecycleMode;
  readonly trustedPublicKeyPath: string;
  readonly payloadSourcePath?: string;
}

export interface PackagedLifecycleOptions {
  readonly defaultPayloadRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
  readonly userId?: number;
}

function oneValue(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parsePackagedLifecycleCommand(arguments_: readonly string[]): ParsedPackagedLifecycleCommand {
  const command = arguments_[0];
  if (!(command === "install" || command === "repair" || command === "upgrade")) {
    throw new Error("packaged lifecycle command must be install, repair, or upgrade");
  }
  let mode: PackagedLifecycleMode | undefined;
  let trustedPublicKeyPath: string | undefined;
  let payloadSourcePath: string | undefined;
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
    throw new Error(`unknown packaged lifecycle argument: ${item}`);
  }
  if (!mode) throw new Error("choose exactly one of --dry-run or --apply");
  if (!trustedPublicKeyPath) throw new Error("--trusted-public-key is required");
  return Object.freeze({
    command,
    mode,
    trustedPublicKeyPath,
    ...(payloadSourcePath ? { payloadSourcePath } : {}),
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
    const services = new PackagedPlatformServiceController({
      blueprint: plan.blueprint,
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
  if (parsed.mode === "dry-run") {
    return Object.freeze({
      command: parsed.command,
      mode: parsed.mode,
      installId: plan.installId,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      payload: Object.freeze({ action: "replace" as const }),
      services: Object.freeze(plan.targetBlueprint.services.map(service => Object.freeze({
        service: service.service,
        action: "preserve-registration" as const,
      }))),
    });
  }
  const services = new PackagedPlatformServiceController({
    blueprint: plan.targetBlueprint,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.userId === undefined ? {} : { userId: options.userId }),
  });
  const result = await applySignedPackagedUpgradeFromPayload({
    plan,
    payloadSourcePath,
    trustedKeys: keys,
    services,
    ...environment,
  });
  return Object.freeze({ command: parsed.command, mode: parsed.mode, ...result });
}
