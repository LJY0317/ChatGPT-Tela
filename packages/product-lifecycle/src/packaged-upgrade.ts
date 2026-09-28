import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createPackagedInstallBlueprint, type PackagedInstallBlueprint } from "./packaged-install";
import { packagedInstallSpecFromPayload } from "./packaged-manifest";
import {
  beginPackagedPayloadReplacement,
  observeInstalledPackagedPayload,
  PackagedPayloadManager,
  type PackagedPayloadReceipt,
} from "./packaged-payload";
import { mutateOwnershipManifest } from "./ownership-store";
import { readOwnershipManifest, type OwnershipManifest } from "./ownership";
import { ServiceRegistrationInstaller, SystemServiceRegistrationCommandRunner, type ServiceRegistrationCommandRunner } from "./service-registration";
import type { TelaServiceId } from "./layout";
import { verifyPackagedPayloadSignature, type PackagedPayloadTrustedKeys } from "./packaged-signature";
import { assertNoConflictingPackagedTransition, packagedUpgradeJournalPath } from "./packaged-transition";

const QUIESCE_ORDER = Object.freeze(["gateway", "codex", "chat"] as const);
const RESUME_ORDER = Object.freeze(["chat", "codex", "gateway"] as const);

export interface PackagedUpgradeServiceController {
  inspect(service: TelaServiceId): Promise<"running" | "stopped">;
  quiesce(service: TelaServiceId): Promise<void>;
  resume(service: TelaServiceId): Promise<void>;
}

export interface PackagedUpgradePlan {
  readonly installId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly sourcePayload: PackagedPayloadReceipt;
  readonly targetPayloadFingerprint: string;
  readonly targetBlueprint: PackagedInstallBlueprint;
}

export type PackagedUpgradePhase =
  | "prepared"
  | "quiescing"
  | "quiesced"
  | "payload-replacing"
  | "payload-installed"
  | "manifest-updated";

export interface PackagedUpgradeJournal {
  readonly version: 1;
  readonly installId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly sourcePayloadFingerprint: string;
  readonly targetPayloadFingerprint: string;
  readonly phase: PackagedUpgradePhase;
  readonly resumeServices: readonly TelaServiceId[];
  readonly quiescedServices: readonly TelaServiceId[];
  readonly resumedServices: readonly TelaServiceId[];
}

function serviceId(value: unknown, field: string): TelaServiceId {
  if (!(value === "gateway" || value === "chat" || value === "codex")) throw new Error(`${field} is invalid`);
  return value;
}

function services(value: unknown, field: string): readonly TelaServiceId[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const result = value.map((entry, index) => serviceId(entry, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${field} contains duplicates`);
  return Object.freeze(result);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function fingerprint(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${field} is invalid`);
  return result;
}

function parseJournal(value: unknown): PackagedUpgradeJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("packaged upgrade journal is invalid");
  const item = value as Record<string, unknown>;
  const phases: readonly PackagedUpgradePhase[] = ["prepared", "quiescing", "quiesced", "payload-replacing", "payload-installed", "manifest-updated"];
  if (item.version !== 1 || !phases.includes(item.phase as PackagedUpgradePhase)) throw new Error("packaged upgrade journal version/phase is unsupported");
  return Object.freeze({
    version: 1,
    installId: text(item.installId, "upgrade install id"),
    fromVersion: text(item.fromVersion, "upgrade from version"),
    toVersion: text(item.toVersion, "upgrade to version"),
    sourcePayloadFingerprint: fingerprint(item.sourcePayloadFingerprint, "upgrade source payload fingerprint"),
    targetPayloadFingerprint: fingerprint(item.targetPayloadFingerprint, "upgrade target payload fingerprint"),
    phase: item.phase as PackagedUpgradePhase,
    resumeServices: services(item.resumeServices, "upgrade resume services"),
    quiescedServices: services(item.quiescedServices, "upgrade quiesced services"),
    resumedServices: services(item.resumedServices, "upgrade resumed services"),
  });
}

export function readPackagedUpgradeJournal(path: string): PackagedUpgradeJournal | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("packaged upgrade journal path is unsafe or replaced");
  return parseJournal(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function writeJournal(path: string, journal: PackagedUpgradeJournal): void {
  const normalized = parseJournal(journal);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
}

function sameUpgrade(journal: PackagedUpgradeJournal, plan: PackagedUpgradePlan): boolean {
  return journal.installId === plan.installId
    && journal.fromVersion === plan.fromVersion
    && journal.toVersion === plan.toVersion
    && journal.sourcePayloadFingerprint === plan.sourcePayload.payloadFingerprint
    && journal.targetPayloadFingerprint === plan.targetPayloadFingerprint;
}

function updateJournal(path: string, current: PackagedUpgradeJournal, changes: Partial<Pick<PackagedUpgradeJournal,
  "phase" | "resumeServices" | "quiescedServices" | "resumedServices">>): PackagedUpgradeJournal {
  const next = parseJournal({ ...current, ...changes });
  writeJournal(path, next);
  return next;
}

function exactResource(manifest: OwnershipManifest, resourceId: string, expected: unknown): boolean {
  const current = manifest.resources.find(resource => resource.id === resourceId);
  return current !== undefined && JSON.stringify(current) === JSON.stringify(expected);
}

function assertStableServiceDefinitions(manifest: OwnershipManifest, blueprint: PackagedInstallBlueprint): void {
  for (const service of blueprint.services) {
    if (!exactResource(manifest, service.resource.id, service.resource)) {
      throw new Error(`packaged upgrade requires stable service registration identity for ${service.service}`);
    }
  }
}

async function assertStableServiceRegistrations(input: {
  readonly manifest: OwnershipManifest;
  readonly blueprint: PackagedInstallBlueprint;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<void> {
  const installer = new ServiceRegistrationInstaller({
    platform: input.blueprint.platform,
    runner: input.runner ?? new SystemServiceRegistrationCommandRunner(),
  });
  for (const service of input.blueprint.services) {
    const state = await installer.observeReady(service.resource, input.manifest);
    if (state !== "owned") throw new Error(`packaged upgrade service registration is not exact-owned: ${service.service} (${state})`);
  }
}

export async function planPackagedUpgradeFromPayload(input: {
  readonly payloadSourcePath: string;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<PackagedUpgradePlan> {
  const spec = packagedInstallSpecFromPayload(input.payloadSourcePath);
  const blueprint = createPackagedInstallBlueprint({
    spec,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.home ? { home: input.home } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
  });
  assertNoConflictingPackagedTransition(blueprint.paths, "upgrade");
  const manifest = readOwnershipManifest(blueprint.paths.installManifest);
  if (!manifest) throw new Error("packaged upgrade requires an existing owned install manifest");
  const journal = readPackagedUpgradeJournal(packagedUpgradeJournalPath(blueprint.paths));
  if (journal) {
    if (journal.installId !== manifest.installId
      || journal.toVersion !== spec.productVersion
      || journal.targetPayloadFingerprint !== blueprint.payloadFingerprint) {
      throw new Error("a different packaged upgrade journal already owns this install");
    }
    if (manifest.productVersion !== journal.fromVersion && manifest.productVersion !== journal.toVersion) {
      throw new Error("packaged upgrade manifest version changed outside the active transition");
    }
    assertStableServiceDefinitions(manifest, blueprint);
    await assertStableServiceRegistrations({
      manifest,
      blueprint,
      ...(input.runner ? { runner: input.runner } : {}),
    });
    return Object.freeze({
      installId: journal.installId,
      fromVersion: journal.fromVersion,
      toVersion: journal.toVersion,
      sourcePayload: Object.freeze({
        version: 1 as const,
        installId: journal.installId,
        resourceId: blueprint.payload.resource.id,
        productVersion: journal.fromVersion,
        payloadFingerprint: journal.sourcePayloadFingerprint,
      }),
      targetPayloadFingerprint: journal.targetPayloadFingerprint,
      targetBlueprint: blueprint,
    });
  }
  if (manifest.productVersion === spec.productVersion) throw new Error("target package version already matches the installed version; use repair instead of upgrade");
  if (!exactResource(manifest, blueprint.payload.resource.id, blueprint.payload.resource)) {
    throw new Error("packaged upgrade binary resource identity does not match the installed manifest");
  }
  const installed = observeInstalledPackagedPayload(blueprint.payload.resource, manifest);
  if (installed.state !== "owned" || installed.receipt.productVersion !== manifest.productVersion) {
    throw new Error("installed packaged payload cannot be proven exact for the current product version");
  }
  assertStableServiceDefinitions(manifest, blueprint);
  await assertStableServiceRegistrations({ manifest, blueprint, ...(input.runner ? { runner: input.runner } : {}) });
  return Object.freeze({
    installId: manifest.installId,
    fromVersion: manifest.productVersion,
    toVersion: spec.productVersion,
    sourcePayload: installed.receipt,
    targetPayloadFingerprint: blueprint.payloadFingerprint,
    targetBlueprint: blueprint,
  });
}

export { packagedUpgradeJournalPath } from "./packaged-transition";

function initialJournal(plan: PackagedUpgradePlan): PackagedUpgradeJournal {
  return Object.freeze({
    version: 1,
    installId: plan.installId,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    sourcePayloadFingerprint: plan.sourcePayload.payloadFingerprint,
    targetPayloadFingerprint: plan.targetPayloadFingerprint,
    phase: "prepared",
    resumeServices: Object.freeze([]),
    quiescedServices: Object.freeze([]),
    resumedServices: Object.freeze([]),
  });
}

export async function applyPackagedUpgradeFromPayload(input: {
  readonly plan: PackagedUpgradePlan;
  readonly payloadSourcePath: string;
  readonly services: PackagedUpgradeServiceController;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<{ readonly fromVersion: string; readonly toVersion: string; readonly resumedServices: readonly TelaServiceId[] }> {
  const spec = packagedInstallSpecFromPayload(input.payloadSourcePath);
  const blueprint = createPackagedInstallBlueprint({
    spec,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.home ? { home: input.home } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
  });
  assertNoConflictingPackagedTransition(blueprint.paths, "upgrade");
  if (blueprint.payloadFingerprint !== input.plan.targetPayloadFingerprint
    || spec.productVersion !== input.plan.toVersion
    || JSON.stringify(blueprint.desiredResources) !== JSON.stringify(input.plan.targetBlueprint.desiredResources)) {
    throw new Error("packaged upgrade target changed after planning");
  }
  const manifestPath = blueprint.paths.installManifest;
  let manifest = readOwnershipManifest(manifestPath);
  if (!manifest || manifest.installId !== input.plan.installId) throw new Error("packaged upgrade install identity changed after planning");
  if (manifest.productVersion !== input.plan.fromVersion && manifest.productVersion !== input.plan.toVersion) {
    throw new Error("packaged upgrade manifest version changed outside the planned transition");
  }
  assertStableServiceDefinitions(manifest, blueprint);

  const journalPath = packagedUpgradeJournalPath(blueprint.paths);
  let journal = readPackagedUpgradeJournal(journalPath);
  if (journal && !sameUpgrade(journal, input.plan)) throw new Error("a different packaged upgrade journal already owns this install");
  if (!journal) {
    if (manifest.productVersion !== input.plan.fromVersion) throw new Error("upgrade journal is missing after product version already changed");
    journal = initialJournal(input.plan);
    writeJournal(journalPath, journal);
  }

  if (journal.phase === "prepared") {
    const resume: TelaServiceId[] = [];
    for (const service of QUIESCE_ORDER) {
      if (await input.services.inspect(service) === "running") resume.push(service);
    }
    journal = updateJournal(journalPath, journal, { phase: "quiescing", resumeServices: Object.freeze(resume) });
  }

  if (journal.phase === "quiescing") {
    const quiesced = [...journal.quiescedServices];
    for (const service of QUIESCE_ORDER) {
      if (quiesced.includes(service)) continue;
      await input.services.quiesce(service);
      quiesced.push(service);
      journal = updateJournal(journalPath, journal, { quiescedServices: Object.freeze([...quiesced]) });
    }
    journal = updateJournal(journalPath, journal, { phase: "quiesced" });
  }

  if (journal.phase === "quiesced" || journal.phase === "payload-replacing") {
    for (const service of QUIESCE_ORDER) {
      if (await input.services.inspect(service) !== "stopped") {
        throw new Error(`packaged upgrade lost quiescence before binary replacement: ${service}`);
      }
    }
    const target = new PackagedPayloadManager({ manifestPath, installId: manifest.installId, spec: blueprint.payload });
    const targetState = target.observe(manifest);
    if (targetState !== "owned") {
      const installed = observeInstalledPackagedPayload(blueprint.payload.resource, manifest);
      if (journal.phase === "quiesced") {
        if (installed.state !== "owned" || JSON.stringify(installed.receipt) !== JSON.stringify(input.plan.sourcePayload)) {
          throw new Error("packaged upgrade source payload drifted before replacement");
        }
        journal = updateJournal(journalPath, journal, { phase: "payload-replacing" });
        beginPackagedPayloadReplacement({ resource: blueprint.payload.resource, manifest, expected: input.plan.sourcePayload });
      } else if (installed.state === "owned" && JSON.stringify(installed.receipt) === JSON.stringify(input.plan.sourcePayload)) {
        beginPackagedPayloadReplacement({ resource: blueprint.payload.resource, manifest, expected: input.plan.sourcePayload });
      } else if (installed.state !== "missing") {
        throw new Error("packaged upgrade payload replacement state is ambiguous");
      }
      await target.install(manifest);
    }
    journal = updateJournal(journalPath, journal, { phase: "payload-installed" });
  }

  if (journal.phase === "payload-installed") {
    const target = new PackagedPayloadManager({ manifestPath, installId: manifest.installId, spec: blueprint.payload });
    if (target.observe(manifest) !== "owned") throw new Error("upgraded payload is not exact before manifest version commit");
    const installer = new ServiceRegistrationInstaller({
      platform: blueprint.platform,
      runner: input.runner ?? new SystemServiceRegistrationCommandRunner(),
    });
    for (const service of blueprint.services) {
      if (await installer.observeReady(service.resource, manifest) !== "owned") {
        throw new Error(`service registration drifted during packaged upgrade: ${service.service}`);
      }
    }
    manifest = await mutateOwnershipManifest({
      path: manifestPath,
      installId: manifest.installId,
      productVersion: input.plan.toVersion,
      mutate(current) {
        if (current.productVersion !== input.plan.fromVersion) {
          if (current.productVersion === input.plan.toVersion) return current;
          throw new Error("manifest version changed during packaged upgrade");
        }
        return Object.freeze({ ...current, productVersion: input.plan.toVersion, updatedAt: new Date().toISOString() });
      },
    });
    journal = updateJournal(journalPath, journal, { phase: "manifest-updated" });
  }

  if (journal.phase === "manifest-updated") {
    manifest = readOwnershipManifest(manifestPath)!;
    if (manifest.productVersion !== input.plan.toVersion) throw new Error("packaged upgrade manifest commit did not persist");
    const target = new PackagedPayloadManager({ manifestPath, installId: manifest.installId, spec: blueprint.payload });
    if (target.observe(manifest) !== "owned") throw new Error("packaged upgrade target payload failed final verification");
    const installer = new ServiceRegistrationInstaller({
      platform: blueprint.platform,
      runner: input.runner ?? new SystemServiceRegistrationCommandRunner(),
    });
    for (const service of blueprint.services) {
      if (await installer.observeReady(service.resource, manifest) !== "owned") {
        throw new Error(`packaged upgrade service registration failed final verification: ${service.service}`);
      }
    }
    const resumed = [...journal.resumedServices];
    for (const service of RESUME_ORDER) {
      if (!journal.resumeServices.includes(service) || resumed.includes(service)) continue;
      await input.services.resume(service);
      resumed.push(service);
      journal = updateJournal(journalPath, journal, { resumedServices: Object.freeze([...resumed]) });
    }
  }

  rmSync(journalPath, { force: false });
  return Object.freeze({
    fromVersion: input.plan.fromVersion,
    toVersion: input.plan.toVersion,
    resumedServices: Object.freeze([...journal.resumedServices]),
  });
}

export async function planSignedPackagedUpgradeFromPayload(input: {
  readonly payloadSourcePath: string;
  readonly trustedKeys: PackagedPayloadTrustedKeys;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<PackagedUpgradePlan> {
  verifyPackagedPayloadSignature({ payloadRoot: input.payloadSourcePath, trustedKeys: input.trustedKeys });
  return planPackagedUpgradeFromPayload(input);
}

export async function applySignedPackagedUpgradeFromPayload(input: {
  readonly plan: PackagedUpgradePlan;
  readonly payloadSourcePath: string;
  readonly trustedKeys: PackagedPayloadTrustedKeys;
  readonly services: PackagedUpgradeServiceController;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): ReturnType<typeof applyPackagedUpgradeFromPayload> {
  verifyPackagedPayloadSignature({ payloadRoot: input.payloadSourcePath, trustedKeys: input.trustedKeys });
  return applyPackagedUpgradeFromPayload(input);
}
