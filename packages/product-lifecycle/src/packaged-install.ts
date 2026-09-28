import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createOwnershipManifest, readOwnershipManifest, type OwnedResource, type OwnershipManifest } from "./ownership";
import { mutateOwnershipManifest, registerOwnedResource } from "./ownership-store";
import { applyInstallPlan, planInstall, verifyInstall, type InstallApplyResult, type InstallPlan } from "./install";
import { PackagedPayloadManager, packagedPayloadFingerprint, type PackagedPayloadSpec } from "./packaged-payload";
import {
  ServiceRegistrationInstaller,
  serviceRegistrationResourceForDefinition,
  SystemServiceRegistrationCommandRunner,
  type ServiceRegistrationCommandRunner,
  type ServiceRegistrationDefinition,
} from "./service-registration";
import { resolveProductPaths, type ProductPathOptions, type ProductPaths, type TelaServiceId } from "./layout";
import type { OwnershipObservation } from "./uninstall";
import { packagedInstallSpecFromPayload } from "./packaged-manifest";
import { verifyPackagedPayloadSignature, type PackagedPayloadTrustedKeys } from "./packaged-signature";
import { assertNoActivePackagedTransition } from "./packaged-transition";

export interface PackagedServiceLaunchSpec {
  readonly service: TelaServiceId;
  readonly executableRelativePath: string;
  readonly arguments?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

export interface PackagedProductInstallSpec {
  readonly productVersion: string;
  readonly payloadSourcePath: string;
  readonly services: readonly PackagedServiceLaunchSpec[];
  readonly menuBar?: { readonly executableRelativePath: string };
}

export interface PackagedServiceBlueprint {
  readonly service: TelaServiceId;
  readonly resource: Extract<OwnedResource, { readonly kind: "service-registration" }>;
  readonly definition: ServiceRegistrationDefinition;
}

export interface PackagedMenuBarBlueprint {
  readonly resource: Extract<OwnedResource, { readonly kind: "service-registration" }>;
  readonly definition: ServiceRegistrationDefinition;
}

export interface PackagedInstallBlueprint {
  readonly platform: "darwin" | "win32" | "linux";
  readonly paths: ProductPaths;
  readonly payload: PackagedPayloadSpec;
  readonly payloadFingerprint: string;
  readonly services: readonly PackagedServiceBlueprint[];
  readonly menuBar?: PackagedMenuBarBlueprint;
  readonly desiredResources: readonly OwnedResource[];
}

export interface PlannedPackagedInstall {
  readonly manifest: OwnershipManifest;
  readonly blueprint: PackagedInstallBlueprint;
  readonly plan: InstallPlan;
}

function oneLine(value: string, field: string): string {
  if (!value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  oneLine(value, "systemd service argument");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function windowsCommandLineArgument(value: string): string {
  if (/\u0000/.test(value)) throw new Error("Windows scheduled-task argument contains NUL");
  if (value && !/[\s"]/.test(value)) return value;
  let output = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      output += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    output += "\\".repeat(slashes) + character;
    slashes = 0;
  }
  output += "\\".repeat(slashes * 2) + '"';
  return output;
}

function serviceRegistrationId(platform: "darwin" | "win32" | "linux", service: TelaServiceId): string {
  if (platform === "darwin") return `com.openai.chatgpt-tela.${service}`;
  if (platform === "linux") return `chatgpt-tela-${service}.service`;
  return `ChatGPTTela${service[0]!.toUpperCase()}${service.slice(1)}`;
}

function serviceDefinitionPath(input: {
  readonly platform: "darwin" | "win32" | "linux";
  readonly home: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly registrationId: string;
}): string | undefined {
  if (input.platform === "darwin") return join(input.home, "Library", "LaunchAgents", `${input.registrationId}.plist`);
  if (input.platform === "linux") {
    const configHome = input.environment.XDG_CONFIG_HOME?.trim()
      ? resolve(input.environment.XDG_CONFIG_HOME)
      : join(input.home, ".config");
    return join(configHome, "systemd", "user", input.registrationId);
  }
  return undefined;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function installedExecutable(binaryRoot: string, relativePath: string): string {
  oneLine(relativePath, "packaged service executable relative path");
  if (isAbsolute(relativePath)) throw new Error("packaged service executable path must be relative to the payload root");
  const target = resolve(binaryRoot, relativePath);
  if (!inside(resolve(binaryRoot), target) || target === resolve(binaryRoot)) {
    throw new Error("packaged service executable path escapes the binary root");
  }
  return target;
}

function sortedEnvironment(environment: Readonly<Record<string, string>> | undefined): readonly [string, string][] {
  if (!environment) return Object.freeze([]);
  const entries = Object.entries(environment).sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`service environment key is invalid: ${key}`);
    oneLine(value, `service environment ${key}`);
  }
  return Object.freeze(entries);
}

function renderDarwinService(input: {
  readonly registrationId: string;
  readonly executable: string;
  readonly arguments_: readonly string[];
  readonly environment: readonly [string, string][];
  readonly workingDirectory: string;
}): string {
  const argumentsXml = [input.executable, ...input.arguments_]
    .map(value => `      <string>${xml(oneLine(value, "launchd argument"))}</string>`)
    .join("\n");
  const environmentXml = input.environment.length === 0
    ? ""
    : `\n    <key>EnvironmentVariables</key>\n    <dict>\n${input.environment.map(([key, value]) =>
      `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`).join("\n")}\n    </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key>\n    <string>${xml(input.registrationId)}</string>\n    <key>ProgramArguments</key>\n    <array>\n${argumentsXml}\n    </array>\n    <key>WorkingDirectory</key>\n    <string>${xml(input.workingDirectory)}</string>${environmentXml}\n    <key>RunAtLoad</key>\n    <false/>\n    <key>ProcessType</key>\n    <string>Background</string>\n  </dict>\n</plist>\n`;
}

function renderDarwinMenuBar(input: {
  readonly registrationId: string;
  readonly executable: string;
  readonly workingDirectory: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key>\n    <string>${xml(input.registrationId)}</string>\n    <key>ProgramArguments</key>\n    <array>\n      <string>${xml(oneLine(input.executable, "menu bar executable"))}</string>\n    </array>\n    <key>WorkingDirectory</key>\n    <string>${xml(input.workingDirectory)}</string>\n    <key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <false/>\n    <key>LimitLoadToSessionType</key>\n    <string>Aqua</string>\n    <key>ProcessType</key>\n    <string>Interactive</string>\n  </dict>\n</plist>\n`;
}

function renderLinuxService(input: {
  readonly service: TelaServiceId;
  readonly executable: string;
  readonly arguments_: readonly string[];
  readonly environment: readonly [string, string][];
  readonly workingDirectory: string;
}): string {
  const environmentLines = input.environment.map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join("\n");
  return `[Unit]\nDescription=ChatGPT Tela ${input.service}\n\n[Service]\nType=simple\nWorkingDirectory=${systemdQuote(input.workingDirectory)}\nExecStart=${[input.executable, ...input.arguments_].map(systemdQuote).join(" ")}\n${environmentLines ? `${environmentLines}\n` : ""}\n[Install]\nWantedBy=default.target\n`;
}

function renderServiceDefinition(input: {
  readonly platform: "darwin" | "win32" | "linux";
  readonly service: PackagedServiceLaunchSpec;
  readonly registrationId: string;
  readonly executable: string;
  readonly binaryRoot: string;
}): ServiceRegistrationDefinition {
  const arguments_ = Object.freeze([...(input.service.arguments ?? [])].map(value => oneLine(value, "service argument")));
  const environment = sortedEnvironment(input.service.environment);
  if (input.platform === "darwin") {
    return Object.freeze({ platform: "darwin", content: renderDarwinService({
      registrationId: input.registrationId,
      executable: input.executable,
      arguments_,
      environment,
      workingDirectory: input.binaryRoot,
    }) });
  }
  if (input.platform === "linux") {
    return Object.freeze({ platform: "linux", content: renderLinuxService({
      service: input.service.service,
      executable: input.executable,
      arguments_,
      environment,
      workingDirectory: input.binaryRoot,
    }) });
  }
  if (environment.length > 0) throw new Error("Windows packaged tasks must read product configuration from standard paths, not installer environment variables");
  return Object.freeze({
    platform: "win32",
    executable: input.executable,
    arguments: arguments_.map(windowsCommandLineArgument).join(" "),
    workingDirectory: input.binaryRoot,
  });
}

function platformKind(platform: NodeJS.Platform): "darwin" | "win32" | "linux" {
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  throw new Error(`packaged install is unsupported on ${platform}`);
}

export function createPackagedInstallBlueprint(input: {
  readonly spec: PackagedProductInstallSpec;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): PackagedInstallBlueprint {
  const platform = platformKind(input.platform ?? process.platform);
  const home = resolve(input.home ?? homedir());
  const environment = input.environment ?? process.env;
  const paths = resolveProductPaths({ platform, home, environment });
  const payloadResource = Object.freeze({
    kind: "directory" as const,
    id: "product-binaries",
    owner: "product" as const,
    path: paths.binaryRoot,
    dataClass: "binary" as const,
  });
  const payload: PackagedPayloadSpec = Object.freeze({
    sourcePath: resolve(input.spec.payloadSourcePath),
    resource: payloadResource,
    productVersion: oneLine(input.spec.productVersion, "product version"),
  });

  const seen = new Set<TelaServiceId>();
  const services: PackagedServiceBlueprint[] = [];
  for (const service of input.spec.services) {
    if (seen.has(service.service)) throw new Error(`duplicate packaged service spec: ${service.service}`);
    seen.add(service.service);
    const registrationId = serviceRegistrationId(platform, service.service);
    const executable = installedExecutable(paths.binaryRoot, service.executableRelativePath);
    const definition = renderServiceDefinition({ platform, service, registrationId, executable, binaryRoot: paths.binaryRoot });
    const definitionPath = serviceDefinitionPath({ platform, home, environment, registrationId });
    const markerPath = join(paths.stateRoot, "install", "service-markers", `${service.service}.json`);
    const resource = serviceRegistrationResourceForDefinition({
      resourceId: `${service.service}-service`,
      owner: service.service,
      registrationId,
      markerPath,
      ...(definitionPath ? { definitionPath } : {}),
      definition,
    });
    services.push(Object.freeze({ service: service.service, resource, definition }));
  }
  for (const required of ["gateway", "chat", "codex"] as const) {
    if (!seen.has(required)) throw new Error(`packaged install requires a ${required} service spec`);
  }
  let menuBar: PackagedMenuBarBlueprint | undefined;
  if (platform === "darwin" && input.spec.menuBar) {
    const registrationId = "com.openai.chatgpt-tela.menu-bar";
    const executable = installedExecutable(paths.binaryRoot, input.spec.menuBar.executableRelativePath);
    const definition = Object.freeze({
      platform: "darwin" as const,
      content: renderDarwinMenuBar({ registrationId, executable, workingDirectory: paths.binaryRoot }),
    });
    const definitionPath = serviceDefinitionPath({ platform, home, environment, registrationId })!;
    const markerPath = join(paths.stateRoot, "install", "service-markers", "menu-bar.json");
    const resource = serviceRegistrationResourceForDefinition({
      resourceId: "menu-bar-registration",
      owner: "product",
      registrationId,
      markerPath,
      definitionPath,
      definition,
    });
    menuBar = Object.freeze({ resource, definition });
  }
  return Object.freeze({
    platform,
    paths,
    payload,
    payloadFingerprint: packagedPayloadFingerprint(payload.sourcePath),
    services: Object.freeze(services),
    ...(menuBar ? { menuBar } : {}),
    desiredResources: Object.freeze([
      payloadResource,
      ...services.map(service => service.resource),
      ...(menuBar ? [menuBar.resource] : []),
    ]),
  });
}

class PackagedInstallOperator {
  readonly #manifestPath: string;
  readonly #manifest: OwnershipManifest;
  readonly #payload: PackagedPayloadManager;
  readonly #serviceInstaller: ServiceRegistrationInstaller;
  readonly #registrations: ReadonlyMap<string, {
    readonly resource: Extract<OwnedResource, { readonly kind: "service-registration" }>;
    readonly definition: ServiceRegistrationDefinition;
  }>;

  constructor(input: {
    readonly blueprint: PackagedInstallBlueprint;
    readonly manifest: OwnershipManifest;
    readonly runner?: ServiceRegistrationCommandRunner;
  }) {
    this.#manifestPath = input.blueprint.paths.installManifest;
    this.#manifest = input.manifest;
    this.#payload = new PackagedPayloadManager({
      manifestPath: this.#manifestPath,
      installId: input.manifest.installId,
      spec: input.blueprint.payload,
    });
    this.#serviceInstaller = new ServiceRegistrationInstaller({
      platform: input.blueprint.platform,
      runner: input.runner ?? new SystemServiceRegistrationCommandRunner(),
    });
    this.#registrations = new Map([
      ...input.blueprint.services.map(service => [service.resource.id, service] as const),
      ...(input.blueprint.menuBar ? [[input.blueprint.menuBar.resource.id, input.blueprint.menuBar] as const] : []),
    ]);
  }

  observe = async (resource: OwnedResource, manifest: OwnershipManifest): Promise<OwnershipObservation> => {
    if (resource.id === this.#payload.resource.id) return this.#payload.observe(manifest);
    const registration = this.#registrations.get(resource.id);
    if (registration && resource.kind === "service-registration") {
      return this.#serviceInstaller.observeReady(registration.resource, manifest);
    }
    return "unknown";
  };

  create = async (resource: OwnedResource, manifest: OwnershipManifest): Promise<{ readonly created: boolean; readonly detail: string }> => {
    if (resource.id === this.#payload.resource.id) return this.#payload.install(manifest);
    const registration = this.#registrations.get(resource.id);
    if (!registration || resource.kind !== "service-registration") {
      return Object.freeze({ created: false, detail: "unsupported packaged resource" });
    }
    if (this.#payload.observe(manifest) !== "owned") throw new Error("packaged services cannot be registered before the binary payload is verified");
    return this.#serviceInstaller.install({
      manifestPath: this.#manifestPath,
      manifest,
      resource: registration.resource,
      definition: registration.definition,
    });
  };
}

function existingOrProposedManifest(blueprint: PackagedInstallBlueprint, productVersion: string): OwnershipManifest {
  const existing = readOwnershipManifest(blueprint.paths.installManifest);
  if (!existing) return createOwnershipManifest(productVersion);
  if (existing.productVersion !== productVersion) {
    throw new Error(`installed product version ${existing.productVersion} requires an explicit upgrade plan before ${productVersion}`);
  }
  return existing;
}

export async function planPackagedInstall(input: {
  readonly spec: PackagedProductInstallSpec;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<PlannedPackagedInstall> {
  const blueprint = createPackagedInstallBlueprint(input);
  assertNoActivePackagedTransition(blueprint.paths, "install");
  const manifest = existingOrProposedManifest(blueprint, input.spec.productVersion);
  const operator = new PackagedInstallOperator({ blueprint, manifest, ...(input.runner ? { runner: input.runner } : {}) });
  const plan = await planInstall({ manifest, desiredResources: blueprint.desiredResources, observer: operator });
  return Object.freeze({ manifest, blueprint, plan });
}

export async function applyPackagedInstall(input: {
  readonly planned: PlannedPackagedInstall;
  readonly spec: PackagedProductInstallSpec;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<{
  readonly apply: InstallApplyResult;
  readonly verify: Awaited<ReturnType<typeof verifyInstall>>;
  readonly manifest: OwnershipManifest;
}> {
  const blueprint = createPackagedInstallBlueprint(input);
  assertNoActivePackagedTransition(blueprint.paths, "install");
  if (blueprint.payloadFingerprint !== input.planned.blueprint.payloadFingerprint) {
    throw new Error("packaged payload bytes changed after planning");
  }
  let manifest = await mutateOwnershipManifest({
    path: blueprint.paths.installManifest,
    installId: input.planned.manifest.installId,
    productVersion: input.planned.manifest.productVersion,
    mutate(current) {
      if (current.productVersion !== input.planned.manifest.productVersion) {
        throw new Error("install manifest product version changed after planning");
      }
      return current;
    },
  });
  const desiredById = new Map(blueprint.desiredResources.map(resource => [resource.id, resource] as const));
  for (const step of input.planned.plan.steps) {
    if (step.action !== "create") continue;
    const resource = desiredById.get(step.resourceId);
    if (!resource) throw new Error(`planned packaged resource is missing at apply: ${step.resourceId}`);
    manifest = await registerOwnedResource({
      path: blueprint.paths.installManifest,
      installId: manifest.installId,
      productVersion: manifest.productVersion,
      resource,
    });
  }
  const operator = new PackagedInstallOperator({ blueprint, manifest, ...(input.runner ? { runner: input.runner } : {}) });
  const apply = await applyInstallPlan({
    manifest,
    desiredResources: blueprint.desiredResources,
    plan: input.planned.plan,
    operator,
  });
  const current = readOwnershipManifest(blueprint.paths.installManifest) ?? manifest;
  const verify = await verifyInstall({ manifest: current, desiredResources: blueprint.desiredResources, observer: operator });
  return Object.freeze({ apply, verify, manifest: current });
}

export async function planPackagedInstallFromPayload(input: {
  readonly payloadSourcePath: string;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<PlannedPackagedInstall> {
  const spec = packagedInstallSpecFromPayload(input.payloadSourcePath);
  return planPackagedInstall({
    spec,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.home ? { home: input.home } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
  });
}

export async function applyPackagedInstallFromPayload(input: {
  readonly planned: PlannedPackagedInstall;
  readonly payloadSourcePath: string;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): ReturnType<typeof applyPackagedInstall> {
  const spec = packagedInstallSpecFromPayload(input.payloadSourcePath);
  return applyPackagedInstall({
    planned: input.planned,
    spec,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.home ? { home: input.home } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
  });
}

export async function planSignedPackagedInstallFromPayload(input: {
  readonly payloadSourcePath: string;
  readonly trustedKeys: PackagedPayloadTrustedKeys;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): Promise<PlannedPackagedInstall> {
  verifyPackagedPayloadSignature({ payloadRoot: input.payloadSourcePath, trustedKeys: input.trustedKeys });
  return planPackagedInstallFromPayload(input);
}

export async function applySignedPackagedInstallFromPayload(input: {
  readonly planned: PlannedPackagedInstall;
  readonly payloadSourcePath: string;
  readonly trustedKeys: PackagedPayloadTrustedKeys;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
}): ReturnType<typeof applyPackagedInstallFromPayload> {
  verifyPackagedPayloadSignature({ payloadRoot: input.payloadSourcePath, trustedKeys: input.trustedKeys });
  return applyPackagedInstallFromPayload(input);
}
