import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
import {
  CHATGPT_TELA_CODEX_TOOL_CALL,
  CHATGPT_TELA_CODEX_TOOL_INVENTORY,
} from "./public-abi";
import { createCodexBridgeMcpServer } from "./codex-bridge-server";

function binding(): NativeTurnBinding {
  const tools = [{
    wireName: "exec_command",
    name: "exec_command",
    description: "Execute a command",
    kind: "function" as const,
    inputSchema: { type: "object", properties: { cmd: { type: "array", items: { type: "string" } } } },
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
    tools: NativeToolInventory.fromObservations("thread-1", "turn-1", [{ source: "fixture", tools }]),
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

async function connected(turns: ActiveTurnRegistry) {
  const server = createCodexBridgeMcpServer(turns);
  const client = new Client({ name: "chatgpt-tela-codex-bridge-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe("ChatGPT Tela private Codex bridge MCP server", () => {
  test("exposes exactly the two stable Codex bridge controls", async () => {
    const connection = await connected(new ActiveTurnRegistry());
    try {
      const listed = await connection.client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        CHATGPT_TELA_CODEX_TOOL_CALL,
        CHATGPT_TELA_CODEX_TOOL_INVENTORY,
      ]);
    } finally {
      await connection.client.close();
      await connection.server.close();
    }
  });

  test("relays one exact current-turn Native invocation through the public names", async () => {
    const turns = new ActiveTurnRegistry();
    const registered = turns.register(binding());
    registered.channel.markSubmitted();
    registered.channel.markAccepted();
    const connection = await connected(turns);
    try {
      const inventory = await connection.client.callTool({
        name: CHATGPT_TELA_CODEX_TOOL_INVENTORY,
        arguments: { turn_capability: registered.capability, query: "command" },
      });
      expect(inventory.isError).not.toBe(true);

      const call = connection.client.callTool({
        name: CHATGPT_TELA_CODEX_TOOL_CALL,
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
    } finally {
      await connection.client.close();
      await connection.server.close();
    }
  });

  test("Native MCP embedded PDF survives the exact-turn bridge as a real MCP resource without its private URI",async()=>{
    const turns=new ActiveTurnRegistry();
    const registered=turns.register(binding());
    registered.channel.markSubmitted();
    registered.channel.markAccepted();
    const connection=await connected(turns);
    const pdf=Buffer.from("%PDF-1.4\nPublic test document");
    const hiddenUri="file:///private/owner/document.pdf?credential=secret";
    try{
      const called=connection.client.callTool({
        name:CHATGPT_TELA_CODEX_TOOL_CALL,
        arguments:{turn_capability:registered.capability,call_id:"doc-1",
          wire_name:"exec_command",mode:"structured",arguments:{cmd:["unused"]}},
      });
      expect((await nextNativeResponsesToolCall(registered.channel)).call_id).toBe("doc-1");
      acceptNativeResponsesToolResult(registered.channel,{input:[{
        type:"mcp_tool_call_output",call_id:"doc-1",output:{content:[
          {type:"resource",resource:{
            uri:hiddenUri,mimeType:"application/pdf",blob:pdf.toString("base64"),
          }},
          {type:"resource_link",uri:hiddenUri,mimeType:"application/pdf"},
        ],isError:false},
      }]});
      registered.channel.releaseNativeToolResultToWeb("doc-1");
      const response=await called;
      const parts=Array.isArray(response.content)?response.content:[];
      expect(response.isError).not.toBe(true);
      expect(parts[0]).toMatchObject({
        type:"resource",resource:{mimeType:"application/pdf",blob:pdf.toString("base64")},
      });
      const first=parts[0] as any;
      expect(first.resource.uri).toMatch(/^tela-native-asset:\/\/sha256\/[a-f0-9]{64}$/);
      expect(parts[1]?.type).toBe("text");
      expect(JSON.stringify(response)).not.toContain(hiddenUri);
      expect(JSON.stringify(response)).not.toContain("credential=secret");
    }finally{
      await connection.client.close();
      await connection.server.close();
    }
  });
});
