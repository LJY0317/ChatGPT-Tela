import { describe, expect, test } from "bun:test";
import { ActiveTurnRegistry } from "@chatgpt-tela/runtime";
import { ExistingHttpsExposure } from "./exposure";
import type { DevelopmentMcpHttpServer } from "./http-server";
import { startCodexBridgeMcpHttpExposure, startDevelopmentMcpHttpExposure } from "./http-exposure";

describe("development MCP HTTP exposure", () => {
  test("uses an existing authenticated HTTPS route without acquiring a second tunnel", async () => {
    let local: DevelopmentMcpHttpServer | undefined;
    const runtime = await startDevelopmentMcpHttpExposure({
      turns: new ActiveTurnRegistry(),
      local: { port: 0 },
      exposure(server) {
        local = server;
        return new ExistingHttpsExposure({
          url: "https://chatgpt-tela.example.ts.net/mcp",
          authentication: { kind: "bearer", secretReference: "keychain:chatgpt-tela-test" },
          probe: async endpoint => ({
            ready: endpoint.url.pathname === "/mcp" && server.endpointUrl.pathname === "/mcp",
          }),
        });
      },
    });

    try {
      expect(local).toBe(runtime.local);
      expect(runtime.exposureKind).toBe("existing-https-endpoint");
      expect(runtime.publicEndpoint.kind).toBe("https");
      if (runtime.publicEndpoint.kind !== "https") throw new Error("expected HTTPS endpoint");
      expect(runtime.publicEndpoint.url.href).toBe("https://chatgpt-tela.example.ts.net/mcp");
      expect(runtime.publicEndpoint.authentication.kind).toBe("bearer");
      expect(runtime.local.endpointUrl.protocol).toBe("http:");
      expect(runtime.local.endpointUrl.hostname).toBe("127.0.0.1");
    } finally {
      await runtime.close();
      await runtime.close();
    }
  });

  test("fails closed on a public unauthenticated endpoint unless explicitly allowed", async () => {
    await expect(startDevelopmentMcpHttpExposure({
      turns: new ActiveTurnRegistry(),
      exposure: () => new ExistingHttpsExposure({
        url: "https://public.example.test/mcp",
        authentication: { kind: "none" },
        probe: async () => ({ ready: true }),
      }),
    })).rejects.toThrow("must require authentication");
  });

  test("verification failure tears down the local listener and external lifecycle", async () => {
    let local: DevelopmentMcpHttpServer | undefined;
    let stopped = 0;
    await expect(startDevelopmentMcpHttpExposure({
      turns: new ActiveTurnRegistry(),
      exposure(server) {
        local = server;
        return {
          kind: "fixture-exposure",
          async prepare() {
            return {
              kind: "https" as const,
              url: new URL("https://broken.example.test/mcp"),
              authentication: { kind: "bearer" as const, secretReference: "fixture" },
            };
          },
          async verify() { return { ready: false, detail: "not routed" }; },
          async stop() { stopped += 1; },
        };
      },
    })).rejects.toThrow("not routed");

    expect(stopped).toBe(1);
    if (!local) throw new Error("fixture did not receive local server");
    await expect(fetch(local.endpointUrl)).rejects.toThrow();
  });

  test("accepts an authenticated OpenAI tunnel target without pretending it is public HTTPS", async () => {
    const runtime = await startDevelopmentMcpHttpExposure({
      turns: new ActiveTurnRegistry(),
      local: { authentication: { kind: "none" } },
      exposure(local) {
        expect(local.authentication).toBe("none");
        return {
          kind: "fixture-openai-tunnel",
          async prepare() {
            return {
              kind: "openai-secure-tunnel" as const,
              tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
              authentication: { kind: "openai-tunnel" as const },
            };
          },
          async verify() { return { ready: true }; },
          async stop() {},
        };
      },
    });
    try {
      expect(runtime.publicEndpoint).toEqual({
        kind: "openai-secure-tunnel",
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        authentication: { kind: "openai-tunnel" },
      });
    } finally {
      await runtime.close();
    }
  });
});

describe("Codex bridge MCP HTTP exposure", () => {
  test("can expose the private bridge through an independently owned HTTPS route", async () => {
    const runtime = await startCodexBridgeMcpHttpExposure({
      turns: new ActiveTurnRegistry(),
      exposure(server) {
        return new ExistingHttpsExposure({
          url: "https://chatgpt-tela.example.ts.net/stable",
          authentication: { kind: "bearer", secretReference: "keychain:chatgpt-tela-codex-bridge" },
          probe: async endpoint => ({
            ready: endpoint.url.pathname === "/stable" && server.endpointUrl.protocol === "http:",
          }),
        });
      },
    });
    try {
      expect(runtime.local.endpointUrl.hostname).toBe("127.0.0.1");
      expect(runtime.publicEndpoint.kind).toBe("https");
      if (runtime.publicEndpoint.kind !== "https") throw new Error("expected HTTPS endpoint");
      expect(runtime.publicEndpoint.url.pathname).toBe("/stable");
    } finally {
      await runtime.close();
    }
  });
});
