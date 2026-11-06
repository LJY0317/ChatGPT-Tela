import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NativeToolInventory, isNativeGoalTool, type NativeToolCatalogEntry, type NativeToolResult } from "@chatgpt-tela/core";
import { encodeNativeToolInvocation, extractNativeToolResults, parseNativeTurnClaim } from "@chatgpt-tela/codex";
import { startLocalResponsesServer } from "../../local-server/src/server";
import { createDevelopmentMcpServerForBridge } from "./development-server";
import type { TurnBridgeBackend } from "./turn-bridge";

const control = "fixture-" + "x".repeat(48);
const tools = [{ type: "namespace", name: "functions", tools: [
  { type: "function", name: "get_goal", description: "Read", parameters: { type: "object", properties: {}, required: [] } },
  { type: "function", name: "update_goal", description: "Update", parameters: { type: "object", properties: { status: { type: "string", enum: ["complete"] } }, required: ["status"] } },
  { type: "function", name: "exec_command", description: "Work", parameters: { type: "object" } },
] }, { type: "namespace", name: "plugin", tools: [
  { type: "function", name: "get_goal", description: "Other", parameters: { type: "object" } },
] }];
const body = (input: unknown[], include = true, turn = "turn-1") => ({
  model: "fixture-web", stream: false, client_metadata: { "x-codex-turn-metadata": {
    request_kind: "turn", thread_id: "thread-1", turn_id: turn,
  } }, input: [...(include ? [{ type: "additional_tools", tools }] : []), ...input],
});

test("host-owned Goal Responses round through MCP, exact call ID, and local capability ingress", async () => {
  for (const name of ["get_goal", "update_goal"] as const) {
    const args = name === "get_goal" ? {} : { status: "complete" };
    const callId = "call-" + name;
    let catalog: readonly NativeToolCatalogEntry[] = [];
    let pending: { frame: ReturnType<typeof encodeNativeToolInvocation>;
      resolve: (result: NativeToolResult) => void; delivered: boolean } | undefined;
    let announceCatalog!: () => void, announceFrame!: () => void;
    const hasCatalog = new Promise<void>(resolve => { announceCatalog = resolve; });
    const hasFrame = new Promise<void>(resolve => { announceFrame = resolve; });
    const backend: TurnBridgeBackend = {
      inventory(key) { if (key !== control) throw Error("wrong fixture control"); return catalog; },
      invoke(key, invocation) {
        const advertised = catalog.find(tool => tool.wireName === invocation.wireName);
        if (key !== control || pending || invocation.mode !== "structured" || !advertised || !isNativeGoalTool(advertised))
          throw Error("not advertised");
        return new Promise(resolve => {
          pending = { frame: encodeNativeToolInvocation(advertised, invocation), resolve, delivered: false };
          announceFrame();
        });
      },
    };
    const mcp = createDevelopmentMcpServerForBridge(backend);
    const client = new Client({ name: "fixture", version: "0.0.0" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(st), client.connect(ct)]);
    let mcpCall: ReturnType<Client["callTool"]> | undefined;
    let executed = 0;
    const ingress = await startLocalResponsesServer({ authentication: { kind: "path" }, gateway: {
      async handle(raw) {
        const parsed = parseNativeTurnClaim(raw);
        const outputs = extractNativeToolResults(raw);
        if (outputs.length) {
          if (parsed.turnId !== "turn-1" || !pending?.delivered
            || outputs.length !== 1 || outputs[0]!.callId !== pending.frame.call_id)
            throw Error("unissued or foreign result");
          const owned = pending; pending = undefined;
          owned.resolve(outputs[0]!);
          const result = await mcpCall!;
          return { type: "final" as const, answer: ((result.content as { text: string }[])[0]!).text,
            delivery: { capability: "fixture-final" } };
        }
        if (!pending) {
          catalog = NativeToolInventory.fromObservations(parsed.threadId, parsed.turnId,
            parsed.toolObservations).list().filter(isNativeGoalTool);
          announceCatalog(); await hasFrame;
        }
        return { type: "tool-call" as const, item: pending!.frame,
          delivery: { capability: "fixture-tool", callId: pending!.frame.call_id } };
      },
      commit(outcome) {
        if (outcome.type === "tool-call" && pending?.frame.call_id === outcome.item.call_id)
          pending.delivered = true;
      },
    } });
    const post = (input: unknown[], turn = "turn-1") => fetch(new URL("responses", ingress.baseUrl), {
      method: "POST", headers: { "content-type": "application/json",
        authorization: "Bearer unchanged-host", "OpenAI-Organization": "org-original" },
      body: JSON.stringify(body(input, true, turn)),
    });
    try {
      expect((await fetch(new URL("/v1/responses", ingress.baseUrl), {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      })).status).toBe(401);
      const first = post([{ role: "user", content: "fixture task" }]);
      await hasCatalog;
      expect(catalog.map(tool => tool.wireName)).toEqual(["get_goal", "update_goal"]);
      expect(catalog.find(tool => tool.name === name)?.inputSchema)
        .toEqual(tools[0]!.tools.find(tool => tool.name === name)!.parameters);
      mcpCall = client.callTool({ name: "chatgpt_tela_dev_tool_call", arguments: {
        turn_capability: control, call_id: callId, wire_name: name,
        mode: "structured", arguments: args,
      } });
      const response = await first;
      expect(response.status).toBe(200);
      const call = (await response.json() as { output: Record<string, unknown>[] }).output[0]!;
      expect(call).toMatchObject({ type: "function_call", name, call_id: callId,
        arguments: JSON.stringify(args) });
      expect(call.namespace).toBeUndefined();
      expect(pending?.delivered).toBe(true);
      expect((await post([{ type: "function_call_output", call_id: "other", output: "{}" }])).status).toBe(400);
      expect((await post([{ type: "function_call_output", call_id: callId, output: "{}" }],
        "foreign-turn")).status).toBe(400);
      expect(pending?.frame.call_id).toBe(callId);
      expect(executed).toBe(0);
      const output = JSON.stringify({ goal: { status: name === "get_goal" ? "active" : "complete" } });
      executed++;
      const final = await post([{ type: "function_call_output", call_id: callId, output }]);
      expect(final.status).toBe(200);
      expect((await final.json() as { output: { content: { text: string }[] }[] }).output[0]!
        .content[0]!.text).toBe(output);
      expect((await mcpCall).content).toEqual([{ type: "text", text: output }]);
      expect(executed).toBe(1);
      expect(pending).toBeUndefined();
    } finally { await client.close(); await mcp.close(); await ingress.stop(); }
  }
});

test("without advertised host Goal no Goal control is surfaced", () => {
  const claim = parseNativeTurnClaim(body([{ role: "user", content: "no goal" }], false));
  expect(NativeToolInventory.fromObservations(claim.threadId, claim.turnId, claim.toolObservations)
    .list().filter(isNativeGoalTool)).toEqual([]);
});
