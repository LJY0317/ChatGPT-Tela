import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebHttpServer } from "@chatgpt-tela/http-host";
import type { ServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import { DynamicCodexTurnBridge } from "./dynamic-codex-turn-bridge";

describe("dynamic Codex turn bridge", () => {
  test("Gateway remains constructible with Codex absent and resolves the backend only per tool request", async () => {
    let descriptor: ServiceRuntimeDescriptor | undefined;
    const bridge = new DynamicCodexTurnBridge(() => descriptor);
    await expect(bridge.inventory("turnr_missing_opaque")).rejects.toThrow("unavailable");
    descriptor = {
      version: 1,
      service: "chat",
      instanceId: "wrong-service",
      installId: "install-1",
      pid: 1,
      endpoint: "http://127.0.0.1:1/",
      bearerToken: "x".repeat(48),
      startedAt: "2026-09-27T00:00:00.000Z",
    };
    await expect(bridge.inventory("turnr_wrong_opaque")).rejects.toThrow("not codex");
  });

  test("emits payload-free routing diagnostics for successful dynamic Codex inventory and invoke", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-gateway-dynamic-codex-"));
    const diagnosticPath = join(root, "gateway-diagnostics.jsonl");
    const previousDiagnosticPath = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = diagnosticPath;
    const token = "z".repeat(48);
    const server = await startWebHttpServer({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodyBytes: 1024 * 1024,
      async fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/v1/codex/tools/inventory") {
          return Response.json({ tools: [{ wireName: "exec_command", name: "exec_command", kind: "freeform",
            description: "execute one command", observedFrom: ["fixture"] }] });
        }
        if (request.method === "POST" && url.pathname === "/v1/codex/tools/invoke") {
          const body = await request.json() as { invocation: { callId: string } };
          return Response.json({ result: { callId: body.invocation.callId, content: "ok", isError: false } });
        }
        return new Response(null, { status: 404 });
      },
    });
    const bridge = new DynamicCodexTurnBridge(() => ({
      version: 1,
      service: "codex",
      instanceId: "codex-private-fixture",
      installId: "install-fixture",
      pid: 1,
      endpoint: `http://127.0.0.1:${server.port}/`,
      bearerToken: token,
      startedAt: "2026-09-29T00:00:00.000Z",
    }));
    try {
      expect((await bridge.inventory("turnr_ProfileA1_opaque"))[0]?.wireName).toBe("exec_command");
      expect((await bridge.invoke("turnr_ProfileA1_opaque", {
        callId: "call-live-proof",
        wireName: "exec_command",
        mode: "freeform",
        input: "printf ok",
      })).content).toBe("ok");
      const diagnostics = readFileSync(diagnosticPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(diagnostics.map(item => [item.stage, item.service])).toEqual([
        ["backend_call_start", "codex"],
        ["backend_call_complete", "codex"],
        ["backend_call_start", "codex"],
        ["backend_call_complete", "codex"],
      ]);
      expect(readFileSync(diagnosticPath, "utf8")).not.toContain("turnr_ProfileA1_opaque");
      expect(readFileSync(diagnosticPath, "utf8")).not.toContain("printf ok");
    } finally {
      await server.stop();
      if (previousDiagnosticPath === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previousDiagnosticPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
