import type { TurnCapabilityResolver } from "@chatgpt-tela/runtime";
import type { TurnBridgeBackend } from "./turn-bridge";
import {
  startCustomMcpHttpServer,
  startCodexBridgeMcpHttpServer,
  startDevelopmentMcpHttpServer,
  type CodexBridgeMcpHttpAuthentication,
  type CodexBridgeMcpHttpServer,
  type DevelopmentMcpHttpAuthentication,
  type DevelopmentMcpHttpServer,
  type CustomMcpHttpAuthentication,
  type CustomMcpHttpServer,
  type McpHttpAuthentication,
  type McpHttpServer,
} from "./http-server";
import type {
  McpEndpoint,
  McpExposureProvider,
} from "./exposure";

export interface DevelopmentMcpHttpExposure {
  readonly kind: "http-exposure";
  readonly local: DevelopmentMcpHttpServer;
  readonly publicEndpoint: McpEndpoint;
  readonly exposureKind: string;
  close(): Promise<void>;
}

export type DevelopmentMcpExposureFactory = (
  local: DevelopmentMcpHttpServer,
) => McpExposureProvider | Promise<McpExposureProvider>;

export interface CodexBridgeMcpHttpExposure {
  readonly kind: "http-exposure";
  readonly local: CodexBridgeMcpHttpServer;
  readonly publicEndpoint: McpEndpoint;
  readonly exposureKind: string;
  close(): Promise<void>;
}

export type CodexBridgeMcpExposureFactory = (
  local: CodexBridgeMcpHttpServer,
) => McpExposureProvider | Promise<McpExposureProvider>;

export type CustomMcpExposureFactory = (
  local: CustomMcpHttpServer,
) => McpExposureProvider | Promise<McpExposureProvider>;

export interface CustomMcpHttpExposure {
  readonly kind: "http-exposure";
  readonly local: CustomMcpHttpServer;
  readonly publicEndpoint: McpEndpoint;
  readonly exposureKind: string;
  close(): Promise<void>;
}

export async function startCustomMcpHttpExposure(input: {
  readonly createServer: () => import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
  readonly label: string;
  readonly exposure: CustomMcpExposureFactory;
  readonly local?: {
    readonly hostname?: string;
    readonly port?: number;
    readonly path?: string;
    readonly authentication?: CustomMcpHttpAuthentication;
    readonly maxRequestBodyBytes?: number;
    readonly maxSessions?: number;
  };
  readonly allowUnauthenticatedPublicEndpoint?: boolean;
  readonly signal?: AbortSignal;
}): Promise<CustomMcpHttpExposure> {
  return startMcpHttpExposure({
    exposure: input.exposure,
    ...(input.local ? { local: input.local } : {}),
    ...(input.allowUnauthenticatedPublicEndpoint !== undefined
      ? { allowUnauthenticatedPublicEndpoint: input.allowUnauthenticatedPublicEndpoint }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    startLocal: local => startCustomMcpHttpServer({
      createServer: input.createServer,
      label: input.label,
      ...local,
    }),
  });
}

/**
 * Bind ChatGPT Tela's local Streamable HTTP MCP server to a replaceable public HTTPS exposure.
 *
 * Existing operator-managed routes (for example a DevSpace-managed Tailscale Funnel) can simply
 * return an ExistingHttpsExposure from the factory. A future managed exposure can instead inspect
 * `local.endpointUrl` and create its own route. ChatGPT Tela owns only lifecycles it explicitly starts.
 */
export async function startDevelopmentMcpHttpExposure(input: {
  readonly turns: TurnCapabilityResolver;
  readonly exposure: DevelopmentMcpExposureFactory;
  readonly local?: {
    readonly hostname?: string;
    readonly port?: number;
    readonly path?: string;
    readonly authentication?: DevelopmentMcpHttpAuthentication;
    readonly maxRequestBodyBytes?: number;
    readonly maxSessions?: number;
  };
  readonly allowUnauthenticatedPublicEndpoint?: boolean;
  readonly signal?: AbortSignal;
}): Promise<DevelopmentMcpHttpExposure> {
  return startMcpHttpExposure({
    exposure: input.exposure,
    ...(input.local ? { local: input.local } : {}),
    ...(input.allowUnauthenticatedPublicEndpoint !== undefined
      ? { allowUnauthenticatedPublicEndpoint: input.allowUnauthenticatedPublicEndpoint }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    startLocal: local => startDevelopmentMcpHttpServer({ turns: input.turns, ...local }),
  });
}

export async function startCodexBridgeMcpHttpExposure(input: ({
  readonly turns: TurnCapabilityResolver;
  readonly bridge?: never;
} | {
  readonly bridge: TurnBridgeBackend;
  readonly turns?: never;
}) & {
  readonly exposure: CodexBridgeMcpExposureFactory;
  readonly local?: {
    readonly hostname?: string;
    readonly port?: number;
    readonly path?: string;
    readonly authentication?: CodexBridgeMcpHttpAuthentication;
    readonly maxRequestBodyBytes?: number;
    readonly maxSessions?: number;
  };
  readonly allowUnauthenticatedPublicEndpoint?: boolean;
  readonly signal?: AbortSignal;
}): Promise<CodexBridgeMcpHttpExposure> {
  return startMcpHttpExposure({
    exposure: input.exposure,
    ...(input.local ? { local: input.local } : {}),
    ...(input.allowUnauthenticatedPublicEndpoint !== undefined
      ? { allowUnauthenticatedPublicEndpoint: input.allowUnauthenticatedPublicEndpoint }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    startLocal: local => startCodexBridgeMcpHttpServer({
      ...(input.bridge ? { bridge: input.bridge } : { turns: input.turns }),
      ...local,
    }),
  });
}

async function startMcpHttpExposure(input: {
  readonly exposure: (local: McpHttpServer) => McpExposureProvider | Promise<McpExposureProvider>;
  readonly startLocal: (input: {
    readonly hostname?: string;
    readonly port?: number;
    readonly path?: string;
    readonly authentication?: McpHttpAuthentication;
    readonly maxRequestBodyBytes?: number;
    readonly maxSessions?: number;
  }) => Promise<McpHttpServer>;
  readonly local?: {
    readonly hostname?: string;
    readonly port?: number;
    readonly path?: string;
    readonly authentication?: McpHttpAuthentication;
    readonly maxRequestBodyBytes?: number;
    readonly maxSessions?: number;
  };
  readonly allowUnauthenticatedPublicEndpoint?: boolean;
  readonly signal?: AbortSignal;
}): Promise<DevelopmentMcpHttpExposure> {
  const local = await input.startLocal({
    ...(input.local?.hostname ? { hostname: input.local.hostname } : {}),
    ...(input.local?.port !== undefined ? { port: input.local.port } : {}),
    ...(input.local?.path ? { path: input.local.path } : {}),
    ...(input.local?.authentication ? { authentication: input.local.authentication } : {}),
    ...(input.local?.maxRequestBodyBytes !== undefined
      ? { maxRequestBodyBytes: input.local.maxRequestBodyBytes }
      : {}),
    ...(input.local?.maxSessions !== undefined ? { maxSessions: input.local.maxSessions } : {}),
  });
  let exposure: McpExposureProvider | undefined;
  try {
    exposure = await input.exposure(local);
    const publicEndpoint = await exposure.prepare(input.signal);
    if (publicEndpoint.kind === "https") {
      if (publicEndpoint.url.protocol !== "https:") {
        throw new Error("public MCP exposure must use HTTPS");
      }
      if (publicEndpoint.authentication.kind === "none"
        && input.allowUnauthenticatedPublicEndpoint !== true) {
        throw new Error("public MCP exposure must require authentication");
      }
    } else if (publicEndpoint.authentication.kind !== "openai-tunnel") {
      throw new Error("Secure MCP Tunnel exposure must use OpenAI tunnel authentication");
    }
    const health = await exposure.verify(publicEndpoint, input.signal);
    if (!health.ready) {
      throw new Error(`public MCP exposure verification failed${health.detail ? `: ${health.detail}` : ""}`);
    }

    let stopping: Promise<void> | undefined;
    return Object.freeze({
      kind: "http-exposure" as const,
      local,
      publicEndpoint,
      exposureKind: exposure.kind,
      close() {
        if (stopping) return stopping;
        stopping = (async () => {
          const results = await Promise.allSettled([
            exposure!.stop(),
            local.stop(),
          ]);
          const failures = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map(result => result.reason);
          if (failures.length > 0) {
            throw new AggregateError(failures, "MCP exposure shutdown was incomplete");
          }
        })();
        return stopping;
      },
    });
  } catch (error) {
    await Promise.allSettled([
      ...(exposure ? [exposure.stop()] : []),
      local.stop(),
    ]);
    throw error;
  }
}
