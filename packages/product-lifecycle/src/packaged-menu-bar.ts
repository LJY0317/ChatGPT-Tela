import { mkdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import type { ProductPaths } from "./layout";
import { PACKAGED_TRANSITION_TIMEOUT_MS } from "./service-shutdown";
import type { PackagedInstallBlueprint } from "./packaged-install";
import type { OwnershipManifest } from "./ownership";
import { mutateOwnershipManifest } from "./ownership-store";
import { ServiceRegistrationInstaller, ServiceRegistrationManager, SystemServiceRegistrationCommandRunner, type ServiceRegistrationCommandRunner } from "./service-registration";

export function packagedMenuBarReadyPath(paths: ProductPaths): string {
  return join(paths.runtimeRoot, "menu-bar-ready.json");
}

/** A launch command is not GUI readiness. Observe the UI's own one-shot
 * startup acknowledgement without polling or another resident service. */
export async function waitForPackagedMenuBar(input: {
  readonly paths: ProductPaths; readonly productVersion: string;
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
        if (ready.productVersion === input.productVersion
          && Number.isSafeInteger(ready.pid) && ready.pid > 0) {
          process.kill(ready.pid, 0);
          finish();
        }
      } catch { /* The UI publishes atomically after creating its status item. */ }
    };
    const aborted = () => finish(new Error("updated menu bar did not acknowledge startup; resume installation to finish UI refresh"));
    // Event filenames are optional; the owned receipt itself proves readiness.
    const observer = watch(input.paths.runtimeRoot, check);
    observer.once("error", finish);
    input.signal.addEventListener("abort", aborted, { once: true });
    if (input.signal.aborted) aborted(); else check();
  });
}

/** Renew only this install's menu registration. RunAtLoad opens the app once;
 * LaunchServices reuses an already-running UI rather than spawning a wrapper. */
export async function installPackagedMenuBarRegistration(input: {
  readonly blueprint: PackagedInstallBlueprint;
  readonly manifest: OwnershipManifest;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<void> {
  const { blueprint, manifest } = input;
  if (!blueprint.menuBar) return;
  const menu = blueprint.menuBar;
  const existing = manifest.resources.find(resource => resource.id === menu.resource.id);
  if (existing?.kind !== "service-registration" || existing.owner !== menu.resource.owner
    || existing.registrationId !== menu.resource.registrationId
    || existing.identity?.definitionPath !== menu.resource.identity?.definitionPath
    || existing.identity?.markerPath !== menu.resource.identity?.markerPath) {
    throw new Error("menu bar registration ownership changed during installation");
  }
  const runner = input.runner ?? new SystemServiceRegistrationCommandRunner();
  const installer = new ServiceRegistrationInstaller({ platform: blueprint.platform, runner });
  // Missing registration is also the durable recovery state after an interrupted
  // release. A foreign/edited registration is never overwritten by install.
  if (await installer.observeReady(menu.resource, manifest) !== "missing") {
    const released = await new ServiceRegistrationManager({ platform: blueprint.platform, runner }).release(existing, manifest);
    if (!released.removed) throw new Error("menu bar registration ownership could not be re-proven");
  }
  const next = await mutateOwnershipManifest({ path: blueprint.paths.installManifest, installId: manifest.installId,
    productVersion: manifest.productVersion, mutate(current) {
      return { ...current, resources: current.resources.map(resource => resource.id === menu.resource.id ? menu.resource : resource) };
    } });
  await installer.install({ manifestPath: blueprint.paths.installManifest, manifest: next,
    resource: menu.resource, definition: menu.definition });
}

export async function refreshPackagedMenuBar(input: {
  readonly blueprint: PackagedInstallBlueprint;
  readonly manifest: OwnershipManifest;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<void> {
  if (!input.blueprint.menuBar) return;
  await installPackagedMenuBarRegistration(input);
  await waitForPackagedMenuBar({ paths: input.blueprint.paths, productVersion: input.manifest.productVersion,
    signal: AbortSignal.timeout(PACKAGED_TRANSITION_TIMEOUT_MS) });
}
