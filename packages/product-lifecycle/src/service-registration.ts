import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  parseOwnedResource,
  readOwnershipManifest,
  type OwnedResource,
  type OwnershipManifest,
  type ServiceRegistrationIdentity,
  type ServiceRegistrationPlatform,
} from "./ownership";
import { registerOwnedResource } from "./ownership-store";
import type { OwnershipObservation, UninstallObserver } from "./uninstall";

const COMMAND_TIMEOUT_MS = 10_000;

export interface ServiceRegistrationCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ServiceRegistrationCommandRunner {
  run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult>;
}

export class SystemServiceRegistrationCommandRunner implements ServiceRegistrationCommandRunner {
  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    const result = spawnSync(command, [...arguments_], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw result.error;
    return Object.freeze({
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? (result.error ? String(result.error) : ""),
    });
  }
}

interface ServiceRegistrationMarker {
  readonly version: 1;
  readonly installId: string;
  readonly resourceId: string;
  readonly registrationId: string;
  readonly platform: ServiceRegistrationPlatform;
  readonly definitionFingerprint: string;
}

type ServiceRegistrationResource = Extract<OwnedResource, { readonly kind: "service-registration" }>;

export type ServiceRegistrationDefinition =
  | {
      readonly platform: "darwin" | "linux";
      readonly content: string;
    }
  | {
      readonly platform: "win32";
      readonly executable: string;
      readonly arguments: string;
      readonly workingDirectory: string;
    };

function fingerprint(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function singleLine(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value.trim();
}

function singleLineAllowEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function marker(value: unknown): ServiceRegistrationMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("service registration marker is invalid");
  const item = value as Record<string, unknown>;
  if (item.version !== 1) throw new Error("service registration marker version is unsupported");
  const platform = item.platform;
  if (!(platform === "darwin" || platform === "win32" || platform === "linux")) {
    throw new Error("service registration marker platform is invalid");
  }
  const definitionFingerprint = singleLine(item.definitionFingerprint, "service registration marker fingerprint");
  if (!/^[a-f0-9]{64}$/.test(definitionFingerprint)) throw new Error("service registration marker fingerprint is invalid");
  return Object.freeze({
    version: 1,
    installId: singleLine(item.installId, "service registration marker install id"),
    resourceId: singleLine(item.resourceId, "service registration marker resource id"),
    registrationId: singleLine(item.registrationId, "service registration marker registration id"),
    platform,
    definitionFingerprint,
  });
}

function readMarker(path: string): ServiceRegistrationMarker | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("service registration marker path is unsafe or replaced");
  return marker(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function writeMarker(path: string, value: ServiceRegistrationMarker): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
}

function sameMarker(left: ServiceRegistrationMarker, right: ServiceRegistrationMarker): boolean {
  return left.version === right.version
    && left.installId === right.installId
    && left.resourceId === right.resourceId
    && left.registrationId === right.registrationId
    && left.platform === right.platform
    && left.definitionFingerprint === right.definitionFingerprint;
}

function fileFingerprint(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("service definition path is unsafe or replaced");
  return fingerprint(readFileSync(path));
}

interface WindowsTaskEvidence {
  readonly name: string;
  readonly taskPath: "\\";
  readonly executable: string;
  readonly arguments: string;
  readonly workingDirectory: string;
  readonly logonType: "Interactive";
  readonly runLevel: "Limited";
  readonly enabled: true;
}

function canonicalWindowsEvidence(value: unknown, expectedName: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows scheduled-task evidence is invalid");
  const item = value as Record<string, unknown>;
  if (item.enabled !== true) throw new Error("Windows scheduled-task must be enabled");
  const evidence: WindowsTaskEvidence = Object.freeze({
    name: singleLine(item.name, "Windows scheduled-task name"),
    taskPath: singleLine(item.taskPath, "Windows scheduled-task path") as "\\",
    executable: singleLine(item.executable, "Windows scheduled-task executable"),
    arguments: singleLineAllowEmpty(item.arguments, "Windows scheduled-task arguments"),
    workingDirectory: singleLine(item.workingDirectory, "Windows scheduled-task working directory"),
    logonType: singleLine(item.logonType, "Windows scheduled-task logon type") as "Interactive",
    runLevel: singleLine(item.runLevel, "Windows scheduled-task run level") as "Limited",
    enabled: true,
  });
  if (evidence.name.toLowerCase() !== expectedName.toLowerCase()) throw new Error("Windows scheduled task returned a different registration id");
  if (evidence.taskPath !== "\\" || evidence.logonType !== "Interactive" || evidence.runLevel !== "Limited" || evidence.enabled !== true) {
    throw new Error("Windows scheduled-task execution identity is invalid");
  }
  return JSON.stringify(evidence);
}

function desiredWindowsEvidence(
  registrationId: string,
  definition: Extract<ServiceRegistrationDefinition, { readonly platform: "win32" }>,
): string {
  return canonicalWindowsEvidence({
    name: registrationId,
    taskPath: "\\",
    executable: singleLine(definition.executable, "Windows scheduled-task executable"),
    arguments: singleLineAllowEmpty(definition.arguments, "Windows scheduled-task arguments"),
    workingDirectory: singleLine(definition.workingDirectory, "Windows scheduled-task working directory"),
    logonType: "Interactive",
    runLevel: "Limited",
    enabled: true,
  }, registrationId);
}

async function windowsFingerprint(
  runner: ServiceRegistrationCommandRunner,
  registrationId: string,
): Promise<{ readonly exists: boolean; readonly fingerprint?: string }> {
  const script = [
    "$t=Get-ScheduledTask -TaskName $args[0] -TaskPath '\\' -ErrorAction SilentlyContinue;",
    "if ($null -eq $t) { exit 3 };",
    "$a=@($t.Actions); if($a.Count -ne 1){ exit 4 };",
    "[pscustomobject]@{name=$t.TaskName;taskPath=$t.TaskPath;executable=$a[0].Execute;arguments=[string]$a[0].Arguments;workingDirectory=$a[0].WorkingDirectory;logonType=$t.Principal.LogonType.ToString();runLevel=$t.Principal.RunLevel.ToString();enabled=[bool]$t.Settings.Enabled} | ConvertTo-Json -Compress",
  ].join(" ");
  const result = await runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, registrationId]);
  if (result.exitCode === 3) return Object.freeze({ exists: false });
  if (result.exitCode !== 0) throw new Error(`Windows scheduled-task inspection failed: ${result.stderr.trim().slice(0, 240)}`);
  let value: unknown;
  try { value = JSON.parse(result.stdout) as unknown; }
  catch (error) { throw new Error("Windows scheduled-task inspection returned invalid JSON", { cause: error }); }
  return Object.freeze({ exists: true, fingerprint: fingerprint(canonicalWindowsEvidence(value, registrationId)) });
}

async function serviceLoaded(
  resource: ServiceRegistrationResource,
  runner: ServiceRegistrationCommandRunner,
): Promise<boolean> {
  const identity = resource.identity;
  if (!identity) return false;
  if (identity.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid === undefined) throw new Error("macOS service inspection requires a user id");
    return (await runner.run("/bin/launchctl", ["print", `gui/${uid}/${resource.registrationId}`])).exitCode === 0;
  }
  if (identity.platform === "linux") {
    const result = await runner.run("systemctl", ["--user", "show", "--property=LoadState", "--value", resource.registrationId]);
    return result.exitCode === 0 && result.stdout.trim() !== "not-found" && result.stdout.trim() !== "";
  }
  return (await windowsFingerprint(runner, resource.registrationId)).exists;
}

async function linuxServiceEnabled(
  runner: ServiceRegistrationCommandRunner,
  registrationId: string,
): Promise<boolean> {
  const result = await runner.run("systemctl", ["--user", "is-enabled", registrationId]);
  return result.exitCode === 0 && result.stdout.trim() === "enabled";
}

async function currentDefinitionFingerprint(
  resource: ServiceRegistrationResource,
  runner: ServiceRegistrationCommandRunner,
): Promise<string | undefined> {
  const identity = resource.identity;
  if (!identity) return undefined;
  if (identity.platform === "win32") return (await windowsFingerprint(runner, resource.registrationId)).fingerprint;
  return fileFingerprint(identity.definitionPath!);
}

function exactMarker(
  resource: ServiceRegistrationResource,
  manifest: OwnershipManifest,
): ServiceRegistrationMarker | undefined {
  const identity = resource.identity;
  if (!identity) return undefined;
  const current = readMarker(identity.markerPath);
  if (!current) return undefined;
  const recorded = manifest.resources.find(candidate => candidate.id === resource.id);
  if (!recorded || JSON.stringify(recorded) !== JSON.stringify(resource)) {
    throw new Error("service registration marker exists without matching manifest authority");
  }
  if (current.installId !== manifest.installId
    || current.resourceId !== resource.id
    || current.registrationId !== resource.registrationId
    || current.platform !== identity.platform
    || current.definitionFingerprint !== identity.definitionFingerprint) {
    throw new Error("service registration ownership marker drifted");
  }
  return current;
}

function expectedMarker(resource: ServiceRegistrationResource, installId: string): ServiceRegistrationMarker {
  const identity = resource.identity;
  if (!identity) throw new Error("service registration resource has no ownership identity");
  return Object.freeze({
    version: 1,
    installId,
    resourceId: resource.id,
    registrationId: resource.registrationId,
    platform: identity.platform,
    definitionFingerprint: identity.definitionFingerprint,
  });
}

export function serviceRegistrationResourceForDefinition(input: {
  readonly resourceId: string;
  readonly owner: "product" | "gateway" | "chat" | "codex";
  readonly registrationId: string;
  readonly markerPath: string;
  readonly definitionPath?: string;
  readonly definition: ServiceRegistrationDefinition;
}): ServiceRegistrationResource {
  let definitionFingerprint: string;
  if (input.definition.platform === "win32") {
    if (input.definitionPath !== undefined) throw new Error("Windows scheduled-task definition must not use a definition path");
    definitionFingerprint = fingerprint(desiredWindowsEvidence(input.registrationId, input.definition));
  } else {
    if (!input.definitionPath) throw new Error(`${input.definition.platform} service definition requires a definition path`);
    definitionFingerprint = fingerprint(input.definition.content);
  }
  return parseOwnedResource({
    kind: "service-registration",
    id: input.resourceId,
    owner: input.owner,
    registrationId: input.registrationId,
    identity: {
      platform: input.definition.platform,
      markerPath: input.markerPath,
      definitionFingerprint,
      ...(input.definitionPath ? { definitionPath: input.definitionPath } : {}),
    },
  }) as ServiceRegistrationResource;
}

export async function reserveServiceRegistrationOwnership(input: {
  readonly manifestPath: string;
  readonly installId: string;
  readonly productVersion: string;
  readonly resource: ServiceRegistrationResource;
}): Promise<void> {
  const identity = input.resource.identity;
  if (!identity) throw new Error("service registration resource has no ownership identity");
  const marker = expectedMarker(input.resource, input.installId);
  if (existsSync(identity.markerPath)) {
    const existing = readMarker(identity.markerPath);
    if (!existing || !sameMarker(existing, marker)) {
      throw new Error("service registration marker path is already occupied by different ownership state");
    }
  }
  await registerOwnedResource({
    path: input.manifestPath,
    installId: input.installId,
    productVersion: input.productVersion,
    resource: input.resource,
  });
  if (!existsSync(identity.markerPath)) writeMarker(identity.markerPath, marker);
}

function writeDefinitionFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
}

export class ServiceRegistrationInstaller {
  readonly #runner: ServiceRegistrationCommandRunner;
  readonly #platform: NodeJS.Platform;

  constructor(input: {
    readonly runner?: ServiceRegistrationCommandRunner;
    readonly platform?: NodeJS.Platform;
  } = {}) {
    this.#runner = input.runner ?? new SystemServiceRegistrationCommandRunner();
    this.#platform = input.platform ?? process.platform;
  }

  async observeReady(resource: ServiceRegistrationResource, manifest: OwnershipManifest): Promise<OwnershipObservation> {
    const identity = resource.identity;
    if (!identity || identity.platform !== this.#platform) return "unknown";
    let marker: ServiceRegistrationMarker | undefined;
    try { marker = exactMarker(resource, manifest); }
    catch { return "ownership-drift"; }

    if (identity.platform === "win32") {
      let current;
      try { current = await windowsFingerprint(this.#runner, resource.registrationId); }
      catch { return "unknown"; }
      if (!marker) return current.exists ? "ownership-drift" : "missing";
      if (!current.exists) return "missing";
      return current.fingerprint === identity.definitionFingerprint ? "owned" : "ownership-drift";
    }

    let currentFingerprint: string | undefined;
    let loaded = false;
    let enabled = true;
    try {
      currentFingerprint = fileFingerprint(identity.definitionPath!);
      loaded = await serviceLoaded(resource, this.#runner);
      if (identity.platform === "linux") enabled = await linuxServiceEnabled(this.#runner, resource.registrationId);
    } catch {
      return "unknown";
    }
    if (!marker) return currentFingerprint === undefined && !loaded ? "missing" : "ownership-drift";
    if (currentFingerprint === undefined) return loaded ? "ownership-drift" : "missing";
    if (currentFingerprint !== identity.definitionFingerprint) return "ownership-drift";
    return loaded && enabled ? "owned" : "missing";
  }

  async install(input: {
    readonly manifestPath: string;
    readonly manifest: OwnershipManifest;
    readonly resource: ServiceRegistrationResource;
    readonly definition: ServiceRegistrationDefinition;
  }): Promise<{ readonly created: boolean; readonly detail: string }> {
    const identity = input.resource.identity;
    if (!identity) throw new Error("service registration resource has no ownership identity");
    if (identity.platform !== this.#platform || input.definition.platform !== identity.platform) {
      throw new Error("service registration platform does not match the installer platform");
    }
    const expected = serviceRegistrationResourceForDefinition({
      resourceId: input.resource.id,
      owner: input.resource.owner,
      registrationId: input.resource.registrationId,
      markerPath: identity.markerPath,
      ...(identity.definitionPath ? { definitionPath: identity.definitionPath } : {}),
      definition: input.definition,
    });
    if (JSON.stringify(expected) !== JSON.stringify(input.resource)) {
      throw new Error("service registration definition does not match the desired ownership resource");
    }

    const before = await this.observeReady(input.resource, input.manifest);
    if (before === "owned") return Object.freeze({ created: false, detail: "exact service registration already installed" });
    if (before !== "missing") throw new Error(`service registration cannot be installed from ${before} state`);

    await reserveServiceRegistrationOwnership({
      manifestPath: input.manifestPath,
      installId: input.manifest.installId,
      productVersion: input.manifest.productVersion,
      resource: input.resource,
    });
    const reservedManifest = readOwnershipManifest(input.manifestPath);
    if (!reservedManifest || reservedManifest.installId !== input.manifest.installId) {
      throw new Error("service registration ownership intent was not persisted");
    }

    let mutated = false;
    if (identity.platform === "win32") {
      const definition = input.definition as Extract<ServiceRegistrationDefinition, { readonly platform: "win32" }>;
      const current = await windowsFingerprint(this.#runner, input.resource.registrationId);
      if (current.exists && current.fingerprint !== identity.definitionFingerprint) {
        throw new Error("Windows scheduled-task name is occupied by a different definition");
      }
      if (!current.exists) {
        const script = [
          "$name=$args[0]; $exe=$args[1]; $arguments=$args[2]; $working=$args[3];",
          "if($null -ne (Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue)){ exit 6 };",
          "$action=New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $working;",
          "$principal=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;",
          "Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $action -Principal $principal -ErrorAction Stop | Out-Null",
        ].join(" ");
        const created = await this.#runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script,
          input.resource.registrationId, definition.executable, definition.arguments, definition.workingDirectory]);
        if (created.exitCode !== 0) throw new Error(`Windows scheduled-task creation failed: ${created.stderr.trim().slice(0, 240)}`);
        mutated = true;
      }
    } else {
      const definition = input.definition as Extract<ServiceRegistrationDefinition, { readonly platform: "darwin" | "linux" }>;
      const definitionPath = identity.definitionPath!;
      const currentFingerprint = fileFingerprint(definitionPath);
      if (currentFingerprint !== undefined && currentFingerprint !== identity.definitionFingerprint) {
        throw new Error("service definition path is occupied by different content");
      }
      if (currentFingerprint === undefined) {
        writeDefinitionFile(definitionPath, definition.content);
        mutated = true;
      }
      const loaded = await serviceLoaded(input.resource, this.#runner);
      const enabled = identity.platform === "linux"
        ? await linuxServiceEnabled(this.#runner, input.resource.registrationId)
        : true;
      if (!loaded || !enabled) {
        if (identity.platform === "darwin") {
          const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
          if (uid === undefined) throw new Error("macOS service install requires a user id");
          const result = await this.#runner.run("/bin/launchctl", ["bootstrap", `gui/${uid}`, definitionPath]);
          if (result.exitCode !== 0) throw new Error(`launchd registration failed: ${result.stderr.trim().slice(0, 240)}`);
        } else {
          const reload = await this.#runner.run("systemctl", ["--user", "daemon-reload"]);
          if (reload.exitCode !== 0) throw new Error(`systemd daemon-reload failed: ${reload.stderr.trim().slice(0, 240)}`);
          const enable = await this.#runner.run("systemctl", ["--user", "enable", input.resource.registrationId]);
          if (enable.exitCode !== 0) throw new Error(`systemd enable failed: ${enable.stderr.trim().slice(0, 240)}`);
        }
        mutated = true;
      }
    }

    if (await this.observeReady(input.resource, reservedManifest) !== "owned") {
      throw new Error("service registration verification failed after install");
    }
    return Object.freeze({ created: mutated, detail: mutated
      ? "service registration installed and verified"
      : "service registration recovered and verified" });
  }
}

export class ServiceRegistrationManager {
  readonly #runner: ServiceRegistrationCommandRunner;
  readonly #platform: NodeJS.Platform;

  constructor(input: {
    readonly runner?: ServiceRegistrationCommandRunner;
    readonly platform?: NodeJS.Platform;
  } = {}) {
    this.#runner = input.runner ?? new SystemServiceRegistrationCommandRunner();
    this.#platform = input.platform ?? process.platform;
  }

  async observe(resource: ServiceRegistrationResource, manifest: OwnershipManifest): Promise<OwnershipObservation> {
    const identity = resource.identity;
    if (!identity) return "unknown";
    if (identity.platform !== this.#platform) return "unknown";
    let ownedMarker: ServiceRegistrationMarker | undefined;
    try { ownedMarker = exactMarker(resource, manifest); }
    catch { return "ownership-drift"; }
    let currentFingerprint: string | undefined;
    let loaded: boolean;
    try {
      [currentFingerprint, loaded] = await Promise.all([
        currentDefinitionFingerprint(resource, this.#runner),
        serviceLoaded(resource, this.#runner),
      ]);
    } catch {
      return "unknown";
    }
    if (!ownedMarker) return currentFingerprint === undefined && !loaded ? "missing" : "ownership-drift";
    if (currentFingerprint === undefined) return loaded ? "ownership-drift" : "owned";
    return currentFingerprint === identity.definitionFingerprint ? "owned" : "ownership-drift";
  }

  async release(resource: ServiceRegistrationResource, manifest: OwnershipManifest): Promise<{ readonly removed: boolean; readonly detail: string }> {
    if (await this.observe(resource, manifest) !== "owned") {
      return Object.freeze({ removed: false, detail: "service registration ownership could not be re-proven" });
    }
    const identity = resource.identity!;
    const currentFingerprint = await currentDefinitionFingerprint(resource, this.#runner);
    const loaded = await serviceLoaded(resource, this.#runner);
    if (currentFingerprint !== undefined && currentFingerprint !== identity.definitionFingerprint) {
      return Object.freeze({ removed: false, detail: "service registration definition changed before removal" });
    }
    if (identity.platform === "linux") {
      const result = await this.#runner.run("systemctl", ["--user", "disable", "--now", resource.registrationId]);
      if (result.exitCode !== 0) throw new Error(`service registration normal stop failed: ${result.stderr.trim().slice(0, 240)}`);
    } else if (loaded && identity.platform === "darwin") {
      let result: ServiceRegistrationCommandResult;
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (uid === undefined) throw new Error("macOS service removal requires a user id");
      result = await this.#runner.run("/bin/launchctl", ["bootout", `gui/${uid}/${resource.registrationId}`]);
      if (result.exitCode !== 0) throw new Error(`service registration normal stop failed: ${result.stderr.trim().slice(0, 240)}`);
    }

    if (identity.platform === "win32") {
      const beforeDelete = await windowsFingerprint(this.#runner, resource.registrationId);
      if (beforeDelete.exists && beforeDelete.fingerprint !== identity.definitionFingerprint) {
        return Object.freeze({ removed: false, detail: "Windows scheduled-task definition changed before removal; deletion was preserved" });
      }
      if (beforeDelete.exists) {
        const script = [
          "$t=Get-ScheduledTask -TaskName $args[0] -TaskPath '\\' -ErrorAction Stop;",
          "if($t.State.ToString() -eq 'Running'){ Stop-ScheduledTask -InputObject $t -ErrorAction Stop };",
          "Unregister-ScheduledTask -InputObject $t -Confirm:$false -ErrorAction Stop",
        ].join(" ");
        const deleted = await this.#runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, resource.registrationId]);
        if (deleted.exitCode !== 0) throw new Error(`Windows scheduled-task deletion failed: ${deleted.stderr.trim().slice(0, 240)}`);
      }
      if ((await windowsFingerprint(this.#runner, resource.registrationId)).exists) {
        throw new Error("Windows scheduled task still exists after deletion request");
      }
    } else {
      const definitionPath = identity.definitionPath!;
      if (existsSync(definitionPath)) {
        if (fileFingerprint(definitionPath) !== identity.definitionFingerprint) {
          return Object.freeze({ removed: false, detail: "service definition changed before file removal" });
        }
        rmSync(definitionPath, { force: false });
      }
      if (identity.platform === "linux") {
        const reload = await this.#runner.run("systemctl", ["--user", "daemon-reload"]);
        if (reload.exitCode !== 0) throw new Error(`systemd daemon-reload failed: ${reload.stderr.trim().slice(0, 240)}`);
      }
      if (await serviceLoaded(resource, this.#runner)) throw new Error("service registration is still loaded after removal");
    }
    rmSync(identity.markerPath, { force: true });
    return Object.freeze({ removed: true, detail: "exact owned service registration removed" });
  }
}

export class ServiceRegistrationOwnershipObserver implements UninstallObserver {
  readonly #manager: ServiceRegistrationManager;
  constructor(manager: ServiceRegistrationManager) { this.#manager = manager; }
  observe(resource: OwnedResource, manifest: OwnershipManifest): Promise<OwnershipObservation> | OwnershipObservation {
    return resource.kind === "service-registration" ? this.#manager.observe(resource, manifest) : "unknown";
  }
}

export async function recordServiceRegistrationOwnership(input: {
  readonly manifestPath: string;
  readonly installId: string;
  readonly productVersion: string;
  readonly resourceId: string;
  readonly owner: "gateway" | "chat" | "codex";
  readonly registrationId: string;
  readonly platform: ServiceRegistrationPlatform;
  readonly markerPath: string;
  readonly definitionPath?: string;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<ServiceRegistrationResource> {
  const base = parseOwnedResource({
    kind: "service-registration",
    id: input.resourceId,
    owner: input.owner,
    registrationId: input.registrationId,
  }) as ServiceRegistrationResource;
  const runner = input.runner ?? new SystemServiceRegistrationCommandRunner();
  let definitionFingerprint: string | undefined;
  if (input.platform === "win32") {
    const evidence = await windowsFingerprint(runner, input.registrationId);
    if (!evidence.exists || !evidence.fingerprint) throw new Error("Windows scheduled-task registration is absent after install");
    definitionFingerprint = evidence.fingerprint;
  } else {
    if (!input.definitionPath) throw new Error(`${input.platform} service registration requires a definition path`);
    definitionFingerprint = fileFingerprint(input.definitionPath);
    if (!definitionFingerprint) throw new Error("service registration definition is absent after install");
  }
  const identity: ServiceRegistrationIdentity = Object.freeze({
    platform: input.platform,
    markerPath: input.markerPath,
    definitionFingerprint,
    ...(input.definitionPath ? { definitionPath: input.definitionPath } : {}),
  });
  const resource = parseOwnedResource({ ...base, identity }) as ServiceRegistrationResource;
  await reserveServiceRegistrationOwnership({
    manifestPath: input.manifestPath,
    installId: input.installId,
    productVersion: input.productVersion,
    resource,
  });
  return resource;
}
