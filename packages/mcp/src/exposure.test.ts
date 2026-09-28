import { expect, test } from "bun:test";
import { ExistingHttpsExposure } from "./exposure";

test("operator-managed HTTPS exposure can represent a Tailscale Funnel without a second tunnel", async () => {
  const exposure = new ExistingHttpsExposure({
    url: "https://chatgpt-tela.example.ts.net/mcp",
    authentication: { kind: "bearer", secretReference: "keychain:chatgpt-tela" },
    probe: async endpoint => ({ ready: endpoint.url.pathname === "/mcp" }),
  });

  const endpoint = await exposure.prepare();
  expect(endpoint.kind).toBe("https");
  expect(endpoint.url.protocol).toBe("https:");
  expect((await exposure.verify(endpoint)).ready).toBe(true);
  await exposure.stop();
});

test("external MCP exposure rejects cleartext HTTP", () => {
  expect(() => new ExistingHttpsExposure({
    url: "http://example.test/mcp",
    authentication: { kind: "none" },
    probe: async () => ({ ready: true }),
  })).toThrow("must use HTTPS");
});
