import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readOwnershipManifest, resolveProductPaths, readPackagedUpgradeJournal, readPackagedRepairJournal,
  packagedUpgradeJournalPath, packagedRepairJournalPath, readMacApplicationUpdate, PackagedServiceShutdownNotStartedError } from "@chatgpt-tela/product-lifecycle";
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
      readMacApplicationUpdate(paths) ? "application-update" : upgrade ? "upgrade" : readPackagedRepairJournal(packagedRepairJournalPath(paths)) ? "repair" : "none" };
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
  if (!(mode === "review" || mode === "apply") || !(operation === "repair" || operation === "uninstall")) {
    throw new Error("usage: maintenance <review|apply> <repair|uninstall> [--payload folder] [--remove-data] [--review-token token]");
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
      if (!(error instanceof PackagedServiceShutdownNotStartedError)) throw error;
      return { operation, success: false, removedCount: 0, preservedCount: 0, failedCount: 0,
        productVersion: readOwnershipManifest(paths.installManifest)?.productVersion ?? null,
        blockers: [error.message] };
    }
    const failed = Number(result.failedCount ?? 0) + (Array.isArray(result.shutdownFailures) ? result.shutdownFailures.length : 0);
    const preservedRepair = operation === "repair" && (result.payload === "preserved" || result.services?.some((s: any) => s.outcome === "preserved"));
    const preserved = operation === "repair" ? Number(result.payload === "preserved") + (result.services?.filter((s: any) => s.outcome === "preserved").length ?? 0) : result.preservedCount ?? 0;
    return { operation, success: failed === 0 && !preservedRepair,
      removedCount: result.removedCount ?? 0, preservedCount: preserved, failedCount: failed,
      productVersion: result.toVersion ?? result.productVersion ?? null,
      ...(operation === "uninstall" ? { accountCleanup: {
        status: "not-performed",
        message: "Local removal does not remove the ChatGPT plugin or separately connected MCP integrations. Manage them in ChatGPT if needed.",
      } } : {}) };
  }
  const resources: { name: string; action: string }[] = [];
  if (operation === "uninstall") {
    for (const step of raw.steps ?? []) resources.push({ name: step.resourceId, action: step.action });
  } else {
    resources.push({ name: "Tela files", action: raw.payload?.action ?? "review" });
    for (const service of raw.services ?? []) resources.push({ name: service.service, action: service.action });
  }
  return { operation, reviewToken, fromVersion: readOwnershipManifest(paths.installManifest)?.productVersion ?? "Not installed",
    toVersion: raw.toVersion ?? raw.productVersion ?? null, removeData, resources,
    blockers: [...(raw.activityBlockers ?? []), ...(raw.shutdownBlockers ?? [])],
    interruptedConnections: operation !== "uninstall" || (raw.removableCount ?? 0) > 0 };
}

function maintenanceApp(executable: string): string {
  const directory = dirname(executable);
  if (basename(directory) !== "MacOS" || basename(dirname(directory)) !== "Contents") throw Error("maintenance UI must be an application executable");
  return dirname(dirname(directory));
}

/** Preserve a small, signed helper app outside the files being repaired or removed. */
export function stageMaintenanceWindow(input: { launcher: string; ui: string; temporaryRoot?: string }) {
  const root = mkdtempSync(join(input.temporaryRoot ?? tmpdir(), "chatgpt-tela-maintenance-"));
  chmodSync(root, 0o700);
  try {
    const app = maintenanceApp(input.ui);
    const files = { launcher: digest(readFileSync(input.launcher)), "Maintenance.app": packagedPayloadFingerprint(app) };
    copyFileSync(input.launcher, join(root, "launcher")); chmodSync(join(root, "launcher"), 0o700);
    cpSync(app, join(root, "Maintenance.app"), { recursive: true, verbatimSymlinks: true });
    if (digest(readFileSync(join(root, "launcher"))) !== files.launcher
      || packagedPayloadFingerprint(join(root, "Maintenance.app")) !== files["Maintenance.app"]) throw Error("maintenance source changed while staging");
    writeFileSync(join(root, OWNER), JSON.stringify({ version: 2, files }), { mode: 0o600 });
    return root;
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

export function cleanupMaintenanceWindow(root: string): void {
  const absolute = resolve(root);
  if (!basename(absolute).startsWith("chatgpt-tela-maintenance-") || lstatSync(absolute).isSymbolicLink()
    || realpathSync(dirname(absolute)) !== realpathSync(tmpdir())) throw Error("unsafe maintenance workspace");
  const stat = lstatSync(absolute), marker = lstatSync(join(absolute, OWNER));
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()
    || !marker.isFile() || marker.isSymbolicLink()) throw Error("unsafe maintenance ownership");
  const owner = record(JSON.parse(readFileSync(join(absolute, OWNER), "utf8")));
  if (owner.version !== 2 || canonical(Object.keys(owner.files ?? {}).sort()) !== canonical(["Maintenance.app", "launcher"])) throw Error("unknown maintenance ownership");
  if (readdirSync(absolute).sort().join(",") !== [OWNER, "launcher", "Maintenance.app"].sort().join(",")) throw Error("maintenance workspace has unknown files");
  const launcher = join(absolute, "launcher");
  if (!lstatSync(launcher).isFile() || lstatSync(launcher).isSymbolicLink() || digest(readFileSync(launcher)) !== owner.files.launcher
    || packagedPayloadFingerprint(join(absolute, "Maintenance.app")) !== owner.files["Maintenance.app"]) throw Error("maintenance workspace ownership changed");
  rmSync(absolute, { recursive: true, force: false });
}

export async function resolveMaintenanceWindowSource(payloadRoot: string, launcherExecutablePath: string, repairSourceArguments: readonly string[] = [], options: PackagedLifecycleOptions = {}) {
    if (repairSourceArguments.length === 0) {
      resolvePackagedMenuBarLaunch({ payloadRoot, launcherExecutablePath });
      const manifest = readPackagedProductManifest(payloadRoot);
      if (!manifest.menuBar?.maintenanceExecutable) throw new Error("package has no maintenance UI");
      return { launcher: launcherExecutablePath, ui: join(payloadRoot, manifest.menuBar.maintenanceExecutable), operation: "repair", payload: undefined };
    }
    const args = ["repair", "--dry-run", ...repairSourceArguments];
    const parsed = parsePackagedLifecycleCommand(args);
    if (!parsed.payloadSourcePath) throw new Error("an explicit repair package is required");
    await runPackagedLifecycleCommand(args, options);
    const source = realpathSync(parsed.payloadSourcePath), manifest = readPackagedProductManifest(source);
    if (!manifest.launcher || !manifest.menuBar?.maintenanceExecutable) throw new Error("repair package has no maintenance UI");
    return { launcher: join(source, manifest.launcher.executable), ui: join(source, manifest.menuBar.maintenanceExecutable), operation: "repair", payload: source };
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
      || packagedPayloadFingerprint(maintenanceApp(verified.ui)) !== snapshot.files["Maintenance.app"]) throw new Error("verified executables changed while staging");
    const args = ["-n", "-a", join(root, "Maintenance.app"),
      "--env", `CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE=${join(root, "launcher")}`,
      "--env", `CHATGPT_TELA_MAINTENANCE_WORKSPACE=${root}`,
      "--env", `CHATGPT_TELA_MAINTENANCE_OPERATION=${verified.operation}`,
      ...(verified.payload ? ["--env", `CHATGPT_TELA_MAINTENANCE_PAYLOAD=${verified.payload}`] : []), "--args", "--maintenance-only"];
    const child = spawn("/usr/bin/open", args, { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(Error("maintenance app launch was refused")));
    });
    return { opened: true };
  } catch (error) { cleanupMaintenanceWindow(root); throw error; }
}
