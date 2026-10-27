import { existsSync } from "node:fs";
import type { ProductPaths, TelaServiceId } from "./layout";
import type { OwnershipManifest } from "./ownership";
import type { PackagedPayloadReceipt } from "./packaged-payload";
import { readPackagedUpgradeJournal } from "./packaged-upgrade";
import { readPackagedRepairJournal } from "./packaged-repair";
import { macApplicationUpdatePath, readMacApplicationUpdate, assertNoPackagedUninstall, packagedRepairJournalPath, packagedUpgradeJournalPath } from "./packaged-transition";

/** Called only after the physical installed payload/receipt has been re-proven. */
export function assertPackagedLaunchAdmission(input: {
  readonly paths: ProductPaths;
  readonly ownership: OwnershipManifest;
  readonly receipt: PackagedPayloadReceipt;
  readonly service?: TelaServiceId;
  readonly menuBar?: boolean;
}): void {
  assertNoPackagedUninstall(input.paths);
  const upgradePath = packagedUpgradeJournalPath(input.paths), repairPath = packagedRepairJournalPath(input.paths);
  const upgradeExists = existsSync(upgradePath), repairExists = existsSync(repairPath);
  if (existsSync(macApplicationUpdatePath(input.paths))) {
    const journal = readMacApplicationUpdate(input.paths);
    if (upgradeExists || repairExists || !journal || journal.phase !== "resuming" || !input.service
      || journal.installId !== input.ownership.installId || journal.resumeVersion !== input.ownership.productVersion
      || journal.resumeFingerprint !== input.receipt.payloadFingerprint || !journal.runningServices.includes(input.service)) {
      throw Error("application update has not admitted this service restart");
    }
    return;
  }
  if (!upgradeExists && !repairExists) return;
  const refuse = () => { throw new Error("packaged service launch is blocked while an install transition journal is incomplete"); };
  if ((!input.service && !input.menuBar) || (upgradeExists && repairExists)) return refuse();
  const { ownership, receipt, service } = input;
  if (receipt.installId !== ownership.installId || receipt.productVersion !== ownership.productVersion) return refuse();
  if (upgradeExists) {
    let journal;
    try { journal = readPackagedUpgradeJournal(upgradePath); } catch { return refuse(); }
    if (!journal || journal.installId !== ownership.installId) return refuse();
    if (!service || !journal.resumeServices.includes(service)) return refuse();
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
    || (input.menuBar
      ? !journal.resumeServices.every(id => journal.resumedServices.includes(id))
      : !service || !journal.resumeServices.includes(service) || !journal.controlledServices.includes(service))
    || !journal.controlledServices.every(id => journal.quiescedServices.includes(id))) return refuse();
}
