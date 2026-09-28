import { createHash } from "node:crypto";
import type { OwnedResource, OwnershipManifest } from "./ownership";
import type { OwnershipObservation, UninstallObserver } from "./uninstall";

export interface InstallPlanStep {
  readonly resourceId: string;
  readonly owner: OwnedResource["owner"];
  readonly resourceKind: OwnedResource["kind"];
  readonly action: "create" | "keep" | "preserve";
  readonly mutating: boolean;
  readonly reason: string;
}

export interface InstallPlan {
  readonly installId: string;
  readonly productVersion: string;
  readonly desiredFingerprint: string;
  readonly steps: readonly InstallPlanStep[];
  readonly createCount: number;
  readonly keepCount: number;
  readonly preservedCount: number;
}

function desiredResourceFingerprint(resources: readonly OwnedResource[]): string {
  const normalized = resources.map(resource => JSON.stringify(resource)).sort();
  return createHash("sha256").update(normalized.join("\n")).digest("hex");
}

export interface InstallApplyOperator extends UninstallObserver {
  create(resource: OwnedResource, manifest: OwnershipManifest): Promise<{ readonly created: boolean; readonly detail: string }>;
}

export interface InstallApplyStep {
  readonly resourceId: string;
  readonly owner: OwnedResource["owner"];
  readonly resourceKind: OwnedResource["kind"];
  readonly outcome: "created" | "kept" | "preserved" | "failed";
  readonly detail: string;
}

export interface InstallApplyResult {
  readonly installId: string;
  readonly steps: readonly InstallApplyStep[];
  readonly createdCount: number;
  readonly keptCount: number;
  readonly preservedCount: number;
  readonly failedCount: number;
}

function preserveReason(observation: OwnershipObservation): string {
  return observation === "dirty"
    ? "resource contains user-significant state"
    : observation === "ownership-drift"
      ? "current resource identity belongs to another owner or install"
      : observation === "unsafe"
        ? "resource path/type is unsafe or replaced"
        : "resource ownership cannot be proven";
}

export async function planInstall(input: {
  readonly manifest: OwnershipManifest;
  readonly desiredResources: readonly OwnedResource[];
  readonly observer: UninstallObserver;
}): Promise<InstallPlan> {
  const ids = new Set<string>();
  const steps: InstallPlanStep[] = [];
  for (const resource of input.desiredResources) {
    if (ids.has(resource.id)) throw new Error(`duplicate desired install resource id: ${resource.id}`);
    ids.add(resource.id);
    const existing = input.manifest.resources.find(candidate => candidate.id === resource.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(resource)) {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        action: "preserve", mutating: false, reason: "install manifest already records a different identity for this resource id" }));
      continue;
    }
    const observation = await input.observer.observe(resource, input.manifest);
    if (observation === "missing") {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        action: "create", mutating: true, reason: "desired Tela resource is absent" }));
    } else if (observation === "owned") {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        action: "keep", mutating: false, reason: "current resource already matches this Tela install" }));
    } else {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        action: "preserve", mutating: false, reason: preserveReason(observation) }));
    }
  }
  return Object.freeze({
    installId: input.manifest.installId,
    productVersion: input.manifest.productVersion,
    desiredFingerprint: desiredResourceFingerprint(input.desiredResources),
    steps: Object.freeze(steps),
    createCount: steps.filter(step => step.action === "create").length,
    keepCount: steps.filter(step => step.action === "keep").length,
    preservedCount: steps.filter(step => step.action === "preserve").length,
  });
}

export async function applyInstallPlan(input: {
  readonly manifest: OwnershipManifest;
  readonly desiredResources: readonly OwnedResource[];
  readonly plan: InstallPlan;
  readonly operator: InstallApplyOperator;
}): Promise<InstallApplyResult> {
  if (input.plan.installId !== input.manifest.installId) throw new Error("install plan belongs to a different Tela install instance");
  if (input.plan.productVersion !== input.manifest.productVersion) throw new Error("install plan belongs to a different Tela product version");
  if (input.plan.desiredFingerprint !== desiredResourceFingerprint(input.desiredResources)) {
    throw new Error("install desired resource identities changed after planning");
  }
  const desired = new Map(input.desiredResources.map(resource => [resource.id, resource] as const));
  const steps: InstallApplyStep[] = [];
  for (const planned of input.plan.steps) {
    const resource = desired.get(planned.resourceId);
    if (!resource) {
      steps.push(Object.freeze({ resourceId: planned.resourceId, owner: planned.owner, resourceKind: planned.resourceKind,
        outcome: "failed", detail: "planned resource no longer exists in the desired install set" }));
      continue;
    }
    if (planned.action === "preserve") {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: "preserved", detail: planned.reason }));
      continue;
    }
    let observed: OwnershipObservation;
    try { observed = await input.operator.observe(resource, input.manifest); }
    catch (error) {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: "failed", detail: error instanceof Error ? error.message : String(error) }));
      continue;
    }
    if (planned.action === "keep") {
      if (observed === "owned") {
        steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
          outcome: "kept", detail: "resource remains owned by this Tela install" }));
      } else {
        steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
          outcome: "preserved", detail: "resource changed after the non-mutating plan; generate a new install plan" }));
      }
      continue;
    }
    if (observed === "owned") {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: "kept", detail: "resource appeared as exact Tela-owned state before create; no duplicate mutation was needed" }));
      continue;
    }
    if (observed !== "missing") {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: "preserved", detail: "resource changed after the create plan; refusing to overwrite it" }));
      continue;
    }
    try {
      const created = await input.operator.create(resource, input.manifest);
      const verification = await input.operator.observe(resource, input.manifest);
      if (verification !== "owned") {
        steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
          outcome: "failed", detail: `resource create did not verify as owned (${verification}): ${created.detail}` }));
        continue;
      }
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: created.created ? "created" : "kept", detail: created.detail }));
    } catch (error) {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: "failed", detail: error instanceof Error ? error.message : String(error) }));
    }
  }
  return Object.freeze({
    installId: input.manifest.installId,
    steps: Object.freeze(steps),
    createdCount: steps.filter(step => step.outcome === "created").length,
    keptCount: steps.filter(step => step.outcome === "kept").length,
    preservedCount: steps.filter(step => step.outcome === "preserved").length,
    failedCount: steps.filter(step => step.outcome === "failed").length,
  });
}

export async function verifyInstall(input: {
  readonly manifest: OwnershipManifest;
  readonly desiredResources: readonly OwnedResource[];
  readonly observer: UninstallObserver;
}): Promise<{
  readonly ready: boolean;
  readonly resources: readonly { readonly resourceId: string; readonly observation: OwnershipObservation }[];
}> {
  const resources = await Promise.all(input.desiredResources.map(async resource => Object.freeze({
    resourceId: resource.id,
    observation: await input.observer.observe(resource, input.manifest),
  })));
  return Object.freeze({ ready: resources.every(resource => resource.observation === "owned"), resources: Object.freeze(resources) });
}
