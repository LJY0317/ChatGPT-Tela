import { ownedServiceShutdown } from "./service-shutdown";
import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  resolveProductPaths,
  cancelPackagedUpgrade,
  PackagedServiceShutdownNotStartedError,
  packagedRepairJournalPath,
  packagedUpgradeJournalPath,
  planPackagedUpgradeCancellation,
  applyPackagedInstallFromPayload,
  applyPackagedRepairFromPayload,
  applyPackagedUpgradeWithRecovery,
  reviewPackagedRecoveryArtifact,
  PackagedPlatformServiceController,
  readPackagedRepairJournal,
  readPackagedUpgradeJournal,
  planPackagedInstallFromPayload,
  planPackagedRepairFromPayload,
  planPackagedUpgradeFromPayload,
  type ServiceRegistrationCommandRunner,
  type TelaServiceId,
} from "@chatgpt-tela/product-lifecycle";
import { payloadRootForLauncherExecutable } from "./runtime";

export type PackagedLifecycleCommand = "install" | "repair" | "upgrade" | "cancel-upgrade";
export type PackagedLifecycleMode = "dry-run" | "apply";

export interface ParsedPackagedLifecycleCommand {
  readonly command: PackagedLifecycleCommand;
  readonly mode: PackagedLifecycleMode;
  readonly payloadSourcePath?: string;
}

export interface PackagedLifecycleOptions {
  readonly defaultPayloadRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
  readonly userId?: number;
  readonly shutdownService?: (service: TelaServiceId) => Promise<void>;
  readonly waitUntilReady?: (service: TelaServiceId, timeoutMs: number) => Promise<void>;
  readonly prepareShutdownService?: (service: TelaServiceId) => Promise<void>;
}

type ShutdownBlueprint = ConstructorParameters<typeof PackagedPlatformServiceController>[0]["blueprint"]
  & { readonly paths: ReturnType<typeof resolveProductPaths> };

function serviceController(installId: string, blueprint: ShutdownBlueprint, options: PackagedLifecycleOptions) {
  const shutdown = ownedServiceShutdown(installId, blueprint.paths);
  return new PackagedPlatformServiceController({
    blueprint,
    shutdownService: options.shutdownService ?? shutdown,
    prepareShutdownService: options.prepareShutdownService ?? (options.shutdownService ? undefined : shutdown.prepare),
    waitUntilReady: options.waitUntilReady ?? (options.shutdownService ? undefined : shutdown.ready),
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.userId === undefined ? {} : { userId: options.userId }),
  });
}

async function shutdownBlockers(installId: string, blueprint: ShutdownBlueprint, options: PackagedLifecycleOptions): Promise<readonly string[]> {
  // Injected shutdown handlers own their own admission contract; don't claim a
  // live readiness observation when that contract was not supplied.
  if (options.shutdownService && !options.prepareShutdownService) return Object.freeze([]);
  try {
    await serviceController(installId, blueprint, options).prepare(blueprint.services.map(({ service }) => service));
    return Object.freeze([]);
  } catch (error) {
    if (error instanceof PackagedServiceShutdownNotStartedError) return Object.freeze([error.message]);
    return Object.freeze(["A running service could not confirm that it is safe to stop. Check its status and try again."]);
  }
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
  let payloadSourcePath: string | undefined;
  for (let index = 1; index < arguments_.length; index++) {
    const option = arguments_[index];
    if (option === "--dry-run" || option === "--apply") {
      if (mode) throw new Error("choose exactly one of --dry-run or --apply");
      mode = option === "--apply" ? "apply" : "dry-run";
    } else if (option === "--payload") {
      if (payloadSourcePath) throw new Error("--payload may be specified only once");
      payloadSourcePath = oneValue(arguments_, index++, option);
    } else throw new Error(`unknown lifecycle option: ${option}`);
  }
  if (!mode) throw new Error("choose exactly one of --dry-run or --apply");
  if (command === "cancel-upgrade" && !payloadSourcePath) throw new Error("cancel-upgrade requires --payload for the retained source package");
  return Object.freeze({ command, mode, ...(payloadSourcePath ? { payloadSourcePath } : {}) });
}

function realDirectory(path: string, field: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${field} is missing: ${absolute}`);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${field} must be a real directory`);
  return realpathSync(absolute);
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
  const environment = lifecycleEnvironment(options);

  if (parsed.command === "cancel-upgrade") {
    const input = { sourcePayloadPath: payloadSourcePath, ...environment };
    const reviewed = await planPackagedUpgradeCancellation(input);
    if (parsed.mode === "dry-run") return Object.freeze({ command: parsed.command, mode: parsed.mode,
      installId: reviewed.journal.installId, productVersion: reviewed.journal.fromVersion,
      abandonedVersion: reviewed.journal.toVersion, phase: reviewed.journal.phase,
      services: reviewed.journal.resumeServices, checkpoint: reviewed.journal, payload: { action: "preserve" } });
    const services = new PackagedPlatformServiceController({ blueprint: reviewed.blueprint,
      shutdownService: async () => { throw new Error("upgrade cancellation must not shut down a service"); },
      waitUntilReady: options.waitUntilReady ?? (options.runner ? undefined : ownedServiceShutdown(reviewed.journal.installId, resolveProductPaths(environment)).ready),
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.userId === undefined ? {} : { userId: options.userId }) });
    const result = await cancelPackagedUpgrade({ ...input, services });
    return Object.freeze({ command: parsed.command, mode: parsed.mode, productVersion: reviewed.journal.fromVersion, ...result });
  }

  if (parsed.command === "install") {
    const planned = await planPackagedInstallFromPayload({
      payloadSourcePath,
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
    const result = await applyPackagedInstallFromPayload({
      planned,
      payloadSourcePath,
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
    const plan = await planPackagedRepairFromPayload({
      payloadSourcePath,
      ...environment,
    });
    if (parsed.mode === "dry-run") {
      const journal = readPackagedRepairJournal(packagedRepairJournalPath(plan.blueprint.paths));
      const blockers = !journal && plan.payload.action === "repair" && !plan.services.some(service => service.action === "preserve")
        ? await shutdownBlockers(plan.installId, plan.blueprint, options) : Object.freeze([]);
      return Object.freeze({
        command: parsed.command,
        mode: parsed.mode,
        productVersion: plan.productVersion,
        installId: plan.installId,
        payload: plan.payload,
        services: plan.services,
        shutdownBlockers: blockers,
      });
    }
    const services = serviceController(plan.installId, plan.blueprint, options);
    const result = await applyPackagedRepairFromPayload({
      plan,
      payloadSourcePath,
      services,
      ...environment,
    });
    return Object.freeze({ command: parsed.command, mode: parsed.mode, ...result });
  }

  const plan = await planPackagedUpgradeFromPayload({
    payloadSourcePath,
    ...environment,
  });
  const recoveryReview = reviewPackagedRecoveryArtifact(plan);
  if (parsed.mode === "dry-run") {
    const journal = readPackagedUpgradeJournal(packagedUpgradeJournalPath(plan.targetBlueprint.paths));
    const blockers = journal ? Object.freeze([]) : await shutdownBlockers(plan.installId, plan.targetBlueprint, options);
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
      shutdownBlockers: blockers,
    });
  }
  const services = serviceController(plan.installId, plan.targetBlueprint, options);
  const upgradeInput = {
    plan,
    payloadSourcePath,
    services,
    ...environment,
  };
  const result = await applyPackagedUpgradeWithRecovery(upgradeInput);
  return Object.freeze({ command: parsed.command, mode: parsed.mode, ...result });
}
