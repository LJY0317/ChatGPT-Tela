import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  NativeToolInventory,
  defineNativeTurnAuthority,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import {
  ActiveTurnRegistry,
  acceptNativeResponsesToolResult,
  nextNativeResponsesToolCall,
} from "@chatgpt-tela/runtime";
import { startCodexBridgeMcpHttpServer, startDevelopmentMcpHttpServer } from "./http-server";
import {
  CHATGPT_TELA_CODEX_TOOL_CALL,
  CHATGPT_TELA_CODEX_TOOL_INVENTORY,
} from "./public-abi";

function binding(): NativeTurnBinding {
  const tools = [{
    wireName: "exec_command",
    name: "exec_command",
    description: "Execute a command",
    kind: "function" as const,
    inputSchema: { type: "object" },
  }];
  return {
    claim: {
      threadId: "thread-1",
      turnId: "turn-1",
      requestKind: "turn",
      toolObservations: [{ source: "fixture", tools }],
    },
    authority: defineNativeTurnAuthority({
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "/workspace",
      workspaceRoots: ["/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
    }),
    tools: NativeToolInventory.fromObservations("thread-1", "turn-1", [
      { source: "fixture", tools },
    ]),
    canonicalEvidence: {
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "/workspace",
      workspaceRoots: ["/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
      proof: "turn-context",
      environmentSourceTurnId: "turn-1",
    },
  };
}

describe("development MCP Streamable HTTP server", () => {
  test("runs a real authenticated MCP session and relays one exact Native tool round", async () => {
    const turns = new ActiveTurnRegistry();
    const registered = turns.register(binding());
    registered.channel.markSubmitted();
    registered.channel.markAccepted();
    const server = await startDevelopmentMcpHttpServer({ turns });
    const transport = new StreamableHTTPClientTransport(server.endpointUrl, {
      requestInit: {
        headers: { authorization: `Bearer ${server.bearerToken}` },
      },
    });
    const client = new Client({ name: "chatgpt-tela-http-test", version: "0.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport as unknown as Transport);
      expect(server.activeSessionCount).toBe(1);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        "chatgpt_tela_dev_tool_call",
        "chatgpt_tela_dev_tool_inventory",
      ]);

      const call = client.callTool({
        name: "chatgpt_tela_dev_tool_call",
        arguments: {
          turn_capability: registered.capability,
          call_id: "call-1",
          wire_name: "exec_command",
          mode: "structured",
          arguments: { cmd: ["printf", "ok"] },
        },
      });
      expect(await nextNativeResponsesToolCall(registered.channel)).toEqual({
        type: "function_call",
        call_id: "call-1",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: ["printf", "ok"] }),
      });
      acceptNativeResponsesToolResult(registered.channel, {
        input: [{ type: "function_call_output", call_id: "call-1", output: "ok" }],
      });
      registered.channel.releaseNativeToolResultToWeb("call-1");
      const result = await call;
      expect(result.isError).not.toBe(true);
      expect(result.content as unknown).toEqual([{ type: "text", text: "ok" }]);

      await transport.terminateSession();
      for (let index = 0; index < 20 && server.activeSessionCount !== 0; index += 1) {
        await Promise.resolve();
      }
      expect(server.activeSessionCount).toBe(0);
    } finally {
      await client.close().catch(() => {});
      await server.stop();
    }
  });

  test("rejects unauthenticated and browser-origin requests before MCP session work", async () => {
    const server = await startDevelopmentMcpHttpServer({ turns: new ActiveTurnRegistry() });
    try {
      const noAuth = await fetch(server.endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(noAuth.status).toBe(401);

      const browser = await fetch(server.endpointUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${server.bearerToken}`,
          origin: "https://example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(browser.status).toBe(403);
      expect(server.activeSessionCount).toBe(0);
    } finally {
      await server.stop();
    }
  });

  test("supports an explicitly unauthenticated loopback listener for an auth-owning exposure layer", async () => {
    const server = await startDevelopmentMcpHttpServer({
      turns: new ActiveTurnRegistry(),
      authentication: { kind: "none" },
    });
    try {
      expect(server.authentication).toBe("none");
      expect(server.bearerToken).toBeUndefined();
      expect(server.endpointUrl.hostname).toBe("127.0.0.1");
    } finally {
      await server.stop();
    }
  });
});

describe("private Codex bridge Streamable HTTP server", () => {
  test("serves the stable Codex bridge tools through the same bounded authenticated lifecycle", async () => {
    const server = await startCodexBridgeMcpHttpServer({ turns: new ActiveTurnRegistry() });
    const transport = new StreamableHTTPClientTransport(server.endpointUrl, {
      requestInit: { headers: { authorization: `Bearer ${server.bearerToken}` } },
    });
    const client = new Client({ name: "chatgpt-tela-codex-bridge-http-test", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport as unknown as Transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        CHATGPT_TELA_CODEX_TOOL_CALL,
        CHATGPT_TELA_CODEX_TOOL_INVENTORY,
      ]);
      expect(server.activeSessionCount).toBe(1);
    } finally {
      await client.close().catch(() => {});
      await server.stop();
    }
  });

  test("serves the Codex bridge contract through an asynchronous remote backend", async () => {
    const calls: Array<{ capability: string; callId: string; wireName: string }> = [];
    const server = await startCodexBridgeMcpHttpServer({
      bridge: {
        async inventory(capability, query) {
          expect(capability).toBe("turnr_ProfileA1_opaque");
          expect(query).toBe("command");
          return [{
            wireName: "exec_command",
            name: "exec_command",
            kind: "function" as const,
            description: "Execute a command",
            inputSchema: { type: "object" },
            observedFrom: ["remote-child"],
          }];
        },
        async invoke(capability, invocation) {
          calls.push({
            capability,
            callId: invocation.callId,
            wireName: invocation.wireName,
          });
          return { callId: invocation.callId, content: "remote-ok", isError: false };
        },
      },
    });
    const transport = new StreamableHTTPClientTransport(server.endpointUrl, {
      requestInit: { headers: { authorization: `Bearer ${server.bearerToken}` } },
    });
    const client = new Client({ name: "chatgpt-tela-codex-remote-bridge-test", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport as unknown as Transport);
      const inventory = await client.callTool({
        name: CHATGPT_TELA_CODEX_TOOL_INVENTORY,
        arguments: { turn_capability: "turnr_ProfileA1_opaque", query: "command" },
      });
      expect(inventory.isError).not.toBe(true);
      expect(JSON.stringify(inventory.content)).toContain("exec_command");

      const result = await client.callTool({
        name: CHATGPT_TELA_CODEX_TOOL_CALL,
        arguments: {
          turn_capability: "turnr_ProfileA1_opaque",
          call_id: "call-remote-1",
          wire_name: "exec_command",
          mode: "structured",
          arguments: { cmd: ["printf", "ok"] },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content as unknown).toEqual([{ type: "text", text: "remote-ok" }]);
      expect(calls).toEqual([{
        capability: "turnr_ProfileA1_opaque",
        callId: "call-remote-1",
        wireName: "exec_command",
      }]);
    } finally {
      await client.close().catch(() => {});
      await server.stop();
    }
  });
});
