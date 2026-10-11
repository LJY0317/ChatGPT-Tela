import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseProductConfig, readProductConfig, writeProductConfig } from "@chatgpt-tela/product-config";
import {
  acquireProductActivity, prepareOwnedDirectory, productActivityPath, releaseProductActivity,
  type ProductPathOptions,
} from "@chatgpt-tela/product-lifecycle";
import { readServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import { CodexServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";
import { prepareProfileOwnership } from "../../cli/src/profile-ownership";
import { runPackagedServiceLauncher, verifyInstalledPackage, type ResolvedPackagedMenuBarLaunch } from "./runtime";

export interface PackagedBootstrapOptions {
  readonly payloadRoot: string;
  readonly launcherExecutablePath?: string;
  readonly pathOptions?: ProductPathOptions;
  readonly launchSetup?: (launch: ResolvedPackagedMenuBarLaunch) => Promise<number>;
  readonly configurationInput?: string;
}

const CONFIGURATION_LIMIT = 64 * 1024;

/** UI input stays out of process arguments and is bounded before parsing or writing. */
export async function readConfigurationInput(input: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > CONFIGURATION_LIMIT) throw new Error("product configuration exceeds size limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function regularFile(path: string): string {
  const value = resolve(path);
  const stat = lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("setup/configuration requires a regular file");
  return value;
}

function configurationExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Bootstrap uses the installed receipt and existing setup implementation, never a source checkout. */
export async function runPackagedBootstrapCommand(args: readonly string[], options: PackagedBootstrapOptions) {
  const command = args[0];
  if (command === "bootstrap-status") {
    if (args.length !== 1) throw new Error("usage: bootstrap-status");
    const { paths } = verifyInstalledPackage(options);
    const configPath = join(paths.configRoot, "product-v1.json");
    if (!configurationExists(configPath)) return { configuration: "missing" };
    const config = readProductConfig(configPath);
    return { configuration: "configured", publicUrl: config.exposure.publicUrl };
  }
  if (command === "configure") {
    const fromStdin = args[1] === "--stdin" && (args.length === 2 || (args.length === 3 && args[2] === "--if-missing"));
    const fromFile = args.length === 3 && args[1] === "--file";
    if (!fromStdin && !fromFile) throw new Error("usage: configure --file <product-config.json> | --stdin [--if-missing]");
    let text: string;
    if (fromStdin) {
      if (options.configurationInput === undefined) throw new Error("configuration input is missing");
      text = options.configurationInput;
    } else {
      const configFile = regularFile(args[2]!);
      if (lstatSync(configFile).size > CONFIGURATION_LIMIT) throw new Error("product configuration exceeds size limit");
      text = readFileSync(configFile, "utf8");
    }
    if (Buffer.byteLength(text) > CONFIGURATION_LIMIT) throw new Error("product configuration exceeds size limit");
    const config = parseProductConfig(JSON.parse(text));
    const { paths, ownership } = verifyInstalledPackage(options);
    const configPath = join(paths.configRoot, "product-v1.json");
    if (args.includes("--if-missing") && configurationExists(configPath)) throw new Error("configuration already exists; first-use setup preserved it");
    const prepared = await prepareOwnedDirectory({ manifestPath: paths.installManifest,
      installId: ownership.installId, productVersion: ownership.productVersion,
      resource: { kind: "directory", id: "product-config", owner: "product", path: paths.configRoot, dataClass: "config" } });
    if (prepared.state === "external-existing") throw new Error("existing configuration directory is not owned by this Tela install; it was preserved");
    // Reserve persistent/runtime directories before the first packaged service writes into them.
    // Existing unmarked directories stay external; this never adopts old user data.
    const directories = [
      { id: "product-cache", owner: "product" as const, path: paths.cacheRoot, dataClass: "cache" as const },
      { id: "product-logs", owner: "product" as const, path: paths.logsRoot, dataClass: "logs" as const },
      ...(["gateway", "chat", "codex"] as const).flatMap(service => [
        { id: `${service}-state`, owner: service, path: paths.serviceState(service), dataClass: "state" as const },
        { id: `${service}-runtime`, owner: service, path: paths.serviceRuntime(service), dataClass: "runtime" as const },
      ]),
    ];
    for (const directory of directories) await prepareOwnedDirectory({ manifestPath: paths.installManifest,
      installId: ownership.installId, productVersion: ownership.productVersion, resource: { kind: "directory", ...directory } });
    writeProductConfig(config, configPath);
    return { configured: true, publicMcpAbi: config.publicMcpAbi, exposure: config.exposure.kind };
  }
  if (command !== "setup" || !(args.length === 1 || (args.length === 3 && args[1] === "--slot"))) {
    throw new Error("usage: setup [--slot <profile>]");
  }
  const slot = args.length === 1 ? 1 : Number(args[2]);
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("profile slot must be an integer from 1 to 99");
  const { payloadRoot, paths, ownership, manifest } = verifyInstalledPackage(options);
  const runtime = manifest.profileRuntime!;
  if (!runtime.setupEntrypoint) throw new Error("this package has no login setup entrypoint; install a package that includes setup");
  const executable = regularFile(join(payloadRoot, ...runtime.executable.split("/")));
  const entrypoint = regularFile(join(payloadRoot, ...runtime.setupEntrypoint.split("/")));
  const descriptor = readServiceRuntimeDescriptor(join(paths.serviceRuntime("codex"), "descriptor.json"));
  if (descriptor) {
    if (descriptor.installId !== ownership.installId) throw new Error("Codex service belongs to another install; setup was blocked");
    const client = new CodexServiceClient(descriptorForService(descriptor, "codex"));
    try {
      const profile = (await client.profiles(AbortSignal.timeout(10_000))).find(item => item.slot === slot);
      if (profile && (profile.controlState === "running" || profile.controlState === "orphaned")) {
        throw new Error("disconnect this Work profile before opening its login setup window");
      }
    } finally { await client.close(); }
  }
  const activityPath = productActivityPath(paths.runtimeRoot, "profile-setup", String(slot));
  const activity = acquireProductActivity({ path: activityPath, installId: ownership.installId, kind: "profile-setup", scope: String(slot) });
  let failure: unknown;
  try {
    const profile = await prepareProfileOwnership({ slot, productPaths: paths, productVersion: ownership.productVersion,
      ...(options.pathOptions?.platform ? { platform: options.pathOptions.platform } : {}),
      ...(options.pathOptions?.home ? { homeDirectory: options.pathOptions.home } : {}),
      environment: options.pathOptions?.environment ?? process.env });
    const launch = { payloadRoot, executable, arguments: [entrypoint], environment: {
      CHATGPT_TELA_PROFILE_ROOT: profile.profile.profileRoot,
      CHATGPT_TELA_PROFILE_SETUP_SLOT: String(slot), CHATGPT_TELA_PROFILE_SETUP_REVEAL: "1",
      CHATGPT_TELA_PROFILE_SETUP_CONTEXT_CANARY: "0",
    } };
    const code = await (options.launchSetup ?? (value => runPackagedServiceLauncher({ launch: value })))(launch);
    if (code !== 0) throw new Error(`profile setup exited with code ${code}`);
  } catch (error) { failure = error; }
  try { releaseProductActivity({ path: activityPath, expected: activity }); }
  catch (error) {
    if (failure) throw new AggregateError([failure, error], "setup failed and its activity lease could not be released");
    throw error;
  }
  if (failure) throw failure;
  return { setupClosed: true, slot };
}
