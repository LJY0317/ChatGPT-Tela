import { mkdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import type { ProductPaths } from "./layout";
import { PACKAGED_TRANSITION_TIMEOUT_MS } from "./service-shutdown";
import type { PackagedInstallBlueprint } from "./packaged-install";
import type { OwnershipManifest } from "./ownership";
import { beginPackagedPayloadReplacement, observeInstalledPackagedPayload, PackagedPayloadManager, readPackagedPayloadReceipt } from "./packaged-payload";
import { ServiceRegistrationInstaller, SystemServiceRegistrationCommandRunner, type ServiceRegistrationCommandRunner } from "./service-registration";

export function packagedMenuBarReadyPath(paths: ProductPaths): string {
  return join(paths.runtimeRoot, "menu-bar-ready.json");
}

/** A launchd PID proves only the wrapper started. Observe the UI's own one-shot
 * startup acknowledgement without polling or another resident service. */
export async function waitForPackagedMenuBar(input: {
  readonly paths: ProductPaths; readonly parentPid: number; readonly productVersion: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const path = packagedMenuBarReadyPath(input.paths);
  mkdirSync(input.paths.runtimeRoot, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      observer.close(); input.signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      try {
        const ready = JSON.parse(readFileSync(path, "utf8"));
        if (ready.parentPid === input.parentPid && ready.productVersion === input.productVersion
          && Number.isSafeInteger(ready.pid) && ready.pid > 0) {
          process.kill(ready.pid, 0);
          finish();
        }
      } catch { /* The UI publishes atomically after creating its status item. */ }
    };
    const aborted = () => finish(new Error("updated menu bar did not acknowledge startup; resume installation to finish UI refresh"));
    const observer = watch(input.paths.runtimeRoot, (_event, name) => { if (name?.toString() === "menu-bar-ready.json") check(); });
    observer.once("error", finish);
    input.signal.addEventListener("abort", aborted, { once: true });
    if (input.signal.aborted) aborted(); else check();
  });
}

/** Replace the running UI through its owned OS registration, after the services
 * have restored. The independent lifecycle worker survives the UI's exit. */
export async function refreshPackagedMenuBar(input: {
  readonly blueprint: PackagedInstallBlueprint;
  readonly manifest: OwnershipManifest;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<void> {
  const { blueprint, manifest } = input;
  if (!blueprint.menuBar) return;
  const menu = blueprint.menuBar;
  if (blueprint.menuBarApp) {
    const app = blueprint.menuBarApp;
    const owner = new PackagedPayloadManager({ manifestPath: blueprint.paths.installManifest, installId: manifest.installId, spec: app });
    if (owner.observe(manifest) !== "owned") {
      const previous = readPackagedPayloadReceipt(app.resource);
      if (previous) {
        if (observeInstalledPackagedPayload(app.resource, manifest).state !== "owned") {
          throw new Error("installed macOS app ownership changed during update");
        }
        beginPackagedPayloadReplacement({ resource: app.resource, manifest, expected: previous });
      }
      await owner.install(manifest);
    }
  }
  const existing = manifest.resources.find(resource => resource.id === menu.resource.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(menu.resource)) {
    throw new Error("menu bar registration ownership changed during installation");
  }
  const runner = input.runner ?? new SystemServiceRegistrationCommandRunner();
  const installer = new ServiceRegistrationInstaller({ platform: blueprint.platform, runner });
  await installer.install({ manifestPath: blueprint.paths.installManifest, manifest, resource: menu.resource, definition: menu.definition });
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("macOS menu bar refresh requires a user id");
  const signal = AbortSignal.timeout(PACKAGED_TRANSITION_TIMEOUT_MS);
  const result = await runner.run("/bin/launchctl", ["kickstart", "-k", "-p", `gui/${uid}/${menu.resource.registrationId}`]);
  if (result.exitCode !== 0 || !/^\s*[1-9]\d*\s*$/.test(result.stdout)) {
    throw new Error("updated menu bar could not be launched; resume the installation to finish UI refresh");
  }
  await waitForPackagedMenuBar({ paths: blueprint.paths, parentPid: Number(result.stdout.trim()),
    productVersion: manifest.productVersion, signal });
}
