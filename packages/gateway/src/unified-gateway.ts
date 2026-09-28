import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ExistingHttpsExposure,
  startCustomMcpHttpExposure,
  type CustomMcpExposureFactory,
  type CustomMcpHttpExposure,
} from "@chatgpt-tela/mcp";
import type { TurnBridgeBackend } from "@chatgpt-tela/mcp";
import {
  CHATGPT_TELA_UNIFIED_CODEX_CALL,
  CHATGPT_TELA_UNIFIED_CODEX_INVENTORY,
  UNIFIED_CHAT_TOOL_DEFINITIONS,
  createUnifiedDevelopmentMcpServer,
  type UnifiedChatBackend,
} from "./unified-server";

export interface UnifiedDevelopmentGatewayConfig {
  readonly publicUrl: string;
  readonly localPort: number;
  readonly allowUnauthenticatedPublicEndpoint: boolean;
}

export interface UnifiedDevelopmentGateway {
  readonly publicMcp: CustomMcpHttpExposure;
  readonly status: {
    readonly abi: "unified-development";
    readonly exposureKind: string;
    readonly publicEndpoint: string;
    readonly toolCount: number;
  };
  close(): Promise<void>;
}

export const UNIFIED_DEVELOPMENT_TOOL_NAMES = Object.freeze([
  ...UNIFIED_CHAT_TOOL_DEFINITIONS.map(tool => tool.name),
  CHATGPT_TELA_UNIFIED_CODEX_INVENTORY,
  CHATGPT_TELA_UNIFIED_CODEX_CALL,
].sort());

export async function probeUnifiedDevelopmentMcp(
  url: URL,
  signal?: AbortSignal,
): Promise<{ readonly ready: boolean; readonly detail?: string }> {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "chatgpt-tela-unified-probe", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport as unknown as Transport, signal ? { signal } : undefined);
    const listed = await client.listTools(undefined, signal ? { signal } : undefined);
    const actual = listed.tools.map(tool => tool.name).sort();
    return JSON.stringify(actual) === JSON.stringify(UNIFIED_DEVELOPMENT_TOOL_NAMES)
      ? { ready: true }
      : { ready: false, detail: `unexpected unified development tool surface: ${JSON.stringify(actual)}` };
  } catch (error) {
    return { ready: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

export async function startUnifiedDevelopmentGateway(input: {
  readonly chat: UnifiedChatBackend;
  readonly codex: TurnBridgeBackend;
  readonly config: UnifiedDevelopmentGatewayConfig;
  readonly exposure?: CustomMcpExposureFactory;
  readonly signal?: AbortSignal;
}): Promise<UnifiedDevelopmentGateway> {
  const publicMcp = await startCustomMcpHttpExposure({
    createServer: () => createUnifiedDevelopmentMcpServer({ chat: input.chat, codex: input.codex }),
    label: "unified-development",
    local: { port: input.config.localPort, authentication: { kind: "none" } },
    allowUnauthenticatedPublicEndpoint: input.config.allowUnauthenticatedPublicEndpoint,
    exposure: input.exposure ?? (() => new ExistingHttpsExposure({
      url: input.config.publicUrl,
      authentication: { kind: "none" },
      probe: (endpoint, signal) => probeUnifiedDevelopmentMcp(endpoint.url, signal),
    })),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return Object.freeze({
    publicMcp,
    status: Object.freeze({
      abi: "unified-development" as const,
      exposureKind: publicMcp.exposureKind,
      publicEndpoint: publicMcp.publicEndpoint.kind === "https"
        ? publicMcp.publicEndpoint.url.href
        : publicMcp.publicEndpoint.tunnelId,
      toolCount: UNIFIED_DEVELOPMENT_TOOL_NAMES.length,
    }),
    close: () => publicMcp.close(),
  });
}
