import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CHATGPT_TELA_SCHEMA_FINGERPRINT,
  ExistingHttpsExposure,
  fingerprintMcpToolContracts,
  startCustomMcpHttpExposure,
  type CustomMcpExposureFactory,
  type CustomMcpHttpExposure,
} from "@chatgpt-tela/mcp";
import type { TurnBridgeBackend } from "@chatgpt-tela/mcp";
import { createPublicMcpServer, type PublicChatBackend } from "./public-server";

export interface PublicGatewayConfig {
  readonly publicUrl: string;
  readonly localPort: number;
  readonly allowUnauthenticatedPublicEndpoint: boolean;
}

export interface PublicGateway {
  readonly publicMcp: CustomMcpHttpExposure;
  readonly status: {
    readonly abi: "stable";
    readonly schemaFingerprint: string;
    readonly exposureKind: string;
    readonly publicEndpoint: string;
  };
  close(): Promise<void>;
}

export async function probePublicMcp(
  url: URL,
  signal?: AbortSignal,
): Promise<{ readonly ready: boolean; readonly detail?: string }> {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "chatgpt-tela-gateway-probe", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport as unknown as Transport, signal ? { signal } : undefined);
    const listed = await client.listTools(undefined, signal ? { signal } : undefined);
    const fingerprint = fingerprintMcpToolContracts(listed.tools.map(tool => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    })));
    return fingerprint === CHATGPT_TELA_SCHEMA_FINGERPRINT
      ? { ready: true }
      : { ready: false, detail: `unexpected ChatGPT Tela schema fingerprint ${fingerprint}` };
  } catch (error) {
    return { ready: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

export async function startPublicGateway(input: {
  readonly chat: PublicChatBackend;
  readonly codex: TurnBridgeBackend;
  readonly config: PublicGatewayConfig;
  readonly exposure?: CustomMcpExposureFactory;
  readonly signal?: AbortSignal;
}): Promise<PublicGateway> {
  const publicMcp = await startCustomMcpHttpExposure({
    createServer: () => createPublicMcpServer({ chat: input.chat, codex: input.codex }),
    label: "public",
    local: { port: input.config.localPort, authentication: { kind: "none" } },
    allowUnauthenticatedPublicEndpoint: input.config.allowUnauthenticatedPublicEndpoint,
    exposure: input.exposure ?? (() => new ExistingHttpsExposure({
      url: input.config.publicUrl,
      authentication: { kind: "none" },
      probe: (endpoint, signal) => probePublicMcp(endpoint.url, signal),
    })),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return Object.freeze({
    publicMcp,
    status: Object.freeze({
      abi: "stable" as const,
      schemaFingerprint: CHATGPT_TELA_SCHEMA_FINGERPRINT,
      exposureKind: publicMcp.exposureKind,
      publicEndpoint: publicMcp.publicEndpoint.kind === "https"
        ? publicMcp.publicEndpoint.url.href
        : publicMcp.publicEndpoint.tunnelId,
    }),
    close: () => publicMcp.close(),
  });
}
