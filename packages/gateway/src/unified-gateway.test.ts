import { describe, expect, test } from "bun:test";
import type { HttpsMcpEndpoint, McpExposureProvider } from "@chatgpt-tela/mcp";
import type { TurnBridgeBackend } from "@chatgpt-tela/mcp";
import {
  UNIFIED_DEVELOPMENT_TOOL_NAMES,
  probeUnifiedDevelopmentMcp,
  startUnifiedDevelopmentGateway,
} from "./unified-gateway";

describe("unified development Gateway exposure", () => {
  test("serves one combined Chat/Codex schema through the generic MCP exposure lifecycle", async () => {
    let stopped = false;
    const chat = {
      async call(capability: string) { return { capability, fixture: true }; },
    };
    const codex: TurnBridgeBackend = {
      inventory: async () => [],
      invoke: async (_capability, invocation) => ({ callId: invocation.callId, content: "fixture", isError: false }),
    };
    const gateway = await startUnifiedDevelopmentGateway({
      chat,
      codex,
      config: {
        publicUrl: "https://example.test/chatgpt-tela",
        localPort: 0,
        allowUnauthenticatedPublicEndpoint: true,
      },
      exposure: local => {
        const endpoint: HttpsMcpEndpoint = Object.freeze({
          kind: "https",
          url: new URL("https://example.test/chatgpt-tela"),
          authentication: { kind: "none" as const },
        });
        const provider: McpExposureProvider = {
          kind: "unified-fixture",
          prepare: async () => endpoint,
          verify: async () => probeUnifiedDevelopmentMcp(local.endpointUrl),
          async stop() { stopped = true; },
        };
        return provider;
      },
    });
    try {
      expect(gateway.status).toEqual({
        abi: "unified-development",
        exposureKind: "unified-fixture",
        publicEndpoint: "https://example.test/chatgpt-tela",
        toolCount: UNIFIED_DEVELOPMENT_TOOL_NAMES.length,
      });
      expect(gateway.publicMcp.local.activeSessionCount).toBe(0);
    } finally {
      await gateway.close();
    }
    expect(stopped).toBe(true);
  });
});
