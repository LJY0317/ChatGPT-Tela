import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readOwnershipManifest, resolveProductPaths, readPackagedUpgradeJournal, readPackagedRepairJournal,
  packagedUpgradeJournalPath, packagedRepairJournalPath, PackagedServiceShutdownNotStartedError, PackagedServiceTransitionError,
  PackagedUpgradeRecoveryError } from "@chatgpt-tela/product-lifecycle";
import { runProductUninstall } from "@chatgpt-tela/product-uninstall";
import { parsePackagedLifecycleCommand, runPackagedLifecycleCommand, type PackagedLifecycleOptions } from "./lifecycle";
import { packagedPayloadFingerprint, readPackagedProductManifest } from "@chatgpt-tela/product-lifecycle";
import { resolvePackagedMenuBarLaunch } from "./runtime";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import { ChatServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";

async function maintenanceChatClient(options: PackagedLifecycleOptions): Promise<ChatServiceClient> {
  const paths = resolveProductPaths(options);
  const owner = readOwnershipManifest(paths.installManifest);
  if (!owner) throw Error("No owned Tela installation");
  const current = await new LocalServiceSupervisor({ installId: owner.installId }).current({
    service: "chat", descriptorPath: join(paths.serviceRuntime("chat"), "descriptor.json") });
  if (!current || current.status.state !== "ready") throw Error("Chat service is unavailable for maintenance");
  return new ChatServiceClient(descriptorForService(current.descriptor, "chat"));
}

const OWNER = "maintenance-owner.json";
function digest(data: string | Buffer): string { return createHash("sha256").update(data).digest("hex"); }
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("maintenance result must be an object");
  return value as Record<string, any>;
}
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Review/status are read-only; explicit apply uses the normal owned lifecycle. */
export async function runMaintenanceCommand(args: readonly string[], options: PackagedLifecycleOptions & { executingBinaryPath?: string } = {}) {
  if (args[0] !== "maintenance") throw new Error("expected maintenance command");
  const paths = resolveProductPaths({ platform: options.platform ?? process.platform,
    ...(options.home ? { home: options.home } : {}), ...(options.environment ? { environment: options.environment } : {}) });
  if (args[1] === "status" && args.length === 2) {
    const ownership = readOwnershipManifest(paths.installManifest);
    const upgrade = readPackagedUpgradeJournal(packagedUpgradeJournalPath(paths));
    return { installedVersion: ownership?.productVersion ?? "Not installed", pendingTransition:
      upgrade ? "upgrade" : readPackagedRepairJournal(packagedRepairJournalPath(paths)) ? "repair" : "none",
      ...(upgrade ? {
        cancellationReviewAvailable: ["prepared", "quiescing", "quiesced", "restoring-source"].includes(upgrade.phase),
        ...((options.platform ?? process.platform) === "darwin" ? { appReopenState:
          upgrade.phase === "manifest-updated" && upgrade.resumeServices.every(service => upgrade.resumedServices.includes(service))
            ? "unverified" : "not-attempted" } : {}),
      } : {}) };
  }
  if (args[1] === "processes" && args.length === 2) {
    const client = await maintenanceChatClient(options);
    try { return { processes: await client.maintenanceProcesses() }; }
    finally { await client.close(); }
  }
  if (args[1] === "cancel-process" && args.length === 4) {
    const [, , workspaceId, operationId] = args;
    const client = await maintenanceChatClient(options);
    try { return { result: await client.call("cancel_process", { workspace_id: workspaceId!, operation_id: operationId! }) }; }
    finally { await client.close(); }
  }
  const mode = args[1], operation = args[2];
  if (!(mode === "review" || mode === "apply") || !(operation === "upgrade" || operation === "repair" || operation === "cancel-upgrade" || operation === "uninstall")) {
    throw new Error("usage: maintenance <review|apply> <upgrade|repair|cancel-upgrade|uninstall> [--payload folder] [--remove-data] [--review-token token]");
  }
  const rest = [...args.slice(3)];
  const tokenIndex = rest.indexOf("--review-token");
  const token = tokenIndex < 0 ? undefined : rest[tokenIndex + 1];
  if (tokenIndex >= 0) rest.splice(tokenIndex, 2);
  if (mode === "apply" && (!token || !/^[a-f0-9]{64}$/.test(token))) throw new Error("review the operation before applying it");
  if (mode === "review" && token !== undefined) throw new Error("review does not accept a previous token");
  if (rest.includes("--apply") || rest.includes("--dry-run")) throw new Error("maintenance mode is explicit");
  if (operation === "uninstall" && (rest.length > 1 || rest.some(x => x !== "--remove-data"))) throw new Error("uninstall only accepts --remove-data");
  const removeData = rest.includes("--remove-data");
  if (operation !== "uninstall" && !rest.includes("--payload")) {
    throw new Error("maintenance requires an explicit package");
  }
  const raw = record(operation === "uninstall"
    ? await runProductUninstall({ mode: "dry-run", removeData, ...options, ...(options.runner ? { serviceRegistrationRunner: options.runner } : {}) })
    : await runPackagedLifecycleCommand([operation, "--dry-run", ...rest], options));
  // Bind the review to the complete plan and exact package bytes.
  const identity = operation === "uninstall" ? []
    : [packagedPayloadFingerprint(realpathSync(rest[rest.indexOf("--payload") + 1]!))];
  // Readiness is a live observation, not part of the reviewed package plan.
  // Apply rechecks it before any service is stopped.
  const { shutdownBlockers: _shutdownBlockers, ...reviewedPlan } = raw;
  const reviewToken = digest(canonical({ operation, raw: reviewedPlan, identity }));
  if (mode === "apply") {
    if (token !== reviewToken) throw new Error("The installation or package changed. Review the operation again.");
    const blockers = Array.isArray(raw.shutdownBlockers) ? raw.shutdownBlockers.filter((item: unknown): item is string => typeof item === "string") : [];
    if (blockers.length) return { operation, success: false, removedCount: 0, preservedCount: 0, failedCount: 0,
      productVersion: readOwnershipManifest(paths.installManifest)?.productVersion ?? null, blockers };
    let result: Record<string, any>;
    try {
      result = record(operation === "uninstall"
        ? await runProductUninstall({ mode: "apply", removeData, ...options, ...(options.runner ? { serviceRegistrationRunner: options.runner } : {}) })
        : await runPackagedLifecycleCommand([operation, "--apply", ...rest], options));
    } catch (error) {
      const blockerMessage = error instanceof PackagedServiceShutdownNotStartedError ? error.message
        : error instanceof PackagedUpgradeRecoveryError && error.recoveryState === "source-restored"
          && error.cause instanceof PackagedServiceShutdownNotStartedError ? error.message
          : error instanceof PackagedUpgradeRecoveryError ? error.message : undefined;
      if (!blockerMessage) throw error;
      const osFailure = error instanceof PackagedUpgradeRecoveryError && error.cause instanceof PackagedServiceTransitionError
        ? error.cause.message : undefined;
      return { operation, success: false, removedCount: 0, preservedCount: 0, failedCount: 0,
        productVersion: readOwnershipManifest(paths.installManifest)?.productVersion ?? null,
        blockers: osFailure ? [blockerMessage, osFailure] : [blockerMessage] };
    }
    const failed = Number(result.failedCount ?? 0) + (Array.isArray(result.shutdownFailures) ? result.shutdownFailures.length : 0);
    const preservedRepair = operation === "repair" && (result.payload === "preserved" || result.services?.some((s: any) => s.outcome === "preserved"));
    const preserved = operation === "repair" ? Number(result.payload === "preserved") + (result.services?.filter((s: any) => s.outcome === "preserved").length ?? 0) : result.preservedCount ?? 0;
    return { operation, success: failed === 0 && !preservedRepair,
      removedCount: result.removedCount ?? 0, preservedCount: preserved, failedCount: failed,
      productVersion: result.toVersion ?? result.productVersion ?? null };
  }
  const resources: { name: string; action: string }[] = [];
  if (operation === "uninstall") {
    for (const step of raw.steps ?? []) resources.push({ name: step.resourceId, action: step.action });
  } else {
    resources.push({ name: "Tela files", action: raw.payload?.action ?? "review" });
    for (const service of raw.services ?? []) resources.push(operation === "cancel-upgrade"
      ? { name: service, action: "restore-if-stopped" }
      : { name: service.service, action: service.action });
  }
  return { operation, reviewToken, fromVersion: readOwnershipManifest(paths.installManifest)?.productVersion ?? "Not installed",
    toVersion: raw.toVersion ?? raw.productVersion ?? null, removeData, resources,
    blockers: [...(raw.activityBlockers ?? []), ...(raw.shutdownBlockers ?? [])],
    interruptedConnections: operation === "cancel-upgrade" ? false : operation !== "uninstall" || (raw.removableCount ?? 0) > 0 };
}

/** Stage only previously verified product executables, outside the install's removal boundary. */
export function stageMaintenanceWindow(input: { launcher: string; ui: string; temporaryRoot?: string }) {
  const root = mkdtempSync(join(input.temporaryRoot ?? tmpdir(), "chatgpt-tela-maintenance-"));
  chmodSync(root, 0o700);
  try {
    const files: Record<string, string> = {};
    for (const [name, source] of [["launcher", input.launcher], ["maintenance-ui", input.ui]] as const) {
      if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error("maintenance source must be a regular file");
      const expected = digest(readFileSync(source));
      copyFileSync(source, join(root, name)); chmodSync(join(root, name), 0o700);
      if (digest(readFileSync(join(root, name))) !== expected) throw new Error("maintenance executable changed while staging");
      files[name] = expected;
    }
    writeFileSync(join(root, OWNER), JSON.stringify({ version: 1, files }), { mode: 0o600 });
    return root;
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

export function cleanupMaintenanceWindow(root: string): void {
  const absolute = resolve(root);
  if (!basename(absolute).startsWith("chatgpt-tela-maintenance-") || lstatSync(absolute).isSymbolicLink()
    || realpathSync(dirname(absolute)) !== realpathSync(tmpdir())) throw new Error("unsafe maintenance workspace");
  const stat = lstatSync(absolute), marker = lstatSync(join(absolute, OWNER));
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()
    || !marker.isFile() || marker.isSymbolicLink()) throw new Error("unsafe maintenance ownership");
  const owner = record(JSON.parse(readFileSync(join(absolute, OWNER), "utf8")));
  if (owner.version !== 1 || canonical(Object.keys(owner.files ?? {}).sort()) !== canonical(["launcher", "maintenance-ui"])) throw new Error("unknown maintenance ownership");
  if (readdirSync(absolute).sort().join(",") !== [OWNER, "launcher", "maintenance-ui"].sort().join(",")) throw new Error("maintenance workspace has unknown files");
  for (const [name, expected] of Object.entries(owner.files)) {
    const file = join(absolute, name);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || digest(readFileSync(file)) !== expected) throw new Error("maintenance workspace ownership changed");
  }
  rmSync(absolute, { recursive: true, force: false });
}

export async function resolveMaintenanceWindowSource(payloadRoot: string, launcherExecutablePath: string, repairSourceArguments: readonly string[] = [], options: PackagedLifecycleOptions = {}) {
    if (repairSourceArguments.length === 0) {
      const verified = resolvePackagedMenuBarLaunch({ payloadRoot, launcherExecutablePath });
      return { launcher: launcherExecutablePath, ui: verified.executable };
    }
    const sourceArgs = [...repairSourceArguments];
    const operationIndex = sourceArgs.indexOf("--operation");
    const operation = operationIndex < 0 ? "repair" : sourceArgs[operationIndex + 1];
    if (!(operation === "repair" || operation === "upgrade" || operation === "cancel-upgrade")) {
      throw new Error("maintenance source operation must be repair, upgrade, or cancel-upgrade");
    }
    if (operationIndex >= 0) sourceArgs.splice(operationIndex, 2);
    const args = [operation, "--dry-run", ...sourceArgs];
    const parsed = parsePackagedLifecycleCommand(args);
    if (!parsed.payloadSourcePath) throw new Error("an explicit repair package is required");
    await runPackagedLifecycleCommand(args, options);
    const source = realpathSync(parsed.payloadSourcePath), manifest = readPackagedProductManifest(source);
    if (!manifest.launcher || !manifest.menuBar) throw new Error("repair package has no maintenance UI");
    return { launcher: join(source, manifest.launcher.executable), ui: join(source, manifest.menuBar.executable) };
}

export async function openMaintenanceWindow(payloadRoot: string, launcherExecutablePath: string, repairSourceArguments: readonly string[] = []) {
  if (process.platform !== "darwin") throw new Error("maintenance window requires macOS");
  // Damaged installs use a separately signed repair package, never unproven installed UI bytes.
  const verify = () => resolveMaintenanceWindowSource(payloadRoot, launcherExecutablePath, repairSourceArguments);
  const verified = await verify();
  const root = stageMaintenanceWindow(verified);
  try {
    await verify();
    const snapshot = record(JSON.parse(readFileSync(join(root, OWNER), "utf8")));
    if (digest(readFileSync(verified.launcher)) !== snapshot.files.launcher
      || digest(readFileSync(verified.ui)) !== snapshot.files["maintenance-ui"]) throw new Error("verified executables changed while staging");
    const child = spawn(join(root, "maintenance-ui"), ["--maintenance-only"], { detached: true, stdio: "ignore",
      env: { ...process.env, CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE: join(root, "launcher"), CHATGPT_TELA_MAINTENANCE_WORKSPACE: root } });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return { opened: true };
  } catch (error) { cleanupMaintenanceWindow(root); throw error; }
}
