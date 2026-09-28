import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProductPaths } from "./layout";

export function packagedUpgradeJournalPath(paths: ProductPaths): string {
  return join(paths.stateRoot, "install", "packaged-upgrade-v1.json");
}

export function packagedRepairJournalPath(paths: ProductPaths): string {
  return join(paths.stateRoot, "install", "packaged-repair-v1.json");
}

export function assertNoConflictingPackagedTransition(
  paths: ProductPaths,
  requested: "upgrade" | "repair",
): void {
  const conflicting = requested === "upgrade" ? packagedRepairJournalPath(paths) : packagedUpgradeJournalPath(paths);
  if (existsSync(conflicting)) {
    throw new Error(`cannot start packaged ${requested} while the other packaged transition has an incomplete journal`);
  }
}

export function assertNoActivePackagedTransition(
  paths: ProductPaths,
  requested: string,
): void {
  if (existsSync(packagedUpgradeJournalPath(paths)) || existsSync(packagedRepairJournalPath(paths))) {
    throw new Error(`cannot start packaged ${requested} while a packaged transition journal is incomplete`);
  }
}
