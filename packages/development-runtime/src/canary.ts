import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CodexHomeCurrentTurnSource } from "@chatgpt-tela/codex";
import type { CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import {
  ExistingHttpsExposure,
  OpenAiSecureMcpTunnelExposure,
  fingerprintMcpToolContracts,
  type TunnelClientCommandRunner,
} from "@chatgpt-tela/mcp";
import {
  MultiProfileControlClient,
  type MultiProfileManagedRuntime,
  codexProcessRouteArguments,
} from "@chatgpt-tela/setup";
import {
  startElectronDevelopmentRuntime,
  type ElectronDevelopmentRuntime,
  type ElectronDevelopmentRuntimeOptions,
} from "./electron";
import type { DevelopmentMcpAbi } from "./runtime";
import {
  assertChatGptTelaAccountBinding,
  resolveChatGptTelaBrowserProfile,
  type ChatGptTelaBrowserProfile,
} from "./browser-profile";
import { FileContextCheckpointCache } from "./context-cache";

export interface ExistingHttpsCanaryMcpConfig {
  readonly kind: "existing-https";
  readonly localPort: number;
  readonly publicUrl: URL;
  readonly authentication:
    | { readonly kind: "none" }
    | {
        readonly kind: "bearer";
        readonly token: string;
        readonly secretReference: string;
      };
  readonly allowUnauthenticatedPublicEndpoint: boolean;
}

export interface OpenAiSecureTunnelCanaryMcpConfig {
  readonly kind: "openai-secure-tunnel";
  readonly localPort: number;
  readonly tunnelClient: string;
  readonly runtimeAlias: string;
  readonly tunnelId: string;
  readonly runtimeApiKey: string;
}

export type DevelopmentCanaryMcpConfig =
  | ExistingHttpsCanaryMcpConfig
  | OpenAiSecureTunnelCanaryMcpConfig;

export interface DevelopmentCanaryPreflightConfig {
  readonly nativeProfile: DevelopmentCanaryConfig["nativeProfile"];
  readonly browserProfile: ChatGptTelaBrowserProfile;
  readonly chatGptTelaProfileId: string;
  readonly browserUserDataDir: string;
  readonly responsesPort: number;
  readonly mcpAbi: DevelopmentMcpAbi;
  readonly mcp:
    | {
        readonly kind: "existing-https";
        readonly localPort: number;
        readonly publicUrl: URL;
        readonly authentication: "bearer" | "none";
        readonly allowUnauthenticatedPublicEndpoint: boolean;
      }
    | {
        readonly kind: "openai-secure-tunnel";
        readonly localPort: number;
        readonly tunnelClient: string;
        readonly runtimeAlias: string;
        readonly tunnelId: string;
      };
}

export interface DevelopmentCanaryConfig {
  readonly nativeProfile:
    | {
        readonly kind: "stock";
        readonly codexHome: string;
        readonly sqliteHome: string;
      }
    | {
        readonly kind: "multi-profile";
        readonly controlCli: string;
        readonly targetId: string;
      };
  readonly chatGptTelaProfileId: string;
  readonly browserUserDataDir: string;
  readonly browserProfile: ChatGptTelaBrowserProfile;
  readonly connectorName: string;
  readonly contextCacheDir: string;
  readonly webContextBudgetTokens?: number;
  readonly webTurnTimeoutMs: number;
  readonly responsesPort: number;
  readonly responsesToken: string;
  readonly mcpAbi: DevelopmentMcpAbi;
  readonly mcp: DevelopmentCanaryMcpConfig;
}

const DEFAULT_CANARY_WEB_TURN_TIMEOUT_MS = 120_000;

export interface DevelopmentCanaryRuntime {
  readonly config: DevelopmentCanaryConfig;
  readonly runtime: ElectronDevelopmentRuntime;
  readonly mcpAbi: DevelopmentMcpAbi;
  readonly mcpSchemaFingerprint: string;
  readonly nativeProfile:
    | {
        readonly kind: "stock";
        readonly processRoute: {
          readonly arguments: readonly string[];
          readonly envKey: "CHATGPT_TELA_CANARY_RESPONSES_TOKEN";
        };
      }
    | {
        readonly kind: "multi-profile";
        readonly targetId: string;
        readonly endpoint: string;
        readonly responsesRouteFingerprint: string;
      };
  stop(): Promise<void>;
}

function required(env: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`development canary requires ${key}`);
  return value;
}

function optional(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

const MAX_CANARY_SECRET_BYTES = 4096;

function secretValue(
  env: Readonly<Record<string, string | undefined>>,
  valueKey: string,
  fileKey: string,
): { readonly value: string; readonly reference: string } {
  const direct = optional(env, valueKey);
  const fileValue = optional(env, fileKey);
  if (direct && fileValue) {
    throw new Error(`development canary accepts only one of ${valueKey} or ${fileKey}`);
  }
  if (direct) return Object.freeze({ value: direct, reference: `environment:${valueKey}` });
  if (!fileValue) throw new Error(`development canary requires ${valueKey} or ${fileKey}`);

  const path = absolutePath(fileValue, fileKey);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${fileKey} does not exist: ${path}`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${fileKey} must name a regular non-symlink file`);
  }
  if (stat.size < 1 || stat.size > MAX_CANARY_SECRET_BYTES) {
    throw new Error(`${fileKey} must contain between 1 and ${MAX_CANARY_SECRET_BYTES} bytes`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`${fileKey} must not grant group or world permissions`);
  }
  let raw = readFileSync(path, "utf8");
  if (raw.endsWith("\n")) raw = raw.slice(0, -1);
  if (raw.endsWith("\r")) raw = raw.slice(0, -1);
  if (!raw || /[\u0000\r\n]/.test(raw)) {
    throw new Error(`${fileKey} must contain exactly one non-empty secret line`);
  }
  return Object.freeze({ value: raw, reference: `file:${fileKey}` });
}

function explicitBoolean(value: string | undefined, key: string): boolean {
  if (value === undefined) return false;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${key} must be one of 1, 0, true, or false`);
}

function port(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${key} must be an integer TCP port from 1 to 65535`);
  }
  return parsed;
}

function optionalPositiveInteger(value: string | undefined, key: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function absoluteDirectory(value: string, key: string): string {
  const expanded = value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value);
  if (!isAbsolute(expanded)) throw new Error(`${key} must resolve to an absolute path`);
  if (!existsSync(expanded)) throw new Error(`${key} does not exist: ${expanded}`);
  return expanded;
}

function absolutePath(value: string, key: string): string {
  const expanded = value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value);
  if (!isAbsolute(expanded)) throw new Error(`${key} must resolve to an absolute path`);
  return expanded;
}

function absoluteFile(value: string, key: string): string {
  const path = absolutePath(value, key);
  if (!existsSync(path)) throw new Error(`${key} does not exist: ${path}`);
  return path;
}

function publicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("CHATGPT_TELA_CANARY_MCP_PUBLIC_URL must use HTTPS");
  return url;
}

/**
 * Load an explicit, secret-free-on-disk canary configuration from process environment.
 *
 * No default Codex home or profile is guessed: a canary must name the exact Native profile it is
 * allowed to observe. This avoids accidentally binding the development runtime to a different
 * production profile merely because it happens to be the user's default.
 */
export function loadDevelopmentCanaryConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DevelopmentCanaryConfig {
  const preflight = loadDevelopmentCanaryPreflightConfig(env);
  const connectorName = required(env, "CHATGPT_TELA_CANARY_CONNECTOR_NAME");
  if (connectorName.length > 128 || /[\u0000\r\n]/.test(connectorName)) {
    throw new Error("CHATGPT_TELA_CANARY_CONNECTOR_NAME must be 1-128 visible single-line characters");
  }
  const contextCacheDir = join(preflight.browserUserDataDir, "context-checkpoints");
  const webContextBudgetTokens = optionalPositiveInteger(
    optional(env, "CHATGPT_TELA_CANARY_WEB_CONTEXT_BUDGET_TOKENS"),
    "CHATGPT_TELA_CANARY_WEB_CONTEXT_BUDGET_TOKENS",
  );
  const webTurnTimeoutMs = optionalPositiveInteger(
    optional(env, "CHATGPT_TELA_CANARY_WEB_TURN_TIMEOUT_MS"),
    "CHATGPT_TELA_CANARY_WEB_TURN_TIMEOUT_MS",
  ) ?? DEFAULT_CANARY_WEB_TURN_TIMEOUT_MS;
  const responsesSecret = secretValue(
    env,
    "CHATGPT_TELA_CANARY_RESPONSES_TOKEN",
    "CHATGPT_TELA_CANARY_RESPONSES_TOKEN_FILE",
  );
  const responsesToken = responsesSecret.value;
  if (responsesToken.length < 32) {
    throw new Error("CHATGPT_TELA_CANARY_RESPONSES_TOKEN must contain at least 32 characters");
  }
  let mcp: DevelopmentCanaryMcpConfig;
  if (preflight.mcp.kind === "existing-https") {
    let authentication: ExistingHttpsCanaryMcpConfig["authentication"];
    if (preflight.mcp.authentication === "none") {
      authentication = { kind: "none" };
    } else {
      const bearerSecret = secretValue(
        env,
        "CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN",
        "CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN_FILE",
      );
      const token = bearerSecret.value;
      if (token.length < 32) {
        throw new Error("CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN must contain at least 32 characters");
      }
      authentication = {
        kind: "bearer",
        token,
        secretReference: optional(env, "CHATGPT_TELA_CANARY_MCP_BEARER_SECRET_REFERENCE")
          ?? bearerSecret.reference,
      };
    }
    mcp = Object.freeze({
      kind: "existing-https" as const,
      localPort: preflight.mcp.localPort,
      publicUrl: preflight.mcp.publicUrl,
      authentication: Object.freeze(authentication),
      allowUnauthenticatedPublicEndpoint: preflight.mcp.allowUnauthenticatedPublicEndpoint,
    });
  } else {
    const runtimeApiKey = secretValue(
      env,
      "CHATGPT_TELA_CANARY_OPENAI_TUNNEL_RUNTIME_API_KEY",
      "CHATGPT_TELA_CANARY_OPENAI_TUNNEL_RUNTIME_API_KEY_FILE",
    ).value;
    if (runtimeApiKey.length < 20) {
      throw new Error("CHATGPT_TELA_CANARY_OPENAI_TUNNEL_RUNTIME_API_KEY is too short");
    }
    mcp = Object.freeze({
      kind: "openai-secure-tunnel" as const,
      localPort: preflight.mcp.localPort,
      tunnelClient: preflight.mcp.tunnelClient,
      runtimeAlias: preflight.mcp.runtimeAlias,
      tunnelId: preflight.mcp.tunnelId,
      runtimeApiKey,
    });
  }

  return Object.freeze({
    nativeProfile: preflight.nativeProfile,
    browserProfile: preflight.browserProfile,
    chatGptTelaProfileId: preflight.chatGptTelaProfileId,
    browserUserDataDir: preflight.browserUserDataDir,
    connectorName,
    contextCacheDir,
    ...(webContextBudgetTokens !== undefined ? { webContextBudgetTokens } : {}),
    webTurnTimeoutMs,
    responsesPort: preflight.responsesPort,
    responsesToken,
    mcpAbi: preflight.mcpAbi,
    mcp,
  });
}

/** Load only non-secret prerequisites used by the read-only development canary preflight. */
export function loadDevelopmentCanaryPreflightConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DevelopmentCanaryPreflightConfig {
  const nativeMode = optional(env, "CHATGPT_TELA_CANARY_NATIVE_MODE") ?? "stock";
  const browserProfile = resolveChatGptTelaBrowserProfile({
    slot: required(env, "CHATGPT_TELA_CANARY_PROFILE_SLOT"),
    ...(optional(env, "CHATGPT_TELA_PROFILE_ROOT")
      ? { profileRoot: optional(env, "CHATGPT_TELA_PROFILE_ROOT")! }
      : {}),
    environment: env,
  });
  const responsesPort = port(required(env, "CHATGPT_TELA_CANARY_RESPONSES_PORT"), "CHATGPT_TELA_CANARY_RESPONSES_PORT");
  const mcpAbi = optional(env, "CHATGPT_TELA_CANARY_MCP_ABI") ?? "development";
  if (mcpAbi !== "development") {
    throw new Error("CHATGPT_TELA_CANARY_MCP_ABI must be development");
  }
  const localPort = port(required(env, "CHATGPT_TELA_CANARY_MCP_LOCAL_PORT"), "CHATGPT_TELA_CANARY_MCP_LOCAL_PORT");
  if (responsesPort === localPort) {
    throw new Error("CHATGPT_TELA_CANARY_RESPONSES_PORT and CHATGPT_TELA_CANARY_MCP_LOCAL_PORT must be different");
  }
  const mcpExposureKind = optional(env, "CHATGPT_TELA_CANARY_MCP_EXPOSURE") ?? "existing-https";
  for (const legacyKey of [
    "CHATGPT_TELA_CANARY_INSTALL_CODEX_ROUTE",
    "CHATGPT_TELA_CANARY_ROUTE_STATE_DIR",
    "CHATGPT_TELA_CANARY_REPLACE_CODEX_ROUTE",
  ] as const) {
    if (optional(env, legacyKey) !== undefined) {
      throw new Error(`${legacyKey} is no longer supported; stock canaries use process-local Codex overrides`);
    }
  }

  let mcp: DevelopmentCanaryPreflightConfig["mcp"];
  if (mcpExposureKind === "existing-https") {
    const authentication = optional(env, "CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH") ?? "bearer";
    if (authentication !== "bearer" && authentication !== "none") {
      throw new Error("CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH must be bearer or none");
    }
    const allowUnauthenticatedPublicEndpoint = explicitBoolean(
      optional(env, "CHATGPT_TELA_CANARY_ALLOW_UNAUTHENTICATED_PUBLIC_MCP"),
      "CHATGPT_TELA_CANARY_ALLOW_UNAUTHENTICATED_PUBLIC_MCP",
    );
    if (authentication === "none" && !allowUnauthenticatedPublicEndpoint) {
      throw new Error(
        "unauthenticated public MCP canary requires CHATGPT_TELA_CANARY_ALLOW_UNAUTHENTICATED_PUBLIC_MCP=1",
      );
    }
    mcp = Object.freeze({
      kind: "existing-https" as const,
      localPort,
      publicUrl: publicUrl(required(env, "CHATGPT_TELA_CANARY_MCP_PUBLIC_URL")),
      authentication,
      allowUnauthenticatedPublicEndpoint,
    });
  } else if (mcpExposureKind === "openai-secure-tunnel") {
    mcp = Object.freeze({
      kind: "openai-secure-tunnel" as const,
      localPort,
      tunnelClient: absoluteFile(
        required(env, "CHATGPT_TELA_TUNNEL_CLIENT"),
        "CHATGPT_TELA_TUNNEL_CLIENT",
      ),
      runtimeAlias: optional(env, "CHATGPT_TELA_CANARY_OPENAI_TUNNEL_ALIAS") ?? "chatgpt-tela-canary",
      tunnelId: required(env, "CHATGPT_TELA_CANARY_OPENAI_TUNNEL_ID"),
    });
  } else {
    throw new Error("CHATGPT_TELA_CANARY_MCP_EXPOSURE must be existing-https or openai-secure-tunnel");
  }

  let nativeProfile: DevelopmentCanaryConfig["nativeProfile"];
  if (nativeMode === "stock") {
    if (browserProfile.slot !== 1) {
      throw new Error("stock canary must use CHATGPT_TELA_CANARY_PROFILE_SLOT=1");
    }
    const codexHome = absoluteDirectory(
      required(env, "CHATGPT_TELA_CANARY_CODEX_HOME"),
      "CHATGPT_TELA_CANARY_CODEX_HOME",
    );
    const sqliteHome = absoluteDirectory(
      optional(env, "CHATGPT_TELA_CANARY_CODEX_SQLITE_HOME") ?? codexHome,
      "CHATGPT_TELA_CANARY_CODEX_SQLITE_HOME",
    );
    nativeProfile = Object.freeze({
      kind: "stock" as const,
      codexHome,
      sqliteHome,
    });
  } else if (nativeMode === "multi-profile") {
    const targetId = required(env, "CHATGPT_TELA_CANARY_PLURA_DESKTOP_TARGET");
    const encodedSlot = /\.profile([1-9][0-9]*)$/.exec(targetId)?.[1];
    if (encodedSlot && Number(encodedSlot) !== browserProfile.slot) {
      throw new Error(
        `Multi-Profile target ${targetId} must use CHATGPT_TELA_CANARY_PROFILE_SLOT=${encodedSlot}`,
      );
    }
    nativeProfile = Object.freeze({
      kind: "multi-profile" as const,
      controlCli: absoluteFile(
        required(env, "CHATGPT_TELA_PLURA_DESKTOP_CLI"),
        "CHATGPT_TELA_PLURA_DESKTOP_CLI",
      ),
      targetId,
    });
  } else {
    throw new Error("CHATGPT_TELA_CANARY_NATIVE_MODE must be stock or multi-profile");
  }

  return Object.freeze({
    nativeProfile,
    browserProfile,
    chatGptTelaProfileId: browserProfile.profileId,
    browserUserDataDir: browserProfile.userDataDir,
    responsesPort,
    mcpAbi,
    mcp,
  });
}

class LateBoundCurrentTurnSource implements CanonicalCurrentTurnSource {
  #source: CanonicalCurrentTurnSource | undefined;

  bind(source: CanonicalCurrentTurnSource): void {
    if (this.#source) throw new Error("managed current-turn source is already bound");
    this.#source = source;
  }

  currentTurn(threadId: string) {
    if (!this.#source) {
      throw new Error("managed current-turn source is not bound yet");
    }
    return this.#source.currentTurn(threadId);
  }
}

async function inspectCanaryMcpEndpoint(input: {
  readonly endpoint: URL;
  readonly authentication: ExistingHttpsCanaryMcpConfig["authentication"];
  readonly abi: DevelopmentMcpAbi;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const headers = input.authentication.kind === "bearer"
    ? { authorization: `Bearer ${input.authentication.token}` }
    : undefined;
  const transport = new StreamableHTTPClientTransport(input.endpoint, {
    ...(headers ? { requestInit: { headers } } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const client = new Client({ name: "chatgpt-tela-canary-probe", version: "0.0.0" }, { capabilities: {} });
  try {
    if (input.signal?.aborted) throw new DOMException("canary MCP verification aborted", "AbortError");
    await client.connect(transport as unknown as Transport);
    const tools = await client.listTools();
    const names = tools.tools.map(tool => tool.name).sort();
    const expectedNames = ["chatgpt_tela_dev_tool_call", "chatgpt_tela_dev_tool_inventory"].sort();
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
      throw new Error(`public MCP endpoint does not expose the expected ChatGPT Tela ${input.abi} contract`);
    }
    const fingerprint = fingerprintMcpToolContracts(tools.tools.map(tool => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema as Readonly<Record<string, unknown>>,
    })));
    return fingerprint;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Start the first real-development canary composition for one explicitly selected Native profile.
 *
 * Stock mode uses the explicit local Codex home for Native authority and exposes process-local Codex
 * override arguments; it never rewrites the user's config.toml. Multi-Profile mode never reads that launcher's private profile paths: the ChatGPT Tela
 * Responses listener starts first, the public launch-target contract returns a canonical app-server
 * endpoint, and Native authority is bound through that endpoint. ChatGPT connector creation remains
 * outside this runtime in both modes.
 */
export async function startDevelopmentCanary(
  config: DevelopmentCanaryConfig,
  options: {
    readonly electron?: ElectronDevelopmentRuntimeOptions["electron"];
    readonly provider?: ElectronDevelopmentRuntimeOptions["provider"];
    readonly accountIdentityObserver?: ElectronDevelopmentRuntimeOptions["accountIdentityObserver"];
    readonly fetch?: FetchLike;
    readonly signal?: AbortSignal;
    readonly multiProfileClient?: MultiProfileControlClient;
    readonly tunnelClientRunner?: TunnelClientCommandRunner;
  } = {},
): Promise<DevelopmentCanaryRuntime> {
  const lateBoundSource = config.nativeProfile.kind === "multi-profile"
    ? new LateBoundCurrentTurnSource()
    : undefined;
  const currentTurnSource = config.nativeProfile.kind === "stock"
    ? new CodexHomeCurrentTurnSource({
        codexHome: config.nativeProfile.codexHome,
        sqliteHome: config.nativeProfile.sqliteHome,
      })
    : lateBoundSource!;
  const mcpConfig = config.mcp;
  const mcpRuntime: ElectronDevelopmentRuntimeOptions["mcp"] = mcpConfig.kind === "existing-https"
    ? {
        kind: "http-exposure",
        abi: config.mcpAbi,
        local: {
          port: mcpConfig.localPort,
          authentication: mcpConfig.authentication.kind === "bearer"
            ? { kind: "bearer", token: mcpConfig.authentication.token }
            : { kind: "none" },
        },
        allowUnauthenticatedPublicEndpoint: mcpConfig.allowUnauthenticatedPublicEndpoint,
        exposure: () => new ExistingHttpsExposure({
          url: mcpConfig.publicUrl,
          authentication: mcpConfig.authentication.kind === "bearer"
            ? { kind: "bearer", secretReference: mcpConfig.authentication.secretReference }
            : { kind: "none" },
          probe: async (endpoint, signal) => {
            try {
              await inspectCanaryMcpEndpoint({
                endpoint: endpoint.url,
                authentication: mcpConfig.authentication,
                abi: config.mcpAbi,
                ...(options.fetch ? { fetch: options.fetch } : {}),
                ...(signal ? { signal } : {}),
              });
              return { ready: true };
            } catch (error) {
              return {
                ready: false,
                detail: error instanceof Error ? error.message : String(error),
              };
            }
          },
        }),
      }
    : {
        kind: "http-exposure",
        abi: config.mcpAbi,
        local: {
          port: mcpConfig.localPort,
          authentication: { kind: "none" },
        },
        exposure: local => new OpenAiSecureMcpTunnelExposure({
          tunnelClient: mcpConfig.tunnelClient,
          alias: mcpConfig.runtimeAlias,
          tunnelId: mcpConfig.tunnelId,
          runtimeApiKey: mcpConfig.runtimeApiKey,
          local,
          ...(options.tunnelClientRunner ? { runner: options.tunnelClientRunner } : {}),
        }),
      };
  const runtime = await startElectronDevelopmentRuntime({
    profileId: config.chatGptTelaProfileId,
    connectorName: config.connectorName,
    currentTurnSource,
    webTurnTimeoutMs: config.webTurnTimeoutMs,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.accountIdentityObserver ? { accountIdentityObserver: options.accountIdentityObserver } : {}),
    context: {
      checkpointCache: new FileContextCheckpointCache({ directory: config.contextCacheDir }),
      ...(config.webContextBudgetTokens !== undefined
        ? { budgetTokens: config.webContextBudgetTokens }
        : {}),
    },
    mcp: mcpRuntime,
    responses: { port: config.responsesPort, runtimeToken: config.responsesToken },
    electron: {
      ...(options.electron ?? {}),
      userDataDir: config.browserUserDataDir,
    },
  });

  let managedRuntime: MultiProfileManagedRuntime | undefined;
  let multiProfileClient: MultiProfileControlClient | undefined;
  let mcpSchemaFingerprint: string | undefined;
  try {
    if (runtime.mcp.kind !== "http-exposure") {
      throw new Error("development canary requires HTTP MCP exposure mode");
    }
    const localMcp = runtime.mcp.exposure.local;
    mcpSchemaFingerprint = await inspectCanaryMcpEndpoint({
      endpoint: localMcp.endpointUrl,
      authentication: localMcp.authentication === "bearer"
        ? {
            kind: "bearer",
            token: localMcp.bearerToken!,
            secretReference: "runtime:local-development-mcp",
          }
        : { kind: "none" },
      abi: config.mcpAbi,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const observed = await runtime.probeChatGptProfile(options.signal);
    assertChatGptTelaAccountBinding(config.browserProfile, observed.account.accountFingerprint);
    if (config.nativeProfile.kind !== "stock") {
      multiProfileClient = options.multiProfileClient ?? new MultiProfileControlClient({
        command: [config.nativeProfile.controlCli],
      });
      managedRuntime = await multiProfileClient.launchManagedTarget({
        targetId: config.nativeProfile.targetId,
        responsesBaseUrl: runtime.responses.baseUrl,
        responsesEnvKey: "CHATGPT_TELA_CANARY_RESPONSES_TOKEN",
        responsesToken: config.responsesToken,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      lateBoundSource!.bind(managedRuntime.currentTurnSource);
    }
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await runtime.stop();
    } catch (stopError) {
      failures.push(stopError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "ChatGPT Tela development canary startup rollback was incomplete");
    }
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return Object.freeze({
    config,
    runtime,
    mcpAbi: config.mcpAbi,
    mcpSchemaFingerprint: mcpSchemaFingerprint!,
    nativeProfile: managedRuntime
      ? Object.freeze({
          kind: "multi-profile" as const,
          targetId: managedRuntime.session.targetId,
          endpoint: managedRuntime.session.endpoint,
          responsesRouteFingerprint: managedRuntime.session.responsesRouteFingerprint,
        })
      : Object.freeze({
          kind: "stock" as const,
          processRoute: Object.freeze({
            arguments: codexProcessRouteArguments({
              baseUrl: runtime.responses.baseUrl,
              envKey: "CHATGPT_TELA_CANARY_RESPONSES_TOKEN",
            }),
            envKey: "CHATGPT_TELA_CANARY_RESPONSES_TOKEN" as const,
          }),
        }),
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        const failures: unknown[] = [];
        if (managedRuntime && multiProfileClient) {
          const session = await multiProfileClient.targetSession(
            managedRuntime.session.targetId,
            options.signal,
          );
          if (session.state === "ready") {
            if (session.responsesRouteFingerprint !== managedRuntime.session.responsesRouteFingerprint) {
              throw new Error(
                "managed Multi-Profile target changed Responses route ownership while the canary was running",
              );
            }
            throw new Error(
              `managed Multi-Profile target is still running; quit ${managedRuntime.target.displayName} normally before stopping ChatGPT Tela`,
            );
          }
        }
        try {
          await runtime.stop();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "ChatGPT Tela development canary shutdown did not fully restore owned state");
        }
      })().catch(error => {
        stopping = undefined;
        throw error;
      });
      return stopping;
    },
  });
}
