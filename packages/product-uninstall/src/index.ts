import { existsSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ChatManagedWorktreeManager,
  ChatManagedWorktreeOwnershipObserver,
} from "@chatgpt-tela/chat-service";
import {
  CredentialOwnershipManager,
  createPlatformCredentialStore,
} from "@chatgpt-tela/credential-store";
import {
  applyUninstallPlan,
  FilesystemOwnershipObserver,
  observeProductActivity,
  packagedRepairJournalPath,
  packagedUpgradeJournalPath,
  planUninstall,
  productActivityPath,
  readOwnershipManifest,
  readPackagedRepairJournal,
  readPackagedUpgradeJournal,
  resolveProductPaths,
  ServiceRegistrationManager,
  ServiceRegistrationOwnershipObserver,
  SystemServiceRegistrationCommandRunner,
  unregisterOwnedResource,
  type OwnedResource,
  type OwnershipManifest,
  type ProductPathOptions,
  type ProductPaths,
  type TelaServiceId,
} from "@chatgpt-tela/product-lifecycle";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import {
  SystemTailscaleCommandRunner,
  TailscaleFunnelLeaseManager,
  tailscaleFunnelLeaseFromResource,
  TailscaleFunnelOwnershipObserver,
} from "@chatgpt-tela/tailscale-ingress";

export type ProductUninstallMode = "dry-run" | "apply";

export interface ProductUninstallOptions extends ProductPathOptions {
  readonly mode: ProductUninstallMode;
  readonly removeData?: boolean;
  readonly paths?: ProductPaths;
  readonly executingBinaryPath?: string;
}

function serviceDescriptorPath(paths: ProductPaths, service: TelaServiceId): string {
  return join(paths.serviceRuntime(service), "descriptor.json");
}

function inside(rootValue: string, candidateValue: string): boolean {
  const root = resolve(rootValue);
  const candidate = resolve(candidateValue);
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertExternalUninstaller(manifest: OwnershipManifest, executingBinaryPath: string | undefined): void {
  if (!executingBinaryPath) return;
  const binary = manifest.resources.find(resource => resource.kind === "directory"
    && resource.id === "product-binaries"
    && resource.dataClass === "binary");
  if (binary?.kind === "directory" && inside(binary.path, executingBinaryPath)) {
    throw new Error("uninstall --apply cannot run from the installed ChatGPT Tela binary directory; run it from a separately extracted package copy");
  }
}

export function profileSetupActivityBlockers(paths: ProductPaths, installId: string): readonly string[] {
  const blockers: string[] = [];
  for (let profileSlot = 1; profileSlot <= 99; profileSlot += 1) {
    const path = productActivityPath(paths.runtimeRoot, "profile-setup", String(profileSlot));
    try {
      const state = observeProductActivity({ path, installId, kind: "profile-setup", scope: String(profileSlot) });
      if (state === "active") blockers.push(`profile ${profileSlot} setup is active`);
      else if (state === "drift") blockers.push(`profile ${profileSlot} setup activity ownership is ambiguous`);
    } catch {
      blockers.push(`profile ${profileSlot} setup activity state is unreadable or unsafe`);
    }
  }
  return Object.freeze(blockers);
}

export async function runProductUninstall(input: ProductUninstallOptions): Promise<Readonly<Record<string, unknown>>> {
  const platform = input.platform ?? process.platform;
  const environment = input.environment ?? process.env;
  const paths = input.paths ?? resolveProductPaths({
    platform,
    ...(input.home ? { home: input.home } : {}),
    environment,
  });
  const removeData = input.removeData === true;
  const manifest = readOwnershipManifest(paths.installManifest);
  if (!manifest) {
    return Object.freeze({
      status: "not-installed-by-manifest",
      installManifest: paths.installManifest,
      destructiveActions: 0,
    });
  }

  if (input.mode === "apply") {
    assertExternalUninstaller(manifest, input.executingBinaryPath);
    const upgradeJournal = readPackagedUpgradeJournal(packagedUpgradeJournalPath(paths));
    if (upgradeJournal) {
      throw new Error(`packaged upgrade ${upgradeJournal.fromVersion} -> ${upgradeJournal.toVersion} is incomplete; resume or repair it before uninstall apply`);
    }
    const repairJournal = readPackagedRepairJournal(packagedRepairJournalPath(paths));
    if (repairJournal) {
      throw new Error(`packaged repair for ${repairJournal.productVersion} is incomplete; resume it before uninstall apply`);
    }
  }

  const filesystemObserver = new FilesystemOwnershipObserver();
  const hasManagedWorktrees = manifest.resources.some(resource => resource.kind === "managed-worktree");
  const hasTailscaleRoutes = manifest.resources.some(resource => resource.kind === "tailscale-route");
  const hasServiceRegistrations = manifest.resources.some(resource => resource.kind === "service-registration");
  const hasCredentials = manifest.resources.some(resource => resource.kind === "credential");
  const managedWorktreeManager = hasManagedWorktrees
    ? new ChatManagedWorktreeManager({
        managedRoot: join(paths.serviceState("chat"), "managed-worktrees"),
        storePath: join(paths.serviceState("chat"), "managed-worktrees-v1.json"),
        ownershipManifestPath: paths.installManifest,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
        createManagedRoot: false,
      })
    : undefined;
  const managedWorktreeObserver = managedWorktreeManager
    ? new ChatManagedWorktreeOwnershipObserver(managedWorktreeManager)
    : undefined;
  const tailscaleManager = hasTailscaleRoutes
    ? new TailscaleFunnelLeaseManager({
        runner: new SystemTailscaleCommandRunner(environment.CHATGPT_TELA_TAILSCALE_CLI?.trim() || "tailscale"),
        manifestPath: paths.installManifest,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
      })
    : undefined;
  const tailscaleObserver = tailscaleManager ? new TailscaleFunnelOwnershipObserver(tailscaleManager) : undefined;
  const serviceRegistrationManager = hasServiceRegistrations
    ? new ServiceRegistrationManager({ runner: new SystemServiceRegistrationCommandRunner(), platform })
    : undefined;
  const serviceRegistrationObserver = serviceRegistrationManager
    ? new ServiceRegistrationOwnershipObserver(serviceRegistrationManager)
    : undefined;
  const credentialStore = hasCredentials
    ? createPlatformCredentialStore({ platform, stateRoot: paths.stateRoot })
    : undefined;
  const credentialOwnership = credentialStore
    ? new CredentialOwnershipManager({
        store: credentialStore,
        manifestPath: paths.installManifest,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
      })
    : undefined;
  const activityBlockers = profileSetupActivityBlockers(paths, manifest.installId);
  const codexActivityBlocked = activityBlockers.length > 0;
  const observer = {
    observe(resource: OwnedResource, currentManifest: OwnershipManifest) {
      if (resource.owner === "codex" && codexActivityBlocked) return "dirty" as const;
      if (resource.kind === "managed-worktree" && managedWorktreeObserver) {
        return managedWorktreeObserver.observe(resource, currentManifest);
      }
      if (resource.kind === "tailscale-route" && tailscaleObserver) {
        return tailscaleObserver.observe(resource, currentManifest);
      }
      if (resource.kind === "service-registration" && serviceRegistrationObserver) {
        return serviceRegistrationObserver.observe(resource, currentManifest);
      }
      if (resource.kind === "credential" && credentialOwnership) {
        return credentialOwnership.observe(resource, currentManifest);
      }
      return filesystemObserver.observe(resource, currentManifest);
    },
  };

  const blockedOwners = new Set<"product" | "gateway" | "chat" | "codex">();
  const shutdownFailures: Array<{ readonly owner: string; readonly detail: string }> = [];
  if (codexActivityBlocked) {
    blockedOwners.add("codex");
    shutdownFailures.push({ owner: "codex-profile-setup", detail: activityBlockers.join("; ") });
  }
  if (input.mode === "apply") {
    const supervisor = new LocalServiceSupervisor({ installId: manifest.installId });
    for (const service of ["gateway", "chat", "codex"] as const) {
      try {
        await supervisor.shutdown({ service, descriptorPath: serviceDescriptorPath(paths, service) });
      } catch (error) {
        blockedOwners.add(service);
        shutdownFailures.push({ owner: service, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const plan = await planUninstall({ manifest, observer, removeData });
  if (input.mode === "dry-run") {
    return Object.freeze({ dryRun: true, activityBlockers, ...plan });
  }

  const result = await applyUninstallPlan({
    manifest,
    plan,
    blockedOwners,
    operator: {
      observe: observer.observe,
      async remove(resource, currentManifest) {
        if (resource.kind === "managed-worktree") {
          if (!managedWorktreeManager) return { removed: false, detail: "managed worktree lifecycle is unavailable" };
          const record = managedWorktreeManager.recordForResource(resource.id);
          if (!record) return { removed: false, detail: "managed worktree resource is not present in the Chat ownership store" };
          const removed = await managedWorktreeManager.remove(record.id);
          return { removed: removed.removed, detail: removed.detail };
        }
        if (resource.kind === "tailscale-route") {
          if (!tailscaleManager) return { removed: false, detail: "Tailscale lifecycle is unavailable" };
          const released = await tailscaleManager.release(tailscaleFunnelLeaseFromResource(resource));
          return { removed: released.state === "released" || released.state === "already-absent", detail: released.detail };
        }
        if (resource.kind === "directory") {
          if (await filesystemObserver.observe(resource, currentManifest) !== "owned") {
            return { removed: false, detail: "directory ownership could not be re-proven immediately before removal" };
          }
          const absolute = resolve(resource.path);
          if (dirname(absolute) === absolute) throw new Error("refusing to remove a filesystem root");
          rmSync(absolute, { recursive: true, force: false });
          return { removed: true, detail: "exact marker-owned directory removed" };
        }
        if (resource.kind === "service-registration") {
          if (!serviceRegistrationManager) return { removed: false, detail: "service-registration lifecycle is unavailable" };
          return serviceRegistrationManager.release(resource, currentManifest);
        }
        if (resource.kind === "credential") {
          if (!credentialOwnership) return { removed: false, detail: "credential lifecycle is unavailable" };
          return credentialOwnership.remove(resource, currentManifest);
        }
        return { removed: false, detail: "resource lifecycle is unavailable" };
      },
    },
  });

  for (const step of result.steps) {
    if (step.outcome !== "removed" && step.outcome !== "already-absent") continue;
    if (!existsSync(paths.installManifest)) continue;
    await unregisterOwnedResource({
      path: paths.installManifest,
      installId: manifest.installId,
      productVersion: manifest.productVersion,
      resourceId: step.resourceId,
    });
  }
  const remaining = readOwnershipManifest(paths.installManifest);
  const canRemoveManifest = removeData
    && result.failedCount === 0
    && result.preservedCount === 0
    && (remaining?.resources.length ?? 0) === 0;
  if (canRemoveManifest) rmSync(paths.installManifest, { force: true });
  return Object.freeze({
    applied: true,
    removeData,
    activityBlockers,
    shutdownFailures,
    ...result,
    manifestRemoved: canRemoveManifest,
  });
}
