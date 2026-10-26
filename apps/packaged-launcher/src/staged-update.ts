import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { packagedPayloadFingerprint, readPackagedProductManifest, readOwnershipManifest,
  resolveProductPaths, prepareOwnedDirectory, withPackagedTransitionOwner,
  readPackagedUpgradeJournal, packagedUpgradeJournalPath, readPackagedRepairJournal,
  packagedRepairJournalPath, type ProductPathOptions } from "@chatgpt-tela/product-lifecycle";

export function stagedUpdatePaths(options: ProductPathOptions = {}) {
  const paths = resolveProductPaths(options);
  return { paths, root: join(paths.cacheRoot, "updates"), record: join(paths.cacheRoot, "updates", "ready.json"),
    payload: join(paths.cacheRoot, "updates", "payload") };
}

// Presentation is cheap. Existing lifecycle review/apply verifies exact package bytes again.
export function readStagedUpdate(options: ProductPathOptions = {}) {
  const location = stagedUpdatePaths(options);
  try {
    const value = JSON.parse(readFileSync(location.record, "utf8"));
    const owner = readOwnershipManifest(location.paths.installManifest);
    if (!owner || value.version !== 1 || value.installId !== owner.installId || typeof value.productVersion !== "string"
      || !/^[a-f0-9]{64}$/.test(value.fingerprint) || value.productVersion === owner.productVersion
      || !existsSync(location.payload)) return null;
    return { productVersion: value.productVersion as string, payload: location.payload, fingerprint: value.fingerprint as string };
  } catch { return null; }
}

/** One owned candidate, serialized with the existing installer writer; no extra updater engine. */
export async function stageUpdate(payload: string, options: ProductPathOptions, verify: (payload: string) => Promise<unknown>) {
  const location = stagedUpdatePaths(options);
  const owner = readOwnershipManifest(location.paths.installManifest);
  if (!owner) throw Error("Install Tela before preparing an update");
  const source = realpathSync(payload);
  if (source === location.root || source.startsWith(location.root + sep) || location.root.startsWith(source + sep)) throw Error("Select a package outside the update cache");
  return withPackagedTransitionOwner({ paths: location.paths, installId: owner.installId }, async () => {
    const owner = readOwnershipManifest(location.paths.installManifest)!;
    if (readPackagedUpgradeJournal(packagedUpgradeJournalPath(location.paths))
      || readPackagedRepairJournal(packagedRepairJournalPath(location.paths))) throw Error("Finish the current installation before preparing another update");
    const manifest = readPackagedProductManifest(source);
    if (manifest.productVersion === owner.productVersion) throw Error("This version is already installed");
    const fingerprint = packagedPayloadFingerprint(source);
    const prepared = await prepareOwnedDirectory({ manifestPath: location.paths.installManifest,
      installId: owner.installId, productVersion: owner.productVersion,
      resource: { kind: "directory", id: "update-cache", owner: "product", path: location.root, dataClass: "cache" } });
    if (prepared.state === "external-existing") throw Error("Update cache is not owned by this installation");
    const temporary = join(location.root, "preparing");
    try {
      rmSync(temporary, { recursive: true, force: true });
      cpSync(source, temporary, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      if (packagedPayloadFingerprint(temporary) !== fingerprint) throw Error("Update package changed while preparing it");
      await verify(temporary);
      if (readPackagedProductManifest(temporary).productVersion !== manifest.productVersion) throw Error("Update version changed while preparing it");
      rmSync(location.record, { force: true });
      rmSync(location.payload, { recursive: true, force: true });
      renameSync(temporary, location.payload);
      const record = join(location.root, "ready.pending");
      writeFileSync(record, JSON.stringify({ version: 1, installId: owner.installId,
        productVersion: manifest.productVersion, fingerprint }) + "\n", { mode: 0o600 });
      renameSync(record, location.record);
      return { prepared: true, productVersion: manifest.productVersion };
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}
