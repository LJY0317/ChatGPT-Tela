import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareOwnedDirectory } from "./directory-registration";
import { OWNERSHIP_MARKER, readOwnershipManifest, readOwnershipMarker } from "./ownership";
import { copyOwnedPackagedPayloadSnapshot, copyVerifiedPackagedPayload, packagedPayloadFingerprint } from "./packaged-payload";
import { readPackagedProductManifest } from "./packaged-manifest";
import { readPackagedTransitionValue } from "./packaged-transition";
import { packagedUpgradeJournalPath } from "./packaged-transition";
import { observeInstalledPackagedPayload } from "./packaged-payload";
import type { PackagedUpgradePlan, PackagedUpgradeRecoveryArtifact } from "./packaged-upgrade";

const RESOURCE_ID = "upgrade-recovery-artifact";
const SLOTS = ["source", "previous", "pending"] as const;
type Review = PackagedUpgradeRecoveryArtifact & { readonly origin: "installed" | "retained" | "supplied" };
function root(plan: PackagedUpgradePlan) { return join(plan.targetBlueprint.paths.stateRoot, "install", "recovery"); }
function realDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("recovery artifact directory is unsafe");
}
function assertRoot(plan: PackagedUpgradePlan): void {
  const path = root(plan); realDirectory(path);
  const marker = readOwnershipMarker(path);
  const manifest = readOwnershipManifest(plan.targetBlueprint.paths.installManifest);
  const resource = manifest?.resources.find(row => row.id === RESOURCE_ID);
  if (manifest?.installId !== plan.installId || marker?.installId !== plan.installId || marker.resourceId !== RESOURCE_ID
    || resource?.kind !== "directory" || resource.path !== path || resource.owner !== "product" || resource.dataClass !== "state") {
    throw new Error("recovery artifact ownership is not proven");
  }
  if (readdirSync(path).some(name => ![OWNERSHIP_MARKER, ...SLOTS].includes(name))) throw new Error("recovery cache contains unrecognized state");
}
function assertSource(plan: PackagedUpgradePlan, artifact: PackagedUpgradeRecoveryArtifact, installed = false): void {
  const manifest = readOwnershipManifest(plan.targetBlueprint.paths.installManifest);
  const observed = installed ? observeInstalledPackagedPayload(plan.targetBlueprint.payload.resource, manifest!) : undefined;
  if (installed && observed?.state !== "owned") throw new Error("recovery source ownership is not proven");
  const fingerprint = observed?.state === "owned" ? observed.receipt.payloadFingerprint : packagedPayloadFingerprint(artifact.sourcePayloadPath);
  const source = readPackagedProductManifest(artifact.sourcePayloadPath);
  if (fingerprint !== plan.sourcePayload.payloadFingerprint || source.productVersion !== plan.fromVersion
    || source.lifecycle?.sourceCancellation !== 1 || source.lifecycle.transitionLaunch !== 1) {
    throw new Error("recovery artifact does not match the owned upgrade source");
  }
}
function incompletePending(plan: PackagedUpgradePlan): boolean {
  const path = join(root(plan), "pending");
  if (!existsSync(path)) return false;
  realDirectory(path);
  if (!existsSync(join(path, "receipt.json"))) {
    if (readdirSync(path).length === 0 && !existsSync(packagedUpgradeJournalPath(plan.targetBlueprint.paths))) return true;
    throw new Error("recovery staging has no ownership intent");
  }
  const receipt = readPackagedTransitionValue(join(path, "receipt.json")) as Record<string, unknown> | null;
  if (receipt?.phase !== "copying") return false;
  if (receipt.version !== 1 || receipt.installId !== plan.installId || receipt.productVersion !== plan.fromVersion
    || receipt.payloadFingerprint !== plan.sourcePayload.payloadFingerprint
    || existsSync(packagedUpgradeJournalPath(plan.targetBlueprint.paths))) throw new Error("incomplete recovery staging cannot be reconciled safely");
  return true;
}
function cached(plan: PackagedUpgradePlan, slot: string) {
  const path = join(root(plan), slot);
  if (!existsSync(path)) return;
  realDirectory(path); realDirectory(join(path, "payload"));
  if (readdirSync(path).some(name => !["payload", "receipt.json", "trusted-key.pem"].includes(name))) throw new Error("retained recovery bundle contains unrecognized state");
  const receipt = readPackagedTransitionValue(join(path, "receipt.json")) as Record<string, unknown> | null;
  const fingerprint = packagedPayloadFingerprint(join(path, "payload"));
  if (receipt?.version !== 1 || receipt.phase !== "ready" || receipt.installId !== plan.installId || receipt.productVersion !== readPackagedProductManifest(join(path, "payload")).productVersion
    || receipt.payloadFingerprint !== fingerprint) throw new Error("retained recovery receipt is invalid");
  return { sourcePayloadPath: join(path, "payload"), payloadFingerprint: fingerprint };
}

/** Read-only planning verifies owned snapshots and never creates a cache. */
export function reviewPackagedRecoveryArtifact(plan: PackagedUpgradePlan,
  supplied?: PackagedUpgradeRecoveryArtifact): Review {
  if (supplied) {
    assertSource(plan, supplied);
    // Verify retained ownership and bytes before retiring any old snapshot.
    if (existsSync(root(plan))) {
      assertRoot(plan);
      for (const slot of SLOTS) {
        if (slot === "pending" && incompletePending(plan)) continue;
        cached(plan, slot);
      }
    }
    return { ...supplied, origin: "supplied" };
  }
  if (existsSync(root(plan))) {
    assertRoot(plan);
    for (const slot of SLOTS) {
      if (slot === "pending" && incompletePending(plan)) continue;
      const artifact = cached(plan, slot);
      if (artifact?.payloadFingerprint === plan.sourcePayload.payloadFingerprint) {
        assertSource(plan, artifact); return { ...artifact, origin: "retained" };
      }
    }
  }
  const artifact = { sourcePayloadPath: plan.targetBlueprint.payload.resource.path };
  assertSource(plan, artifact, true);
  return { ...artifact, origin: "installed" };
}

/** Called under the shared transition lock, before any service stop.
 * Fixed slots bound storage to two committed copies plus one incomplete staging copy.
 * Only verified owned copies are retired; damaged/unknown evidence remains protected.
 */
export async function retainPackagedRecoveryArtifact(plan: PackagedUpgradePlan,
  supplied?: PackagedUpgradeRecoveryArtifact): Promise<PackagedUpgradeRecoveryArtifact> {
  const reviewed = reviewPackagedRecoveryArtifact(plan, supplied);
  if (reviewed.origin === "retained") return reviewed;
  const paths = plan.targetBlueprint.paths;
  const prepared = await prepareOwnedDirectory({ manifestPath: paths.installManifest, installId: plan.installId,
    productVersion: plan.fromVersion, resource: { kind: "directory", id: RESOURCE_ID, owner: "product", path: root(plan), dataClass: "state" } });
  if (prepared.state === "external-existing") throw new Error("recovery cache is not owned");
  assertRoot(plan);
  const previous = join(root(plan), "previous"), pending = join(root(plan), "pending"), source = join(root(plan), "source");
  // A retained copy that cannot be re-proven is never cleared to make space.
  for (const slot of ["previous", "pending"] as const) {
    if (existsSync(join(root(plan), slot))) {
      if (!(slot === "pending" && incompletePending(plan))) cached(plan, slot);
      rmSync(join(root(plan), slot), { recursive: true });
    }
  }
  if (existsSync(source)) cached(plan, "source");
  mkdirSync(pending, { mode: 0o700 });
  const receipt = { version: 1, installId: plan.installId, productVersion: plan.fromVersion,
    payloadFingerprint: plan.sourcePayload.payloadFingerprint };
  writeFileSync(join(pending, "receipt.json"), JSON.stringify({ ...receipt, phase: "copying" }) + "\n", { flag: "wx", mode: 0o600 });
  const destination = join(pending, "payload");
  if (reviewed.origin === "installed") {
    const manifest = readOwnershipManifest(paths.installManifest)!;
    copyOwnedPackagedPayloadSnapshot({ resource: plan.targetBlueprint.payload.resource, manifest, expected: plan.sourcePayload, destinationPath: destination });
  } else {
    // Use the common payload copier, not a permissive recursive filesystem copy.
    copyVerifiedPackagedPayload(reviewed.sourcePayloadPath, destination, plan.sourcePayload.payloadFingerprint);
  }
  const retained = { sourcePayloadPath: destination };
  assertSource(plan, retained);
  writeFileSync(join(pending, "receipt.next.json"), JSON.stringify({ ...receipt, phase: "ready" }) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(join(pending, "receipt.next.json"), join(pending, "receipt.json"));
  if (packagedPayloadFingerprint(destination) !== plan.sourcePayload.payloadFingerprint) throw new Error("retained recovery bytes changed before publication");
  if (existsSync(source)) renameSync(source, previous);
  renameSync(pending, source);
  return { sourcePayloadPath: join(source, "payload") };
}
