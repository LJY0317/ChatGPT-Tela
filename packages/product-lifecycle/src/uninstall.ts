import { existsSync, lstatSync } from "node:fs";
import type { OwnedResource, OwnershipManifest } from "./ownership";
import { readOwnershipMarker } from "./ownership";

export type OwnershipObservation =
  | "missing"
  | "owned"
  | "dirty"
  | "ownership-drift"
  | "unsafe"
  | "unknown";

export interface UninstallObserver {
  observe(resource: OwnedResource, manifest: OwnershipManifest): OwnershipObservation | Promise<OwnershipObservation>;
}

export interface UninstallPlanStep {
  readonly resourceId: string;
  readonly owner: OwnedResource["owner"];
  readonly resourceKind: OwnedResource["kind"];
  readonly action: "remove" | "preserve" | "already-absent";
  readonly destructive: boolean;
  readonly reason: string;
}

export interface UninstallPlan {
  readonly installId: string;
  readonly removeData: boolean;
  readonly steps: readonly UninstallPlanStep[];
  readonly removableCount: number;
  readonly preservedCount: number;
}

export interface UninstallApplyOperator extends UninstallObserver {
  remove(resource: OwnedResource, manifest: OwnershipManifest): Promise<{ readonly removed: boolean; readonly detail: string }>;
}

export interface UninstallApplyStep {
  readonly resourceId: string;
  readonly owner: OwnedResource["owner"];
  readonly resourceKind: OwnedResource["kind"];
  readonly outcome: "removed" | "already-absent" | "preserved" | "failed";
  readonly detail: string;
}

export interface UninstallApplyResult {
  readonly installId: string;
  readonly steps: readonly UninstallApplyStep[];
  readonly removedCount: number;
  readonly preservedCount: number;
  readonly failedCount: number;
}

function dataPreserved(resource: OwnedResource, removeData: boolean): boolean {
  if (resource.kind === "credential") return !removeData;
  return resource.kind === "directory"
    && !removeData
    && (["config", "state", "browser-profile"] as const).includes(resource.dataClass as never);
}

function priority(resource: OwnedResource): number {
  if (resource.kind === "service-registration") {
    return resource.owner === "gateway" ? 0 : 1;
  }
  if (resource.kind === "tailscale-route") return 2;
  if (resource.kind === "managed-worktree") return 3;
  if (resource.kind === "credential") return 4;
  if (resource.kind === "directory" && resource.dataClass === "binary") return 9;
  return 5;
}

export async function planUninstall(input: {
  readonly manifest: OwnershipManifest;
  readonly observer: UninstallObserver;
  readonly removeData: boolean;
}): Promise<UninstallPlan> {
  const ordered = [...input.manifest.resources].sort((a, b) => priority(a) - priority(b));
  const steps: UninstallPlanStep[] = [];
  for (const resource of ordered) {
    const observation = await input.observer.observe(resource, input.manifest);
    if (observation === "missing") {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        action: "already-absent", destructive: false, reason: "recorded resource is already absent" }));
      continue;
    }
    if (dataPreserved(resource, input.removeData)) {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        action: "preserve", destructive: false, reason: "local data preservation was requested" }));
      continue;
    }
    if (observation === "owned") {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        action: "remove", destructive: true, reason: "current resource identity matches the install manifest" }));
      continue;
    }
    const reason = observation === "dirty"
      ? "resource contains uncommitted or otherwise user-significant state"
      : observation === "ownership-drift"
        ? "current resource identity no longer matches Tela ownership"
        : observation === "unsafe"
          ? "resource path/type is unsafe or replaced"
          : "resource ownership cannot be proven";
    steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
      action: "preserve", destructive: false, reason }));
  }
  return Object.freeze({
    installId: input.manifest.installId,
    removeData: input.removeData,
    steps: Object.freeze(steps),
    removableCount: steps.filter(step => step.action === "remove").length,
    preservedCount: steps.filter(step => step.action === "preserve").length,
  });
}

export async function applyUninstallPlan(input: {
  readonly manifest: OwnershipManifest;
  readonly plan: UninstallPlan;
  readonly operator: UninstallApplyOperator;
  readonly blockedOwners?: ReadonlySet<OwnedResource["owner"]>;
}): Promise<UninstallApplyResult> {
  if (input.plan.installId !== input.manifest.installId) throw new Error("uninstall plan belongs to a different Tela install instance");
  const resources = new Map(input.manifest.resources.map(resource => [resource.id, resource] as const));
  const steps: UninstallApplyStep[] = [];
  for (const planned of input.plan.steps) {
    const resource = resources.get(planned.resourceId);
    if (!resource) {
      steps.push(Object.freeze({ resourceId: planned.resourceId, owner: planned.owner, resourceKind: planned.resourceKind,
        outcome: "failed", detail: "planned resource no longer exists in the starting ownership manifest" }));
      continue;
    }
    if (planned.action === "preserve") {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: "preserved", detail: planned.reason }));
      continue;
    }
    if (input.blockedOwners?.has(resource.owner)) {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: "preserved", detail: `${resource.owner} service did not stop cleanly; owned resource was preserved` }));
      continue;
    }
    let observed: OwnershipObservation;
    try { observed = await input.operator.observe(resource, input.manifest); }
    catch (error) {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: "failed", detail: error instanceof Error ? error.message : String(error) }));
      continue;
    }
    if (planned.action === "already-absent" && observed !== "missing") {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: "preserved", detail: "resource appeared after the non-destructive plan; generate a new uninstall plan before removal" }));
      continue;
    }
    if (observed === "missing") {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: "already-absent", detail: "resource became or remained absent before apply" }));
      continue;
    }
    if (observed !== "owned") {
      const detail = observed === "dirty"
        ? "resource became dirty before apply"
        : observed === "ownership-drift"
          ? "resource ownership drifted before apply"
          : observed === "unsafe"
            ? "resource became unsafe or was replaced before apply"
            : "resource ownership could not be re-proven before apply";
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: "preserved", detail }));
      continue;
    }
    try {
      const removed = await input.operator.remove(resource, input.manifest);
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: removed.removed ? "removed" : "preserved", detail: removed.detail }));
    } catch (error) {
      steps.push(Object.freeze({ resourceId: resource.id, owner: resource.owner, resourceKind: resource.kind,
        outcome: "failed", detail: error instanceof Error ? error.message : String(error) }));
    }
  }
  return Object.freeze({
    installId: input.manifest.installId,
    steps: Object.freeze(steps),
    removedCount: steps.filter(step => step.outcome === "removed" || step.outcome === "already-absent").length,
    preservedCount: steps.filter(step => step.outcome === "preserved").length,
    failedCount: steps.filter(step => step.outcome === "failed").length,
  });
}

export class FilesystemOwnershipObserver implements UninstallObserver {
  observe(resource: OwnedResource, manifest: OwnershipManifest): OwnershipObservation {
    if (resource.kind !== "directory") return "unknown";
    if (!existsSync(resource.path)) return "missing";
    const stat = lstatSync(resource.path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "unsafe";
    let marker;
    try { marker = readOwnershipMarker(resource.path); }
    catch { return "unsafe"; }
    if (!marker) return "ownership-drift";
    return marker.installId === manifest.installId && marker.resourceId === resource.id
      ? "owned"
      : "ownership-drift";
  }
}
