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
import { dirname } from "node:path";
import {
  createPackagedInstallBlueprint,
  type PackagedInstallBlueprint,
} from "./packaged-install";
import { packagedInstallSpecFromPayload } from "./packaged-manifest";
import {
  PackagedPayloadManager,
  type PackagedPayloadRepairObservation,
} from "./packaged-payload";
import { readOwnershipManifest, type OwnershipManifest } from "./ownership";
import {
  ServiceRegistrationInstaller,
  SystemServiceRegistrationCommandRunner,
  type ServiceRegistrationCommandRunner,
} from "./service-registration";
import type { TelaServiceId } from "./layout";
import type { OwnershipObservation } from "./uninstall";
import {
  assertNoConflictingPackagedTransition,
  packagedRepairJournalPath,
} from "./packaged-transition";
import {
  verifyPackagedPayloadSignature,
  type PackagedPayloadTrustedKeys,
} from "./packaged-signature";

const QUIESCE_ORDER = Object.freeze(["gateway", "codex", "chat"] as const);
const RESUME_ORDER = Object.freeze(["chat", "codex", "gateway"] as const);

export interface PackagedRepairServiceController {
  inspect(service: TelaServiceId): Promise<"running" | "stopped">;
  quiesce(service: TelaServiceId): Promise<void>;
  resume(service: TelaServiceId): Promise<void>;
}

export type PackagedRepairAction = "keep" | "repair" | "preserve";

export interface PackagedRepairResourcePlan {
  readonly resourceId: string;
  readonly action: PackagedRepairAction;
  readonly observation: OwnershipObservation | "repairable";
  readonly reason: string;
}

export interface PackagedRepairServicePlan extends PackagedRepairResourcePlan {
  readonly service: TelaServiceId;
}

export interface PackagedRepairPlan {
  readonly installId: string;
  readonly productVersion: string;
  readonly targetPayloadFingerprint: string;
  readonly blueprint: PackagedInstallBlueprint;
  readonly payload: PackagedRepairResourcePlan;
  readonly services: readonly PackagedRepairServicePlan[];
}

export type PackagedRepairPhase = "prepared" | "quiescing" | "quiesced" | "repairing" | "repaired";

export interface PackagedRepairJournal {
  readonly version: 1;
  readonly installId: string;
  readonly productVersion: string;
  readonly targetPayloadFingerprint: string;
  readonly phase: PackagedRepairPhase;
  readonly controlledServices: readonly TelaServiceId[];
  readonly repairServices: readonly TelaServiceId[];
  readonly resumeServices: readonly TelaServiceId[];
  readonly quiescedServices: readonly TelaServiceId[];
  readonly repairedResources: readonly string[];
  readonly resumedServices: readonly TelaServiceId[];
}

export interface PackagedRepairResult {
  readonly productVersion: string;
  readonly payload: "kept" | "repaired" | "preserved";
  readonly services: readonly {
    readonly service: TelaServiceId;
    readonly outcome: "kept" | "repaired" | "preserved";
  }[];
  readonly resumedServices: readonly TelaServiceId[];
}

function exactResource(manifest: OwnershipManifest, resourceId: string, expected: unknown): boolean {
  const current = manifest.resources.find(resource => resource.id === resourceId);
  return current !== undefined && JSON.stringify(current) === JSON.stringify(expected);
}

function repairAction(observation: OwnershipObservation | "repairable"): PackagedRepairAction {
  if (observation === "owned") return "keep";
  if (observation === "missing" || observation === "repairable") return "repair";
  return "preserve";
}

function repairReason(observation: OwnershipObservation | "repairable"): string {
  if (observation === "owned") return "exact owned state is healthy";
  if (observation === "missing") return "exact ownership exists but the installed resource is incomplete or absent";
  if (observation === "repairable") return "exact install marker and receipt prove product-owned payload byte drift";
  if (observation === "ownership-drift") return "ownership identity drifted";
  if (observation === "unsafe") return "resource structure is unsafe or replaced";
  if (observation === "dirty") return "resource contains user-significant state";
  return "resource state cannot be proven";
}

function resourcePlan(
  resourceId: string,
  observation: OwnershipObservation | "repairable",
): PackagedRepairResourcePlan {
  return Object.freeze({
    resourceId,
    action: repairAction(observation),
    observation,
    reason: repairReason(observation),
  });
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

function serviceId(value: unknown, field: string): TelaServiceId {
  if (!(value === "gateway" || value === "chat" || value === "codex")) throw new Error(`${field} is invalid`);
  return value;
}

function serviceList(value: unknown, field: string): readonly TelaServiceId[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const result = value.map((entry, index) => serviceId(entry, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${field} contains duplicates`);
  return Object.freeze(result);
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const result = value.map((entry, index) => text(entry, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${field} contains duplicates`);
  return Object.freeze(result);
}

function parseJournal(value: unknown): PackagedRepairJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("packaged repair journal is invalid");
  const item = value as Record<string, unknown>;
  const phases: readonly PackagedRepairPhase[] = ["prepared", "quiescing", "quiesced", "repairing", "repaired"];
  if (item.version !== 1 || !phases.includes(item.phase as PackagedRepairPhase)) {
    throw new Error("packaged repair journal version/phase is unsupported");
  }
  return Object.freeze({
    version: 1,
    installId: text(item.installId, "repair install id"),
    productVersion: text(item.productVersion, "repair product version"),
    targetPayloadFingerprint: fingerprint(item.targetPayloadFingerprint, "repair target payload fingerprint"),
    phase: item.phase as PackagedRepairPhase,
    controlledServices: serviceList(item.controlledServices, "repair controlled services"),
    repairServices: serviceList(item.repairServices, "repair services"),
    resumeServices: serviceList(item.resumeServices, "repair resume services"),
    quiescedServices: serviceList(item.quiescedServices, "repair quiesced services"),
    repairedResources: stringList(item.repairedResources, "repair repaired resources"),
    resumedServices: serviceList(item.resumedServices, "repair resumed services"),
  });
}

export function readPackagedRepairJournal(path: string): PackagedRepairJournal | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("packaged repair journal path is unsafe or replaced");
  return parseJournal(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function writeJournal(path: string, journal: PackagedRepairJournal): void {
  const normalized = parseJournal(journal);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
}

function updateJournal(
  path: string,
  current: PackagedRepairJournal,
  changes: Partial<Pick<PackagedRepairJournal,
    "phase" | "quiescedServices" | "repairedResources" | "resumedServices">>,
): PackagedRepairJournal {
  const next = parseJournal({ ...current, ...changes });
  writeJournal(path, next);
  return next;
}

function sameRepair(journal: PackagedRepairJournal, plan: PackagedRepairPlan): boolean {
  return journal.installId === plan.installId
    && journal.productVersion === plan.productVersion
    && journal.targetPayloadFingerprint === plan.targetPayloadFingerprint;
}

export async function planPackagedRepairFromPayload(input: {
  readonly payloadSourcePath: string;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<PackagedRepairPlan> {
  const spec = packagedInstallSpecFromPayload(input.payloadSourcePath);
  const blueprint = createPackagedInstallBlueprint({
    spec,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.home ? { home: input.home } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
  });
  assertNoConflictingPackagedTransition(blueprint.paths, "repair");
  const manifest = readOwnershipManifest(blueprint.paths.installManifest);
  if (!manifest) throw new Error("packaged repair requires an existing owned install manifest");
  if (manifest.productVersion !== spec.productVersion) {
    throw new Error("packaged repair requires the exact installed product version; use upgrade for a different version");
  }

  const payloadManager = new PackagedPayloadManager({
    manifestPath: blueprint.paths.installManifest,
    installId: manifest.installId,
    spec: blueprint.payload,
  });
  const payloadObservation: PackagedPayloadRepairObservation = exactResource(
    manifest,
    blueprint.payload.resource.id,
    blueprint.payload.resource,
  ) ? payloadManager.observeRepair(manifest) : "ownership-drift";
  let payload = resourcePlan(blueprint.payload.resource.id, payloadObservation);

  const installer = new ServiceRegistrationInstaller({
    platform: blueprint.platform,
    runner: input.runner ?? new SystemServiceRegistrationCommandRunner(),
  });
  let services: PackagedRepairServicePlan[] = await Promise.all(blueprint.services.map(async service => {
    const observation: OwnershipObservation = exactResource(manifest, service.resource.id, service.resource)
      ? await installer.observeReady(service.resource, manifest)
      : "ownership-drift";
    return Object.freeze({ service: service.service, ...resourcePlan(service.resource.id, observation) });
  }));

  if (payload.action === "repair" && services.some(service => service.action === "preserve")) {
    payload = Object.freeze({
      ...payload,
      action: "preserve" as const,
      reason: "payload repair is blocked while any service registration ownership is ambiguous",
    });
  }
  if (payload.action === "preserve" && payload.observation !== "owned") {
    services = services.map(service => service.action === "repair"
      ? Object.freeze({
          ...service,
          action: "preserve" as const,
          reason: "service repair is blocked until the packaged payload is exact-owned",
        })
      : service);
  }
  return Object.freeze({
    installId: manifest.installId,
    productVersion: manifest.productVersion,
    targetPayloadFingerprint: blueprint.payloadFingerprint,
    blueprint,
    payload,
    services: Object.freeze(services),
  });
}

function effectiveAction(planned: PackagedRepairAction, current: PackagedRepairAction): "keep" | "repair" | "preserve" {
  if (planned === "preserve") return "preserve";
  if (planned === "keep") return current === "keep" ? "keep" : "preserve";
  if (current === "keep") return "keep";
  return current === "repair" ? "repair" : "preserve";
}

function initialJournal(input: {
  readonly plan: PackagedRepairPlan;
  readonly controlled: readonly TelaServiceId[];
  readonly repairServices: readonly TelaServiceId[];
  readonly resume: readonly TelaServiceId[];
}): PackagedRepairJournal {
  return Object.freeze({
    version: 1,
    installId: input.plan.installId,
    productVersion: input.plan.productVersion,
    targetPayloadFingerprint: input.plan.targetPayloadFingerprint,
    phase: "prepared",
    controlledServices: Object.freeze([...input.controlled]),
    repairServices: Object.freeze([...input.repairServices]),
    resumeServices: Object.freeze([...input.resume]),
    quiescedServices: Object.freeze([]),
    repairedResources: Object.freeze([]),
    resumedServices: Object.freeze([]),
  });
}

function resultFrom(
  plan: PackagedRepairPlan,
  payload: "kept" | "repaired" | "preserved",
  outcomes: ReadonlyMap<TelaServiceId, "kept" | "repaired" | "preserved">,
  resumed: readonly TelaServiceId[] = [],
): PackagedRepairResult {
  return Object.freeze({
    productVersion: plan.productVersion,
    payload,
    services: Object.freeze(plan.services.map(service => Object.freeze({
      service: service.service,
      outcome: outcomes.get(service.service) ?? "preserved",
    }))),
    resumedServices: Object.freeze([...resumed]),
  });
}

export async function applyPackagedRepairFromPayload(input: {
  readonly plan: PackagedRepairPlan;
  readonly payloadSourcePath: string;
  readonly services: PackagedRepairServiceController;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<PackagedRepairResult> {
  const current = await planPackagedRepairFromPayload({
    payloadSourcePath: input.payloadSourcePath,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.home ? { home: input.home } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
  });
  if (current.installId !== input.plan.installId
    || current.productVersion !== input.plan.productVersion
    || current.targetPayloadFingerprint !== input.plan.targetPayloadFingerprint
    || JSON.stringify(current.blueprint.desiredResources) !== JSON.stringify(input.plan.blueprint.desiredResources)) {
    throw new Error("packaged repair target changed after planning");
  }

  const manifest = readOwnershipManifest(current.blueprint.paths.installManifest)!;
  const payloadManager = new PackagedPayloadManager({
    manifestPath: current.blueprint.paths.installManifest,
    installId: manifest.installId,
    spec: current.blueprint.payload,
  });
  const installer = new ServiceRegistrationInstaller({
    platform: current.blueprint.platform,
    runner: input.runner ?? new SystemServiceRegistrationCommandRunner(),
  });
  const journalPath = packagedRepairJournalPath(current.blueprint.paths);
  let journal = readPackagedRepairJournal(journalPath);
  if (journal && !sameRepair(journal, input.plan)) {
    throw new Error("a different packaged repair journal already owns this install");
  }

  const serviceOutcomes = new Map<TelaServiceId, "kept" | "repaired" | "preserved">();
  const effectiveServices = new Map<TelaServiceId, "keep" | "repair" | "preserve">();
  for (const original of input.plan.services) {
    const now = current.services.find(service => service.service === original.service)!;
    const effective = effectiveAction(original.action, now.action);
    effectiveServices.set(original.service, effective);
    serviceOutcomes.set(original.service, effective === "repair" ? "repaired" : effective === "keep" ? "kept" : "preserved");
  }
  const payloadEffective = effectiveAction(input.plan.payload.action, current.payload.action);
  let payloadOutcome: "kept" | "repaired" | "preserved" = payloadEffective === "repair"
    ? "repaired"
    : payloadEffective === "keep" ? "kept" : "preserved";

  if (!journal && payloadEffective !== "repair") {
    if (payloadManager.observeRepair(manifest) !== "owned") {
      payloadOutcome = "preserved";
      for (const service of input.plan.services) {
        if (effectiveServices.get(service.service) === "repair") serviceOutcomes.set(service.service, "preserved");
      }
      return resultFrom(input.plan, payloadOutcome, serviceOutcomes);
    }
    for (const service of input.plan.services) {
      if (effectiveServices.get(service.service) !== "repair") continue;
      const blueprintService = current.blueprint.services.find(candidate => candidate.service === service.service)!;
      const before = await installer.observeReady(blueprintService.resource, manifest);
      if (before === "owned") {
        serviceOutcomes.set(service.service, "kept");
        continue;
      }
      if (before !== "missing") {
        serviceOutcomes.set(service.service, "preserved");
        continue;
      }
      await installer.install({
        manifestPath: current.blueprint.paths.installManifest,
        manifest,
        resource: blueprintService.resource,
        definition: blueprintService.definition,
      });
      const refreshed = readOwnershipManifest(current.blueprint.paths.installManifest)!;
      if (await installer.observeReady(blueprintService.resource, refreshed) !== "owned") {
        throw new Error(`packaged repair service verification failed: ${service.service}`);
      }
    }
    return resultFrom(input.plan, payloadOutcome, serviceOutcomes);
  }

  if (!journal) {
    if (input.plan.services.some(service => effectiveServices.get(service.service) === "preserve")) {
      return resultFrom(input.plan, "preserved", serviceOutcomes);
    }
    const controlled: TelaServiceId[] = [];
    const repairServices: TelaServiceId[] = [];
    const resume: TelaServiceId[] = [];
    for (const service of QUIESCE_ORDER) {
      const blueprintService = current.blueprint.services.find(candidate => candidate.service === service)!;
      const observed = await installer.observeReady(blueprintService.resource, manifest);
      if (effectiveServices.get(service) === "repair") repairServices.push(service);
      if (observed !== "owned") continue;
      controlled.push(service);
      if (await input.services.inspect(service) === "running") resume.push(service);
    }
    journal = initialJournal({ plan: input.plan, controlled, repairServices, resume });
    writeJournal(journalPath, journal);
  }

  if (journal.phase === "prepared") journal = updateJournal(journalPath, journal, { phase: "quiescing" });
  if (journal.phase === "quiescing") {
    const quiesced = [...journal.quiescedServices];
    for (const service of QUIESCE_ORDER) {
      if (!journal.controlledServices.includes(service) || quiesced.includes(service)) continue;
      await input.services.quiesce(service);
      quiesced.push(service);
      journal = updateJournal(journalPath, journal, { quiescedServices: Object.freeze([...quiesced]) });
    }
    journal = updateJournal(journalPath, journal, { phase: "quiesced" });
  }

  if (journal.phase === "quiesced" || journal.phase === "repairing") {
    for (const service of journal.controlledServices) {
      if (await input.services.inspect(service) !== "stopped") throw new Error(`packaged repair lost quiescence: ${service}`);
    }
    if (journal.phase === "quiesced") journal = updateJournal(journalPath, journal, { phase: "repairing" });
    const repaired = [...journal.repairedResources];
    if (!repaired.includes(current.payload.resourceId)) {
      await payloadManager.repair(manifest);
      repaired.push(current.payload.resourceId);
      journal = updateJournal(journalPath, journal, { repairedResources: Object.freeze([...repaired]) });
    }
    for (const service of journal.repairServices) {
      const planService = input.plan.services.find(candidate => candidate.service === service)!;
      if (repaired.includes(planService.resourceId)) continue;
      const blueprintService = current.blueprint.services.find(candidate => candidate.service === service)!;
      const before = await installer.observeReady(blueprintService.resource, manifest);
      if (before === "missing") {
        await installer.install({
          manifestPath: current.blueprint.paths.installManifest,
          manifest,
          resource: blueprintService.resource,
          definition: blueprintService.definition,
        });
      } else if (before !== "owned") {
        throw new Error(`packaged repair service ownership drifted after quiesce: ${service}`);
      }
      repaired.push(planService.resourceId);
      journal = updateJournal(journalPath, journal, { repairedResources: Object.freeze([...repaired]) });
    }
    journal = updateJournal(journalPath, journal, { phase: "repaired" });
  }

  if (journal.phase === "repaired") {
    const refreshed = readOwnershipManifest(current.blueprint.paths.installManifest)!;
    if (payloadManager.observeRepair(refreshed) !== "owned") throw new Error("packaged repair payload failed final verification");
    for (const service of current.blueprint.services) {
      if (await installer.observeReady(service.resource, refreshed) !== "owned") {
        throw new Error(`packaged repair service failed final verification: ${service.service}`);
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
  return resultFrom(input.plan, "repaired", serviceOutcomes, journal.resumedServices);
}

export async function planSignedPackagedRepairFromPayload(input: {
  readonly payloadSourcePath: string;
  readonly trustedKeys: PackagedPayloadTrustedKeys;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<PackagedRepairPlan> {
  verifyPackagedPayloadSignature({ payloadRoot: input.payloadSourcePath, trustedKeys: input.trustedKeys });
  return planPackagedRepairFromPayload(input);
}

export async function applySignedPackagedRepairFromPayload(input: Parameters<typeof applyPackagedRepairFromPayload>[0] & {
  readonly trustedKeys: PackagedPayloadTrustedKeys;
}): ReturnType<typeof applyPackagedRepairFromPayload> {
  verifyPackagedPayloadSignature({ payloadRoot: input.payloadSourcePath, trustedKeys: input.trustedKeys });
  return applyPackagedRepairFromPayload(input);
}
