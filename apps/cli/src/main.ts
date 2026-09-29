import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareProfileOwnership } from "./profile-ownership";
import { summarizeDiagnosticWorkload } from "./diagnostic-workload";
import { summarizeRetentionCanary } from "./retention-canary";
import { diagnoseDefaultDesktop } from "@chatgpt-tela/default-desktop-target";
import {
  probePublicMcp,
  probeUnifiedDevelopmentMcp,
} from "@chatgpt-tela/gateway";
import {
  hasEffectiveProductConfig,
  nativeProductConfigPath,
  readEffectiveProductConfig,
} from "./product-config-selection";
import { profileSlotFromArguments } from "./profile-selection";
import {
  readChatAgentProvidersConfig,
  readChatApprovedRootsConfig,
  writeChatAgentProvidersConfig,
  writeChatApprovedRootsConfig,
} from "@chatgpt-tela/chat-service";
import {
  CredentialOwnershipManager,
  createPlatformCredentialStore,
  OPENAI_AGENT_API_KEY_CREDENTIAL_ID,
} from "@chatgpt-tela/credential-store";
import {
  CHATGPT_TELA_DISPLAY_NAME,
  CHATGPT_TELA_SCHEMA_FINGERPRINT,
} from "@chatgpt-tela/mcp";
import {
  readProductPreferences,
  resolveProductPreferencesPath,
  writeProductConfig,
  writeProductPreferences,
  type ProductConfig,
} from "@chatgpt-tela/product-config";
import {
  acquireProductActivity,
  ensureOwnershipManifest,
  packagedRepairJournalPath,
  packagedUpgradeJournalPath,
  productActivityPath,
  readPackagedRepairJournal,
  readPackagedUpgradeJournal,
  readOwnershipManifest,
  releaseProductActivity,
  resolveProductPaths,
} from "@chatgpt-tela/product-lifecycle";
import { runProductUninstall } from "@chatgpt-tela/product-uninstall";
import {
  type TelaServiceId,
} from "@chatgpt-tela/service-protocol";
import {
  CodexServiceClient,
  descriptorForService,
} from "@chatgpt-tela/service-protocol/client";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import {
  createTailscaleFunnelLease,
  SystemTailscaleCommandRunner,
  tailscaleDiagnosisDetail,
  TailscaleFunnelLeaseManager,
} from "@chatgpt-tela/tailscale-ingress";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function slot(): number {
  return profileSlotFromArguments(process.argv.slice(2));
}

function runScript(script: string): void {
  const result = spawnSync(process.execPath, ["run", script], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed with exit code ${result.status ?? -1}`);
}

function electronExecutable(): string {
  const name = process.platform === "win32" ? "electron.cmd" : "electron";
  const path = resolve(repoRoot, "node_modules/.bin", name);
  if (!existsSync(path)) throw new Error(`Electron executable is missing: ${path}`);
  return path;
}

function manageApprovalPreferences(): void {
  const subcommand = process.argv[3] ?? "status";
  const path = resolveProductPreferencesPath();
  if (subcommand === "status") {
    console.log(JSON.stringify({ path, ...readProductPreferences(path) }, null, 2));
    return;
  }
  if (subcommand !== "enable" && subcommand !== "disable") {
    throw new Error("usage: chatgpt-tela approval <status|enable|disable>");
  }
  const approvalAutomation = subcommand === "enable" ? "recognized_once" : "off";
  writeProductPreferences({ version: 1, approvalAutomation }, path);
  console.log(JSON.stringify({
    path,
    approvalAutomation,
    appliesTo: "new-or-restarted-codex-profiles",
    persistentApproval: false,
  }, null, 2));
}

function serviceDescriptorPath(
  productPaths: ReturnType<typeof resolveProductPaths>,
  service: TelaServiceId,
): string {
  return join(productPaths.serviceRuntime(service), "descriptor.json");
}

function serviceLogPath(
  productPaths: ReturnType<typeof resolveProductPaths>,
  service: TelaServiceId,
): string {
  return join(productPaths.logsRoot, `${service}.log`);
}

function diagnosticFileMetadata(path: string): Readonly<Record<string, string | number | boolean>> {
  if (!existsSync(path)) return Object.freeze({ state: "missing" });
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return Object.freeze({ state: "unsafe" });
    return Object.freeze({ state: "present", bytes: stat.size });
  } catch {
    return Object.freeze({ state: "unreadable" });
  }
}

function diagnosticsSummary(productPaths: ReturnType<typeof resolveProductPaths>): Readonly<Record<string, unknown>> {
  const service = (id: TelaServiceId) => {
    const raw = serviceLogPath(productPaths, id);
    const sourceDiagnostics = `${raw}.diagnostics.jsonl`;
    const packagedDiagnostics = join(productPaths.logsRoot, `${id}.diagnostics.jsonl`);
    return Object.freeze({
      serviceLog: diagnosticFileMetadata(raw),
      sourceDiagnostics: diagnosticFileMetadata(sourceDiagnostics),
      sourceDiagnosticsPrevious: diagnosticFileMetadata(`${sourceDiagnostics}.1`),
      packagedDiagnostics: diagnosticFileMetadata(packagedDiagnostics),
      packagedDiagnosticsPrevious: diagnosticFileMetadata(`${packagedDiagnostics}.1`),
    });
  };
  return Object.freeze({
    privacy: "metadata-only",
    contentRead: false,
    pathsEmitted: false,
    rotation: "current-plus-one-previous",
    services: Object.freeze({
      gateway: service("gateway"),
      chat: service("chat"),
      codex: service("codex"),
    }),
  });
}

function diagnosticWorkloadPaths(productPaths: ReturnType<typeof resolveProductPaths>): readonly string[] {
  return Object.freeze((["chat", "codex"] as const).flatMap(id => {
    const raw = serviceLogPath(productPaths, id);
    const source = `${raw}.diagnostics.jsonl`;
    const packaged = join(productPaths.logsRoot, `${id}.diagnostics.jsonl`);
    return [source, `${source}.1`, packaged, `${packaged}.1`];
  }));
}

function packagedTransitionStatus(productPaths: ReturnType<typeof resolveProductPaths>): readonly Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const collect = (
    kind: "upgrade" | "repair",
    path: string,
    read: (path: string) => unknown,
  ) => {
    if (!existsSync(path)) return;
    try {
      results.push(Object.freeze({ kind, state: "incomplete", journal: read(path) }));
    } catch (error) {
      results.push(Object.freeze({ kind, state: "invalid", detail: error instanceof Error ? error.message : String(error) }));
    }
  };
  collect("upgrade", packagedUpgradeJournalPath(productPaths), readPackagedUpgradeJournal);
  collect("repair", packagedRepairJournalPath(productPaths), readPackagedRepairJournal);
  return Object.freeze(results);
}

async function productSupervisor(productPaths: ReturnType<typeof resolveProductPaths>): Promise<{
  readonly installId: string;
  readonly supervisor: LocalServiceSupervisor;
}> {
  const manifest = await ensureOwnershipManifest({ path: productPaths.installManifest, productVersion: "0.0.0" });
  return Object.freeze({ installId: manifest.installId, supervisor: new LocalServiceSupervisor({ installId: manifest.installId }) });
}

async function ensureSourceServices(
  productPaths: ReturnType<typeof resolveProductPaths>,
): Promise<{
  readonly supervisor: LocalServiceSupervisor;
  readonly codex: CodexServiceClient;
  readonly chatError?: string;
}> {
  const config = readEffectiveProductConfig(productPaths);
  const { installId, supervisor } = await productSupervisor(productPaths);
  const upgradeJournal = readPackagedUpgradeJournal(packagedUpgradeJournalPath(productPaths));
  if (upgradeJournal) {
    throw new Error(`packaged upgrade ${upgradeJournal.fromVersion} -> ${upgradeJournal.toVersion} is incomplete; resume or repair it before starting Tela services`);
  }
  const repairJournal = readPackagedRepairJournal(packagedRepairJournalPath(productPaths));
  if (repairJournal) {
    throw new Error(`packaged repair for ${repairJournal.productVersion} is incomplete; resume it before starting Tela services`);
  }
  runScript("profile:runtime:build");

  let chatError: string | undefined;
  try {
    await supervisor.ensure({
      service: "chat",
      descriptorPath: serviceDescriptorPath(productPaths, "chat"),
      command: [process.execPath, resolve(repoRoot, "apps/chat-daemon/src/main.ts")],
      cwd: repoRoot,
      environment: {
        CHATGPT_TELA_INSTALL_ID: installId,
        CHATGPT_TELA_PRODUCT_VERSION: "0.0.0",
      },
      logPath: serviceLogPath(productPaths, "chat"),
    });
  } catch (error) {
    chatError = error instanceof Error ? error.message : String(error);
  }

  const codex = await supervisor.ensure({
    service: "codex",
    descriptorPath: serviceDescriptorPath(productPaths, "codex"),
    command: [process.execPath, resolve(repoRoot, "apps/codex-daemon/src/main.ts")],
    cwd: repoRoot,
    environment: {
      CHATGPT_TELA_INSTALL_ID: installId,
      ...(config.multiProfile
        ? { CHATGPT_TELA_CODEX_MULTI_PROFILE_LAUNCHER_CLI: config.multiProfile.launcherCli }
        : {}),
      CHATGPT_TELA_PRODUCT_PUBLIC_MCP_ABI: config.publicMcpAbi,
      CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_EXECUTABLE: electronExecutable(),
      CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_ENTRYPOINT: resolve(repoRoot, "build/profile-runtime/main.cjs"),
    },
    logPath: serviceLogPath(productPaths, "codex"),
  });

  await supervisor.ensure({
    service: "gateway",
    descriptorPath: serviceDescriptorPath(productPaths, "gateway"),
    command: [process.execPath, resolve(repoRoot, "apps/gateway-daemon/src/main.ts")],
    cwd: repoRoot,
    environment: {
      CHATGPT_TELA_INSTALL_ID: installId,
      CHATGPT_TELA_PRODUCT_VERSION: "0.0.0",
      CHATGPT_TELA_GATEWAY_PUBLIC_MCP_URL: config.exposure.publicUrl,
      CHATGPT_TELA_GATEWAY_LOCAL_MCP_PORT: String(config.exposure.localPort),
      CHATGPT_TELA_GATEWAY_ALLOW_UNAUTHENTICATED_PUBLIC_MCP: "1",
      CHATGPT_TELA_GATEWAY_PUBLIC_MCP_ABI: config.publicMcpAbi,
      ...(config.exposure.kind === "tailscale-funnel"
        ? {
            CHATGPT_TELA_GATEWAY_MANAGE_TAILSCALE_FUNNEL: "1",
            CHATGPT_TELA_TAILSCALE_CLI: config.exposure.tailscaleCli,
          }
        : {}),
    },
    logPath: serviceLogPath(productPaths, "gateway"),
  });

  return Object.freeze({
    supervisor,
    codex: new CodexServiceClient(descriptorForService(codex.descriptor, "codex")),
    ...(chatError ? { chatError } : {}),
  });
}

async function serviceStatus(
  supervisor: LocalServiceSupervisor,
  productPaths: ReturnType<typeof resolveProductPaths>,
  service: TelaServiceId,
): Promise<Record<string, unknown>> {
  try {
    const running = await supervisor.current({ service, descriptorPath: serviceDescriptorPath(productPaths, service) });
    return running
      ? { state: running.status.state, pid: running.descriptor.pid, instanceId: running.descriptor.instanceId }
      : { state: "stopped" };
  } catch (error) {
    return { state: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
}

function publicMcpStatus(
  productPaths: ReturnType<typeof resolveProductPaths>,
): Record<string, unknown> {
  if (!hasEffectiveProductConfig(productPaths)) return { status: "unconfigured" };
  try {
    const config = readEffectiveProductConfig(productPaths);
    return config.publicMcpAbi === "stable"
      ? {
          generation: 1,
          displayName: CHATGPT_TELA_DISPLAY_NAME,
          schemaFingerprint: CHATGPT_TELA_SCHEMA_FINGERPRINT,
          status: "frozen",
        }
      : {
          generation: "unified-development",
          displayName: "ChatGPT Tela Development",
          status: "development-unfrozen",
        };
  } catch (error) {
    return { status: "configuration-error", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function diagnoseConfiguredIngress(
  productPaths: ReturnType<typeof resolveProductPaths>,
): Promise<Record<string, unknown>> {
  if (!hasEffectiveProductConfig(productPaths)) {
    return { state: "unconfigured", cause: "product-unconfigured" };
  }
  const config = readEffectiveProductConfig(productPaths);
  const probe = config.publicMcpAbi === "stable" ? probePublicMcp : probeUnifiedDevelopmentMcp;
  const probeEndpoint = async (url: URL): Promise<Record<string, unknown>> => {
    const health = await probe(url, AbortSignal.timeout(4_000));
    return health.ready
      ? { state: "ready" }
      : { state: "unavailable", cause: "public-mcp-unreachable", detail: health.detail ?? "public MCP probe failed" };
  };
  const localMcp = await probeEndpoint(new URL(`http://127.0.0.1:${config.exposure.localPort}/mcp`));
  const normalizedLocalMcp = localMcp.state === "ready"
    ? localMcp
    : { ...localMcp, cause: "local-mcp-unreachable" };

  if (config.exposure.kind !== "tailscale-funnel") {
    if (normalizedLocalMcp.state !== "ready") {
      return {
        kind: "existing-https",
        state: "unavailable",
        cause: "local-mcp-unreachable",
        detail: "The configured public route cannot work because the local Tela Gateway MCP listener is not reachable",
        localMcp: normalizedLocalMcp,
        publicMcp: { state: "not-probed", blockedBy: "local-mcp-unreachable" },
      };
    }
    const publicMcp = await probeEndpoint(new URL(config.exposure.publicUrl));
    return {
      kind: "existing-https",
      state: publicMcp.state,
      cause: publicMcp.state === "ready" ? "ready" : "public-mcp-unreachable",
      localMcp: normalizedLocalMcp,
      publicMcp,
    };
  }

  const manifest = readOwnershipManifest(productPaths.installManifest);
  const manager = new TailscaleFunnelLeaseManager({
    runner: new SystemTailscaleCommandRunner(config.exposure.tailscaleCli),
    manifestPath: productPaths.installManifest,
    installId: manifest?.installId ?? "diagnostic-unowned-install",
    productVersion: manifest?.productVersion ?? "0.0.0",
  });
  const lease = createTailscaleFunnelLease({
    publicUrl: config.exposure.publicUrl,
    localTarget: `http://127.0.0.1:${config.exposure.localPort}/mcp`,
  });
  const tailscale = await manager.diagnose(lease);
  if (tailscale.availability !== "ready") {
    return {
      kind: "tailscale-funnel",
      state: "unavailable",
      cause: tailscale.cause,
      detail: tailscaleDiagnosisDetail(tailscale.cause),
      localMcp: normalizedLocalMcp,
      tailscale,
      publicMcp: { state: "not-probed", blockedBy: tailscale.cause },
    };
  }
  if (normalizedLocalMcp.state !== "ready") {
    return {
      kind: "tailscale-funnel",
      state: "unavailable",
      cause: "local-mcp-unreachable",
      detail: "Tailscale and the exact Funnel route are ready, but the local Tela Gateway MCP listener is not reachable",
      localMcp: normalizedLocalMcp,
      tailscale,
      publicMcp: { state: "not-probed", blockedBy: "local-mcp-unreachable" },
    };
  }
  const publicMcp = await probeEndpoint(new URL(config.exposure.publicUrl));
  return {
    kind: "tailscale-funnel",
    state: publicMcp.state,
    cause: publicMcp.state === "ready" ? "ready" : "public-mcp-unreachable",
    detail: publicMcp.state === "ready"
      ? "Tailscale is online, the exact Funnel route is present, and the public ChatGPT Tela MCP probe succeeded"
      : "Tailscale and the Funnel route are ready, but the public ChatGPT Tela MCP endpoint is not reachable",
    localMcp: normalizedLocalMcp,
    tailscale,
    publicMcp,
  };
}

async function configure(
  productPaths: ReturnType<typeof resolveProductPaths>,
): Promise<void> {
  const launcher = option("--multi-profile-launcher");
  if (launcher) {
    const path = resolve(launcher);
    if (!existsSync(path)) throw new Error(`optional multi-profile launcher does not exist: ${path}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("optional multi-profile launcher must be a regular non-symlink file");
    }
  }
  const publicMcpUrl = option("--public-mcp-url");
  if (!publicMcpUrl) {
    throw new Error("configure requires --public-mcp-url <https-url>");
  }
  if (!flag("--allow-unauthenticated-public-mcp")) {
    throw new Error("the current existing-HTTPS/no-auth development exposure requires --allow-unauthenticated-public-mcp");
  }
  const localPort = Number(option("--local-mcp-port") ?? "18743");
  const manageTailscale = flag("--manage-tailscale-funnel");
  const publicMcpAbi = option("--mcp-abi") ?? "stable";
  if (publicMcpAbi !== "stable" && publicMcpAbi !== "unified-development") {
    throw new Error("--mcp-abi must be stable or unified-development");
  }
  const config: ProductConfig = {
    version: 1,
    ...(launcher ? { multiProfile: { launcherCli: launcher } } : {}),
    publicMcpAbi,
    exposure: manageTailscale
      ? {
          kind: "tailscale-funnel",
          publicUrl: publicMcpUrl,
          localPort,
          authentication: "none",
          allowUnauthenticatedPublicEndpoint: true,
          tailscaleCli: option("--tailscale-cli") ?? "tailscale",
        }
      : {
          kind: "existing-https",
          publicUrl: publicMcpUrl,
          localPort,
          authentication: "none",
          allowUnauthenticatedPublicEndpoint: true,
        },
  };
  const productConfigPath = nativeProductConfigPath(productPaths);
  writeProductConfig(config, productConfigPath);
  console.log(JSON.stringify({ configured: true, path: productConfigPath,
    defaultNativeTarget: "default-desktop",
    extraProfiles: launcher ? "multi-profile" : "none",
    publicMcpAbi,
    exposureOwnership: manageTailscale ? "managed-tailscale-funnel" : "external-https" }, null, 2));
}

async function setupProfile(
  profileSlot: number,
  productPaths: ReturnType<typeof resolveProductPaths>,
): Promise<void> {
  const manifest = await ensureOwnershipManifest({ path: productPaths.installManifest, productVersion: "0.0.0" });
  const activityPath = productActivityPath(productPaths.runtimeRoot, "profile-setup", String(profileSlot));
  const activity = acquireProductActivity({
    path: activityPath,
    installId: manifest.installId,
    kind: "profile-setup",
    scope: String(profileSlot),
  });
  let primaryError: unknown;
  try {
    const ownership = await prepareProfileOwnership({
      slot: profileSlot,
      productPaths,
      productVersion: manifest.productVersion,
      environment: process.env,
    });
    const external = [ownership.browserProfile, ownership.accountBindings]
      .filter(result => result.state === "external-existing").length;
    if (external > 0) {
      console.error("Existing ChatGPT Tela profile data predates install ownership; it will be preserved by uninstall unless explicitly migrated later.");
    }
    runScript("profile:setup:build");
    const result = spawnSync(electronExecutable(), [resolve(repoRoot, "build/profile-setup/main.cjs")], {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        CHATGPT_TELA_PROFILE_SETUP_SLOT: String(profileSlot),
        CHATGPT_TELA_PROFILE_SETUP_REVEAL: "1",
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`profile setup exited with code ${result.status ?? -1}`);
  } catch (error) {
    primaryError = error;
  }
  try {
    releaseProductActivity({ path: activityPath, expected: activity });
  } catch (releaseError) {
    if (primaryError) throw new AggregateError([primaryError, releaseError], "profile setup failed and its activity lease could not be released");
    throw releaseError;
  }
  if (primaryError) throw primaryError;
}

function chatRootsPath(productPaths: ReturnType<typeof resolveProductPaths>): string {
  return join(productPaths.configRoot, "chat", "approved-roots-v1.json");
}

function chatAgentProvidersPath(productPaths: ReturnType<typeof resolveProductPaths>): string {
  return join(productPaths.configRoot, "chat", "agent-providers-v1.json");
}

function canonicalApprovedRoot(value: string): string {
  const absolute = resolve(value);
  if (!existsSync(absolute)) throw new Error(`workspace root does not exist: ${absolute}`);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("workspace root must be a real directory, not a symlink");
  }
  return realpathSync(absolute);
}

async function manageChatRoots(productPaths: ReturnType<typeof resolveProductPaths>): Promise<void> {
  const subcommand = process.argv[3] ?? "roots";
  if (subcommand === "agent-providers") {
    const path = chatAgentProvidersPath(productPaths);
    const config = readChatAgentProvidersConfig(path);
    const credentialStore = createPlatformCredentialStore({ stateRoot: productPaths.stateRoot });
    const credentialStoreStatus = await credentialStore.status();
    const ownershipManifest = readOwnershipManifest(productPaths.installManifest);
    const credentialOwnership = ownershipManifest
      ? new CredentialOwnershipManager({
          store: credentialStore,
          manifestPath: productPaths.installManifest,
          installId: ownershipManifest.installId,
          productVersion: ownershipManifest.productVersion,
        })
      : undefined;
    const providers = await Promise.all(config.providers.map(async provider => {
      const credentialId = provider.credentialId;
      let credentialPresent = false;
      let credentialOwnedByInstall = false;
      if (credentialId && credentialStoreStatus.available && credentialOwnership && ownershipManifest) {
        try {
          credentialPresent = Boolean(await credentialOwnership.get(credentialId));
          const resource = credentialOwnership.resource(credentialId);
          credentialOwnedByInstall = resource
            ? await credentialOwnership.observe(resource, ownershipManifest) === "owned"
            : false;
        }
        catch { credentialPresent = false; }
      }
      return Object.freeze({
        id: provider.id,
        enabled: provider.enabled,
        model: provider.model,
        ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
        ...(credentialId ? { credentialId } : {}),
        availableInCurrentEnvironment: provider.apiKeyEnv
          ? Boolean(process.env[provider.apiKeyEnv]?.trim())
          : false,
        credentialPresent,
        credentialOwnedByInstall,
      });
    }));
    console.log(JSON.stringify({
      path,
      credentialStore: credentialStoreStatus,
      providers,
    }, null, 2));
    return;
  }
  if (subcommand === "configure-openai-agent") {
    const model = option("--model")?.trim();
    if (!model) throw new Error("chat configure-openai-agent requires --model <model-id>");
    const apiKeyEnv = option("--api-key-env")?.trim() || "OPENAI_API_KEY";
    const path = chatAgentProvidersPath(productPaths);
    writeChatAgentProvidersConfig(path, {
      version: 1,
      providers: [{
        id: "openai-responses",
        enabled: true,
        model,
        apiKeyEnv,
        credentialId: OPENAI_AGENT_API_KEY_CREDENTIAL_ID,
      }],
    });
    console.log(JSON.stringify({
      configured: true,
      provider: "openai-responses",
      model,
      apiKeyEnv,
      credentialId: OPENAI_AGENT_API_KEY_CREDENTIAL_ID,
      credentialAvailableInCurrentEnvironment: Boolean(process.env[apiKeyEnv]?.trim()),
      path,
      secretPersisted: false,
      requiresChatRestart: true,
    }, null, 2));
    return;
  }
  if (subcommand === "store-openai-api-key") {
    const fromEnv = option("--from-env")?.trim();
    const fromStdin = flag("--stdin");
    if (Boolean(fromEnv) === fromStdin) {
      throw new Error("chat store-openai-api-key requires exactly one of --from-env <NAME> or --stdin");
    }
    let secret: string;
    if (fromEnv) {
      secret = process.env[fromEnv]?.trim() ?? "";
      if (!secret) throw new Error(`environment variable ${fromEnv} is empty or missing`);
    } else {
      if (process.stdin.isTTY) {
        throw new Error("--stdin requires piped input so the API key is not echoed in an interactive terminal");
      }
      secret = (await Bun.stdin.text()).trim();
      if (!secret) throw new Error("stdin did not contain an API key");
    }
    const credentialStore = createPlatformCredentialStore({ stateRoot: productPaths.stateRoot });
    const status = await credentialStore.status();
    if (!status.available) throw new Error(`platform credential store is unavailable: ${status.detail}`);
    const manifest = await ensureOwnershipManifest({ path: productPaths.installManifest, productVersion: "0.0.0" });
    const credentialOwnership = new CredentialOwnershipManager({
      store: credentialStore,
      manifestPath: productPaths.installManifest,
      installId: manifest.installId,
      productVersion: manifest.productVersion,
    });
    await credentialOwnership.storeOwned(OPENAI_AGENT_API_KEY_CREDENTIAL_ID, secret);
    console.log(JSON.stringify({
      stored: true,
      credentialId: OPENAI_AGENT_API_KEY_CREDENTIAL_ID,
      credentialStore: { kind: status.kind, available: status.available },
      secretPersistedInTelaConfig: false,
      requiresChatRestart: true,
    }, null, 2));
    return;
  }
  if (subcommand === "delete-openai-api-key") {
    const credentialStore = createPlatformCredentialStore({ stateRoot: productPaths.stateRoot });
    const status = await credentialStore.status();
    if (!status.available) throw new Error(`platform credential store is unavailable: ${status.detail}`);
    const manifest = readOwnershipManifest(productPaths.installManifest);
    if (!manifest) {
      console.log(JSON.stringify({
        deleted: false,
        credentialId: OPENAI_AGENT_API_KEY_CREDENTIAL_ID,
        credentialStore: { kind: status.kind, available: status.available },
        requiresChatRestart: false,
      }, null, 2));
      return;
    }
    const credentialOwnership = new CredentialOwnershipManager({
      store: credentialStore,
      manifestPath: productPaths.installManifest,
      installId: manifest.installId,
      productVersion: manifest.productVersion,
    });
    const deletion = await credentialOwnership.deleteOwned(OPENAI_AGENT_API_KEY_CREDENTIAL_ID);
    console.log(JSON.stringify({
      deleted: deletion.deleted,
      detail: deletion.detail,
      credentialId: OPENAI_AGENT_API_KEY_CREDENTIAL_ID,
      credentialStore: { kind: status.kind, available: status.available },
      requiresChatRestart: deletion.deleted,
    }, null, 2));
    return;
  }
  if (subcommand === "disable-openai-agent") {
    const path = chatAgentProvidersPath(productPaths);
    const current = readChatAgentProvidersConfig(path);
    writeChatAgentProvidersConfig(path, {
      version: 1,
      providers: current.providers.map(provider => provider.id === "openai-responses"
        ? { ...provider, enabled: false }
        : provider),
    });
    console.log(JSON.stringify({ disabled: "openai-responses", path, requiresChatRestart: true }, null, 2));
    return;
  }
  const path = chatRootsPath(productPaths);
  const current = readChatApprovedRootsConfig(path);
  if (subcommand === "roots") {
    console.log(JSON.stringify({ path, roots: current.roots }, null, 2));
    return;
  }
  const requested = option("--path");
  if (!requested) throw new Error(`chat ${subcommand} requires --path <workspace-root>`);
  if (subcommand === "allow-root") {
    const root = canonicalApprovedRoot(requested);
    writeChatApprovedRootsConfig(path, { version: 1, roots: [...current.roots, root] });
    console.log(JSON.stringify({ allowed: root, path, requiresChatRestart: true }, null, 2));
    return;
  }
  if (subcommand === "disallow-root") {
    const requestedAbsolute = existsSync(resolve(requested)) ? realpathSync(resolve(requested)) : resolve(requested);
    writeChatApprovedRootsConfig(path, { version: 1,
      roots: current.roots.filter(root => root !== requestedAbsolute) });
    console.log(JSON.stringify({ disallowed: requestedAbsolute, path, requiresChatRestart: true }, null, 2));
    return;
  }
  throw new Error("chat command is unsupported");
}

async function manageIngress(
  productPaths: ReturnType<typeof resolveProductPaths>,
): Promise<void> {
  const subcommand = process.argv[3] ?? "status";
  const config = readEffectiveProductConfig(productPaths);
  if (config.exposure.kind !== "tailscale-funnel") {
    throw new Error("ingress management requires configure --manage-tailscale-funnel");
  }
  if (subcommand === "status") {
    console.log(JSON.stringify(await diagnoseConfiguredIngress(productPaths), null, 2));
    return;
  }
  const manifest = await ensureOwnershipManifest({ path: productPaths.installManifest, productVersion: "0.0.0" });
  const manager = new TailscaleFunnelLeaseManager({
    runner: new SystemTailscaleCommandRunner(config.exposure.tailscaleCli),
    manifestPath: productPaths.installManifest,
    installId: manifest.installId,
    productVersion: manifest.productVersion,
  });
  const lease = createTailscaleFunnelLease({
    publicUrl: config.exposure.publicUrl,
    localTarget: `http://127.0.0.1:${config.exposure.localPort}/mcp`,
  });
  if (subcommand === "adopt-existing") {
    const physical = await manager.inspect(lease);
    if (physical.state !== "owned") {
      throw new Error(`cannot adopt Funnel path because its exact current mapping is not present (${physical.state})`);
    }
    const result = await manager.acquire(lease, { adoptExisting: true });
    console.log(JSON.stringify({ ...result, ownership: manager.ownership(lease) }, null, 2));
    return;
  }
  throw new Error("ingress command must be status or adopt-existing");
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  const productPaths = resolveProductPaths();
  if (command === "version") {
    console.log("ChatGPT Tela 0.0.0 (pre-alpha)");
    return;
  }
  if (command === "configure") {
    await configure(productPaths);
    return;
  }
  if (command === "paths") {
    console.log(JSON.stringify({
      binaryRoot: productPaths.binaryRoot,
      configRoot: productPaths.configRoot,
      stateRoot: productPaths.stateRoot,
      cacheRoot: productPaths.cacheRoot,
      logsRoot: productPaths.logsRoot,
      runtimeRoot: productPaths.runtimeRoot,
      installManifest: productPaths.installManifest,
      services: {
        gateway: {
          state: productPaths.serviceState("gateway"),
          runtime: productPaths.serviceRuntime("gateway"),
        },
        chat: {
          state: productPaths.serviceState("chat"),
          runtime: productPaths.serviceRuntime("chat"),
        },
        codex: {
          state: productPaths.serviceState("codex"),
          runtime: productPaths.serviceRuntime("codex"),
        },
      },
    }, null, 2));
    return;
  }
  if (command === "doctor") {
    const configured = hasEffectiveProductConfig(productPaths);
    console.log(JSON.stringify({
      stage: "pre-alpha",
      defaultDesktop: await diagnoseDefaultDesktop(),
      ingress: await diagnoseConfiguredIngress(productPaths),
      productConfigured: configured,
      optionalMultiProfileConfigured: configured
        ? Boolean(readEffectiveProductConfig(productPaths).multiProfile)
        : false,
      packagedTransitions: packagedTransitionStatus(productPaths),
      mutating: false,
    }, null, 2));
    return;
  }
  if (command === "diagnostics") {
    const subcommand = process.argv[3];
    if (subcommand === "workload") {
      const minutesRaw = option("--minutes");
      const minutes = minutesRaw === undefined ? 15 : Number(minutesRaw);
      console.log(JSON.stringify(summarizeDiagnosticWorkload({
        paths: diagnosticWorkloadPaths(productPaths),
        minutes,
      }), null, 2));
      return;
    }
    if (subcommand !== undefined) throw new Error("usage: chatgpt-tela diagnostics [workload [--minutes <1-120>]]");
    console.log(JSON.stringify(diagnosticsSummary(productPaths), null, 2));
    return;
  }
  if (command === "retention-canary") {
    const minutesRaw = option("--minutes");
    const minutes = minutesRaw === undefined ? 15 : Number(minutesRaw);
    console.log(JSON.stringify(summarizeRetentionCanary({
      paths: diagnosticWorkloadPaths(productPaths),
      minutes,
    }), null, 2));
    return;
  }
  if (command === "uninstall") {
    const dryRun = flag("--dry-run");
    const apply = flag("--apply");
    if (dryRun === apply) throw new Error("uninstall requires exactly one of --dry-run or --apply");
    console.log(JSON.stringify(await runProductUninstall({
      mode: apply ? "apply" : "dry-run",
      removeData: flag("--remove-data"),
      paths: productPaths,
    }), null, 2));
    return;
  }
  if (command === "chat") {
    await manageChatRoots(productPaths);
    return;
  }
  if (command === "approval") {
    manageApprovalPreferences();
    return;
  }
  if (command === "ingress") {
    await manageIngress(productPaths);
    return;
  }
  if (command === "setup") {
    await setupProfile(slot(), productPaths);
    return;
  }
  if (command === "start") {
    const services = await ensureSourceServices(productPaths);
    const result = await services.codex.startProfile(slot());
    console.log(JSON.stringify({
      ...result,
      ...(services.chatError ? { chatServiceWarning: services.chatError } : {}),
    }, null, 2));
    return;
  }
  if (command === "stop") {
    const profileSlot = slot();
    const manifest = readOwnershipManifest(productPaths.installManifest);
    if (!manifest) {
      console.log(JSON.stringify({ codex: "stopped", slot: profileSlot }, null, 2));
      return;
    }
    const supervisor = new LocalServiceSupervisor({ installId: manifest.installId });
    const running = await supervisor.current({ service: "codex", descriptorPath: serviceDescriptorPath(productPaths, "codex") });
    if (!running) {
      console.log(JSON.stringify({ codex: "stopped", slot: profileSlot }, null, 2));
      return;
    }
    const codex = new CodexServiceClient(descriptorForService(running.descriptor, "codex"));
    const result = await codex.stopProfile(profileSlot);
    const profiles = await codex.profiles();
    const stillOwned = profiles.some(profile => profile.controlState === "running" || profile.controlState === "orphaned");
    if (!stillOwned) {
      const failures: unknown[] = [];
      try { await supervisor.shutdown({ service: "gateway", descriptorPath: serviceDescriptorPath(productPaths, "gateway") }); }
      catch (error) { failures.push(error); }
      try { await supervisor.shutdown({ service: "codex", descriptorPath: serviceDescriptorPath(productPaths, "codex") }); }
      catch (error) { failures.push(error); }
      if (failures.length > 0) throw new AggregateError(failures, "profile stopped but split service shutdown was incomplete");
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "shutdown") {
    const failures: unknown[] = [];
    const manifest = readOwnershipManifest(productPaths.installManifest);
    const stopped: TelaServiceId[] = [];
    if (manifest) {
      const supervisor = new LocalServiceSupervisor({ installId: manifest.installId });
      try {
        if (await supervisor.shutdown({ service: "gateway", descriptorPath: serviceDescriptorPath(productPaths, "gateway") })) {
          stopped.push("gateway");
        }
      } catch (error) { failures.push(error); }
      const backendResults = await Promise.allSettled((["chat", "codex"] as const).map(async service => {
        if (await supervisor.shutdown({ service, descriptorPath: serviceDescriptorPath(productPaths, service) })) stopped.push(service);
      }));
      for (const result of backendResults) if (result.status === "rejected") failures.push(result.reason);
    }
    console.log(JSON.stringify({ stoppedServices: stopped }, null, 2));
    if (failures.length > 0) throw new AggregateError(failures, "one or more Tela services did not shut down normally");
    return;
  }
  if (command === "status" || command === "profiles") {
    const manifest = readOwnershipManifest(productPaths.installManifest);
    if (!manifest) {
      console.log(JSON.stringify({
        stage: "pre-alpha",
        publicMcpAbi: publicMcpStatus(productPaths),
        executableBridge: "live-canary-proven",
        connectorSetup: "manual-pre-alpha",
        runtime: "split-services",
        services: {
          gateway: { state: "stopped" },
          chat: { state: "stopped" },
          codex: { state: "stopped" },
        },
        packagedTransitions: packagedTransitionStatus(productPaths),
        configured: hasEffectiveProductConfig(productPaths),
      }, null, 2));
      return;
    }
    const supervisor = new LocalServiceSupervisor({ installId: manifest.installId });
    const codexRunning = await supervisor.current({ service: "codex", descriptorPath: serviceDescriptorPath(productPaths, "codex") })
      .catch(() => undefined);
    const profiles = codexRunning
      ? await new CodexServiceClient(descriptorForService(codexRunning.descriptor, "codex")).profiles().catch(() => [])
      : [];
    if (command === "profiles") {
      console.log(JSON.stringify(profiles, null, 2));
      return;
    }
    const [gatewayStatus, chatStatus, codexStatus, ingressStatus] = await Promise.all([
      serviceStatus(supervisor, productPaths, "gateway"),
      serviceStatus(supervisor, productPaths, "chat"),
      serviceStatus(supervisor, productPaths, "codex"),
      diagnoseConfiguredIngress(productPaths),
    ]);
    console.log(JSON.stringify({
      stage: "pre-alpha",
      publicMcpAbi: publicMcpStatus(productPaths),
      executableBridge: "live-canary-proven",
      connectorSetup: "manual-pre-alpha",
      runtime: "split-services",
      services: { gateway: gatewayStatus, chat: chatStatus, codex: codexStatus },
      ingress: ingressStatus,
      profiles,
      packagedTransitions: packagedTransitionStatus(productPaths),
      configured: hasEffectiveProductConfig(productPaths),
    }, null, 2));
    return;
  }
  if (command === "model-canary") {
    const profileSlot = slot();
    const manifest = readOwnershipManifest(productPaths.installManifest);
    if (!manifest) throw new Error("model-canary requires a running Tela Codex service/profile");
    const supervisor = new LocalServiceSupervisor({ installId: manifest.installId });
    const running = await supervisor.current({
      service: "codex",
      descriptorPath: serviceDescriptorPath(productPaths, "codex"),
    });
    if (!running) throw new Error("model-canary requires a running Tela Codex service/profile");
    const codex = new CodexServiceClient(descriptorForService(running.descriptor, "codex"));
    console.log(JSON.stringify(await codex.modelSelectionCanary(profileSlot), null, 2));
    return;
  }
  if (command === "context-canary") {
    const profileSlot = slot();
    const manifest = readOwnershipManifest(productPaths.installManifest);
    if (!manifest) throw new Error("context-canary requires a running Tela Codex service/profile");
    const supervisor = new LocalServiceSupervisor({ installId: manifest.installId });
    const running = await supervisor.current({
      service: "codex",
      descriptorPath: serviceDescriptorPath(productPaths, "codex"),
    });
    if (!running) throw new Error("context-canary requires a running Tela Codex service/profile");
    const codex = new CodexServiceClient(descriptorForService(running.descriptor, "codex"));
    console.log(JSON.stringify(await codex.contextAttachmentCanary(profileSlot), null, 2));
    return;
  }
  console.log(
    "ChatGPT Tela — independent Chat and Codex runtimes.\n\n"
    + "Commands:\n"
    + "  version\n"
    + "  configure --public-mcp-url <https-url> --allow-unauthenticated-public-mcp [--multi-profile-launcher <path>] [--mcp-abi stable|unified-development] [--manage-tailscale-funnel] [--tailscale-cli <path-or-name>]\n"
    + "  paths\n"
    + "  doctor\n"
    + "  diagnostics\n"
    + "  diagnostics workload [--minutes <1-120>]\n"
    + "  retention-canary [--minutes <1-120>]\n"
    + "  uninstall (--dry-run | --apply) [--remove-data]\n"
    + "  chat roots\n"
    + "  chat allow-root --path <workspace-root>\n"
    + "  chat disallow-root --path <workspace-root>\n"
    + "  chat agent-providers\n"
    + "  chat configure-openai-agent --model <model-id> [--api-key-env OPENAI_API_KEY]\n"
    + "  chat store-openai-api-key (--from-env <NAME> | --stdin)\n"
    + "  chat delete-openai-api-key\n"
    + "  chat disable-openai-agent\n"
    + "  approval [status|enable|disable]\n"
    + "  ingress status\n"
    + "  ingress adopt-existing\n"
    + "  setup [--slot <n>]\n"
    + "  start [--slot <n>]\n"
    + "  stop [--slot <n>]\n"
    + "  profiles\n"
    + "  model-canary [--slot <n>]\n"
    + "  context-canary [--slot <n>]\n"
    + "  status\n"
    + "  shutdown",
  );
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
