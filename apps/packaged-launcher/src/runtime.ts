import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readProductConfig, type ProductConfig } from "@chatgpt-tela/product-config";
import {
  observeInstalledPackagedPayload,
  packagedRepairJournalPath,
  packagedUpgradeJournalPath,
  readOwnershipManifest,
  readPackagedProductManifest,
  resolveProductPaths,
  type PackagedProductManifest,
  type ProductPathOptions,
  type TelaServiceId,
} from "@chatgpt-tela/product-lifecycle";

type DirectoryResource = Extract<NonNullable<ReturnType<typeof readOwnershipManifest>>["resources"][number], { readonly kind: "directory" }>;

export interface ResolvedPackagedServiceLaunch {
  readonly service: TelaServiceId;
  readonly payloadRoot: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export interface ResolvedPackagedMenuBarLaunch {
  readonly payloadRoot: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function regularPayloadFile(root: string, relativePath: string, field: string): string {
  const absolute = resolve(root, ...relativePath.split("/"));
  if (!inside(root, absolute) || absolute === root) throw new Error(`${field} escapes the packaged payload root`);
  if (!existsSync(absolute)) throw new Error(`${field} is missing: ${absolute}`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${field} must be a real regular file`);
  return realpathSync(absolute);
}

function binaryResource(manifest: NonNullable<ReturnType<typeof readOwnershipManifest>>): DirectoryResource {
  const matches = manifest.resources.filter((resource): resource is DirectoryResource =>
    resource.kind === "directory" && resource.id === "product-binaries" && resource.dataClass === "binary");
  if (matches.length !== 1) throw new Error("installed ownership manifest does not contain exactly one product binary resource");
  return matches[0]!;
}

function derivedEnvironment(input: {
  readonly service: TelaServiceId;
  readonly manifest: PackagedProductManifest;
  readonly installId: string;
  readonly payloadRoot: string;
  readonly productConfig: ProductConfig;
}): Readonly<Record<string, string>> {
  const result: Record<string, string> = {
    CHATGPT_TELA_INSTALL_ID: input.installId,
    CHATGPT_TELA_PRODUCT_VERSION: input.manifest.productVersion,
  };
  if (input.service === "gateway") {
    result.CHATGPT_TELA_GATEWAY_PUBLIC_MCP_URL = input.productConfig.exposure.publicUrl;
    result.CHATGPT_TELA_GATEWAY_LOCAL_MCP_PORT = String(input.productConfig.exposure.localPort);
    result.CHATGPT_TELA_GATEWAY_ALLOW_UNAUTHENTICATED_PUBLIC_MCP = "1";
    result.CHATGPT_TELA_GATEWAY_PUBLIC_MCP_ABI = input.productConfig.publicMcpAbi;
    if (input.productConfig.exposure.kind === "tailscale-funnel") {
      result.CHATGPT_TELA_GATEWAY_MANAGE_TAILSCALE_FUNNEL = "1";
      result.CHATGPT_TELA_TAILSCALE_CLI = input.productConfig.exposure.tailscaleCli;
    }
  }
  if (input.service === "codex") {
    result.CHATGPT_TELA_PRODUCT_PUBLIC_MCP_ABI = input.productConfig.publicMcpAbi;
    if (!input.manifest.profileRuntime) throw new Error("packaged Codex service requires profile runtime metadata");
    result.CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_EXECUTABLE = regularPayloadFile(
      input.payloadRoot,
      input.manifest.profileRuntime.executable,
      "packaged profile runtime executable",
    );
    result.CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_ENTRYPOINT = regularPayloadFile(
      input.payloadRoot,
      input.manifest.profileRuntime.entrypoint,
      "packaged profile runtime entrypoint",
    );
    if (input.productConfig.multiProfile) {
      result.CHATGPT_TELA_CODEX_MULTI_PROFILE_LAUNCHER_CLI = input.productConfig.multiProfile.launcherCli;
    }
  }
  return Object.freeze(result);
}

export function resolvePackagedServiceLaunch(input: {
  readonly service: TelaServiceId;
  readonly payloadRoot: string;
  readonly launcherExecutablePath?: string;
  readonly productConfig?: ProductConfig;
  readonly pathOptions?: ProductPathOptions;
}): ResolvedPackagedServiceLaunch {
  const payloadRoot = realpathSync(resolve(input.payloadRoot));
  const manifest = readPackagedProductManifest(payloadRoot);
  if (!manifest.launcher || !manifest.profileRuntime || !manifest.integrity) {
    throw new Error("installed package does not declare the signed launcher layout");
  }
  const expectedLauncher = regularPayloadFile(payloadRoot, manifest.launcher.executable, "packaged launcher executable");
  if (input.launcherExecutablePath && realpathSync(resolve(input.launcherExecutablePath)) !== expectedLauncher) {
    throw new Error("running launcher executable does not match the installed package manifest");
  }
  const paths = resolveProductPaths(input.pathOptions);
  if (existsSync(packagedUpgradeJournalPath(paths)) || existsSync(packagedRepairJournalPath(paths))) {
    throw new Error("packaged service launch is blocked while an install transition journal is incomplete");
  }
  const ownership = readOwnershipManifest(paths.installManifest);
  if (!ownership) throw new Error("packaged launcher requires an installed ownership manifest");
  if (ownership.productVersion !== manifest.productVersion) throw new Error("installed product version does not match the packaged launcher payload");
  const resource = binaryResource(ownership);
  if (realpathSync(resource.path) !== payloadRoot) throw new Error("packaged launcher root does not match the owned binary resource");
  const observed = observeInstalledPackagedPayload(resource, ownership);
  if (observed.state !== "owned" || observed.receipt.productVersion !== manifest.productVersion) {
    throw new Error("packaged launcher payload ownership/receipt could not be re-proven");
  }
  const productConfig = input.productConfig ?? readProductConfig(join(paths.configRoot, "product-v1.json"));
  const entry = manifest.services[input.service];
  const executable = regularPayloadFile(payloadRoot, entry.executable, `packaged ${input.service} executable`);
  const environment = Object.freeze({
    ...(entry.environment ?? {}),
    CHATGPT_TELA_DIAGNOSTIC_FILE: join(paths.logsRoot, `${input.service}.diagnostics.jsonl`),
    ...derivedEnvironment({
      service: input.service,
      manifest,
      installId: ownership.installId,
      payloadRoot,
      productConfig,
    }),
  });
  return Object.freeze({
    service: input.service,
    payloadRoot,
    executable,
    arguments: entry.arguments,
    environment,
  });
}

export function resolvePackagedMenuBarLaunch(input: {
  readonly payloadRoot: string;
  readonly launcherExecutablePath?: string;
  readonly pathOptions?: ProductPathOptions;
}): ResolvedPackagedMenuBarLaunch {
  if (process.platform !== "darwin" && input.pathOptions?.platform !== "darwin") {
    throw new Error("packaged ChatGPT Tela menu bar is available only on macOS");
  }
  const payloadRoot = realpathSync(resolve(input.payloadRoot));
  const manifest = readPackagedProductManifest(payloadRoot);
  if (!manifest.launcher || !manifest.profileRuntime || !manifest.integrity || !manifest.menuBar) {
    throw new Error("installed package does not declare the signed macOS menu bar layout");
  }
  const expectedLauncher = regularPayloadFile(payloadRoot, manifest.launcher.executable, "packaged launcher executable");
  if (input.launcherExecutablePath && realpathSync(resolve(input.launcherExecutablePath)) !== expectedLauncher) {
    throw new Error("running launcher executable does not match the installed package manifest");
  }
  const paths = resolveProductPaths(input.pathOptions);
  if (existsSync(packagedUpgradeJournalPath(paths)) || existsSync(packagedRepairJournalPath(paths))) {
    throw new Error("packaged menu bar launch is blocked while an install transition journal is incomplete");
  }
  const ownership = readOwnershipManifest(paths.installManifest);
  if (!ownership) throw new Error("packaged launcher requires an installed ownership manifest");
  if (ownership.productVersion !== manifest.productVersion) throw new Error("installed product version does not match the packaged launcher payload");
  const resource = binaryResource(ownership);
  if (realpathSync(resource.path) !== payloadRoot) throw new Error("packaged launcher root does not match the owned binary resource");
  const observed = observeInstalledPackagedPayload(resource, ownership);
  if (observed.state !== "owned" || observed.receipt.productVersion !== manifest.productVersion) {
    throw new Error("packaged launcher payload ownership/receipt could not be re-proven");
  }
  return Object.freeze({
    payloadRoot,
    executable: regularPayloadFile(payloadRoot, manifest.menuBar.executable, "packaged menu bar executable"),
    arguments: Object.freeze([]),
    environment: Object.freeze({}),
  });
}

export async function runPackagedServiceLauncher(input: {
  readonly launch: ResolvedPackagedServiceLaunch | ResolvedPackagedMenuBarLaunch;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly spawnChild?: (executable: string, arguments_: readonly string[], environment: NodeJS.ProcessEnv) => ChildProcess;
}): Promise<number> {
  const spawnChild = input.spawnChild ?? ((executable, arguments_, environment) => spawn(executable, [...arguments_], {
    cwd: input.launch.payloadRoot,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  }));
  const environment: NodeJS.ProcessEnv = { ...(input.baseEnvironment ?? process.env), ...input.launch.environment };
  const child = spawnChild(input.launch.executable, input.launch.arguments, environment);
  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const sigint = () => forward("SIGINT");
  const sigterm = () => forward("SIGTERM");
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);
  try {
    return await new Promise<number>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => {
        if (signal) resolvePromise(128);
        else resolvePromise(code ?? 1);
      });
    });
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  }
}

export function payloadRootForLauncherExecutable(executable = process.execPath): string {
  return dirname(realpathSync(executable));
}
