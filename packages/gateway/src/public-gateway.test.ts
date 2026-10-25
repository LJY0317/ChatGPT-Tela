import { describe, expect, test } from "bun:test";
import type { HttpsMcpEndpoint, McpExposureProvider, TurnBridgeBackend } from "@chatgpt-tela/mcp";
import {
  CHATGPT_TELA_SCHEMA_FINGERPRINT,
} from "@chatgpt-tela/mcp";
import {
  probePublicMcp,
  startPublicGateway,
} from "./public-gateway";

describe("public ChatGPT Tela Gateway exposure", () => {
  test("serves the frozen schema through the generic exposure lifecycle", async () => {
    let stopped = false;
    const chat = {
      inventory: async () => [],
      call: async (capability: string) => ({ capability, fixture: true }),
    };
    const codex: TurnBridgeBackend = {
      inventory: async () => [],
      invoke: async (_capability, invocation) => ({ callId: invocation.callId, content: "fixture", isError: false }),
    };
    const gateway = await startPublicGateway({
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
          kind: "stable-fixture",
          prepare: async () => endpoint,
          verify: async () => probePublicMcp(local.endpointUrl),
          async stop() { stopped = true; },
        };
        return provider;
      },
    });
    try {
      expect(gateway.status).toEqual({
        abi: "stable",
        schemaFingerprint: CHATGPT_TELA_SCHEMA_FINGERPRINT,
        exposureKind: "stable-fixture",
        publicEndpoint: "https://example.test/chatgpt-tela",
      });
      const methods: string[] = [];
      const verified = await probePublicMcp(new URL("https://public.invalid/mcp"), AbortSignal.timeout(2000), async (url, init) => {
        expect(String(url)).toBe("https://public.invalid/mcp");
        methods.push(init?.method ?? "GET");
        return fetch(gateway.publicMcp.local.endpointUrl, init);
      });
      expect(verified.ready).toBe(true);
      expect(methods).toContain("POST");
      expect(methods).toContain("DELETE");
      expect(gateway.publicMcp.local.activeSessionCount).toBe(0);
    } finally {
      await gateway.close();
    }
    expect(stopped).toBe(true);
  });
});
