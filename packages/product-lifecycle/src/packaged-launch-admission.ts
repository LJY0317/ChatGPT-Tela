import { existsSync } from "node:fs";
import type { ProductPaths, TelaServiceId } from "./layout";
import type { OwnershipManifest } from "./ownership";
import type { PackagedPayloadReceipt } from "./packaged-payload";
import { readPackagedUpgradeJournal } from "./packaged-upgrade";
import { readPackagedRepairJournal } from "./packaged-repair";
import { packagedRepairJournalPath, packagedUpgradeJournalPath } from "./packaged-transition";

/** Called only after the physical installed payload/receipt has been re-proven. */
export function assertPackagedLaunchAdmission(input: {
  readonly paths: ProductPaths;
  readonly ownership: OwnershipManifest;
  readonly receipt: PackagedPayloadReceipt;
  readonly service?: TelaServiceId;
}): void {
  const upgradePath = packagedUpgradeJournalPath(input.paths), repairPath = packagedRepairJournalPath(input.paths);
  const upgradeExists = existsSync(upgradePath), repairExists = existsSync(repairPath);
  if (!upgradeExists && !repairExists) return;
  const refuse = () => { throw new Error("packaged service launch is blocked while an install transition journal is incomplete"); };
  if (!input.service || (upgradeExists && repairExists)) return refuse();
  const { ownership, receipt, service } = input;
  if (receipt.installId !== ownership.installId || receipt.productVersion !== ownership.productVersion) return refuse();
  if (upgradeExists) {
    let journal;
    try { journal = readPackagedUpgradeJournal(upgradePath); } catch { return refuse(); }
    if (!journal || journal.installId !== ownership.installId || !journal.resumeServices.includes(service)) return refuse();
    if (journal.phase === "restoring-source") {
      if (journal.fromVersion !== ownership.productVersion || journal.sourcePayloadFingerprint !== receipt.payloadFingerprint) return refuse();
    } else if (journal.phase !== "manifest-updated" || journal.toVersion !== ownership.productVersion
      || journal.targetPayloadFingerprint !== receipt.payloadFingerprint
      || !(["gateway", "codex", "chat"] as const).every(id => journal.quiescedServices.includes(id))) return refuse();
    return;
  }
  let journal;
  try { journal = readPackagedRepairJournal(repairPath); } catch { return refuse(); }
  if (!journal || journal.phase !== "repaired" || journal.installId !== ownership.installId
    || journal.productVersion !== ownership.productVersion || journal.targetPayloadFingerprint !== receipt.payloadFingerprint
    || !journal.resumeServices.includes(service) || !journal.controlledServices.includes(service)
    || !journal.controlledServices.every(id => journal.quiescedServices.includes(id))) return refuse();
}
