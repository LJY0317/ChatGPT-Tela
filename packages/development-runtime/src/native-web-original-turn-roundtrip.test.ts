import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ControlledBrowserHost } from "@chatgpt-tela/browser-host";
import { type WebConversationProvider, type WebTurnHandle, type WebTurnRequest } from "@chatgpt-tela/chatgpt";
import { NativeLiveTurnRegistry } from "@chatgpt-tela/core";
import { AppServerCurrentTurnSource, NativeHistoryBootstrapRequired, type CodexAppServerRpc } from "@chatgpt-tela/codex";
import { CHATGPT_TELA_CODEX_TOOL_CALL, CHATGPT_TELA_CODEX_TOOL_INVENTORY, startCodexBridgeMcpHttpServer } from "@chatgpt-tela/mcp";
import { createNativeRequestDevelopmentWebTurnPlanner } from "./native-request-planner";
import { startDevelopmentRuntime } from "./runtime";

const THREAD = "synthetic-legacy-original-thread";
const TOOL_RESULT = "synthetic-native-tool-result-verified";

function legacyFixture(turnId: string) {
  const live = new NativeLiveTurnRegistry();
  const owner = {};
  expect(live.accept(THREAD, turnId, owner)).toBe(true);
  const calls: { method: string; params: unknown }[] = [];
  let activeSubscriptions = 0;
  const source = new AppServerCurrentTurnSource(async (): Promise<CodexAppServerRpc> => ({
    async request(method, params) {
      calls.push({ method, params });
      if (method !== "thread/read" || (params as { includeTurns?: boolean })?.includeTurns !== false) {
        throw new Error("Legacy history paging, resume and extra Native execution are forbidden");
      }
      return { thread: {
        id: THREAD, historyMode: "legacy", source: "cli",
        status: { type: "active", activeFlags: [] },
        cwd: "/synthetic/workspace",
        environments: [{ cwd: "/synthetic/workspace", runtimeWorkspaceRoots: ["/synthetic/workspace"] }],
      } };
    },
    subscribe() {
      activeSubscriptions++;
      return () => { activeSubscriptions--; };
    },
    async close() {},
  }), { liveTurnProof: live });
  return { source, live, calls, get subscriptions() { return activeSubscriptions; } };
}

function nativeRequest(turnId: string, input: unknown[], stream = true) {
  return {
    model: "synthetic-web-model", stream,
    client_metadata: { "x-codex-turn-metadata": {
      request_kind: "turn", thread_id: THREAD, turn_id: turnId,
    } },
    input,
    tools: [{ type: "function", name: "fixture_native_tool", description: "Synthetic original Native tool",
      parameters: { type: "object" } }],
  };
}

async function post(baseUrl: URL, token: string, request: unknown): Promise<Response> {
  return fetch(new URL("responses", baseUrl), {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
}

class OriginalTurnProvider implements WebConversationProvider {
  readonly submissions: WebTurnRequest[] = [];
  readonly events: string[] = [];
  #announced = false;
  #continuing = false;
  #toolCall: Promise<void> | undefined;
  #toolResult = "";

  constructor(readonly client: Client) {}

  async observeCapabilities() {
    return { state: "proven" as const, value: { observed: new Set(["composer", "send"]) }, evidence: ["synthetic-owned-surface"] };
  }
  async submitTurn(_surface: unknown, request: WebTurnRequest) {
    this.submissions.push(request);
    return { state: "proven" as const, value: {
      nativeTaskId: request.nativeTaskId, nativeTurnId: request.nativeTurnId,
      webEpochId: request.webEpochId, providerTurnId: "synthetic-provider-turn",
    }, evidence: ["synthetic-submit"] };
  }
  async observeTurn() {
    return { state: "proven" as const, value: {
      providerTurnId: "synthetic-provider-turn", phase: "accepted" as const,
    }, evidence: ["synthetic-observation"] };
  }
  async armToolContinuation(_surface: unknown, turn: WebTurnHandle, callId: string) {
    expect(callId).toBe("synthetic-call-1");
    this.events.push("continuation-armed");
    return { state: "proven" as const, value: {
      providerTurnId: turn.providerTurnId, callId,
    }, evidence: ["synthetic-continuation"] };
  }
  async waitForTurnEvent(_surface: unknown, _turn: WebTurnHandle, signal?: AbortSignal) {
    if (!this.#announced) {
      this.#announced = true;
      this.events.push("web-progress");
      return { state: "proven" as const, value: {
        kind: "progress" as const, providerTurnId: "synthetic-provider-turn", summary: "Web accepted the original task",
      }, evidence: ["synthetic-progress"] };
    }
    const request = this.submissions[0];
    if (!request?.toolBridge || request.toolBridge.contract !== "stable") {
      throw new Error("original Web turn did not receive the stable mounted Native tool bridge");
    }
    this.#toolCall ??= (async () => {
      this.events.push("web-requested-native-tool");
      const result = await this.client.callTool({ name: CHATGPT_TELA_CODEX_TOOL_CALL, arguments: {
        turn_capability: request.toolBridge!.turnCapability,
        call_id: "synthetic-call-1", wire_name: "fixture_native_tool", mode: "structured",
        arguments: { target: "synthetic-only" },
      } });
      if (result.isError) throw new Error("mounted original Native tool returned an error");
      this.#toolResult = JSON.stringify(result.content);
      this.events.push("native-result-observed-by-web");
    })();
    await this.#toolCall;
    signal?.throwIfAborted();
    if (!this.#continuing) {
      this.#continuing = true;
      this.events.push("web-continued");
      return { state: "proven" as const, value: {
        kind: "continuing" as const, providerTurnId: "synthetic-provider-turn",
      }, evidence: ["synthetic-post-tool-continuation"] };
    }
    this.events.push("web-final");
    return { state: "proven" as const, value: {
      kind: "completed" as const, providerTurnId: "synthetic-provider-turn",
      answer: `Original Web turn completed using: ${this.#toolResult}`,
    }, evidence: ["synthetic-owned-final"] };
  }
}

test("readable original Legacy turn keeps one owner through Web progress, authenticated HTTP MCP, Native tool result and same-turn final", async () => {
  const turnId = "live-original-1";
  const fixture = legacyFixture(turnId);
  const client = new Client({ name: "synthetic-original-turn", version: "1.0.0" }, { capabilities: {} });
  const provider = new OriginalTurnProvider(client);
  let surfaceClosures = 0;
  const runtime = await startDevelopmentRuntime({
    currentTurnSource: fixture.source,
    browserHost: new ControlledBrowserHost(async () => ({
      async navigate() {}, async reveal() {}, async hide() {}, async close() { surfaceClosures++; },
    })),
    provider, mcp: { kind: "external", abi: "stable" },
    planWebTurn: createNativeRequestDevelopmentWebTurnPlanner({
      compactionHistory: async () => { throw Error("Readable current context must not page Legacy history"); },
    }),
  });
  const bridge = await startCodexBridgeMcpHttpServer({ turns: runtime.turns });
  try {
    const denied = await fetch(bridge.endpointUrl, { method: "POST" });
    expect(denied.status).toBe(401);
    const transport = new StreamableHTTPClientTransport(bridge.endpointUrl, {
      requestInit: { headers: { authorization: `Bearer ${bridge.bearerToken}` } },
    });
    await client.connect(transport as unknown as Transport);
    expect((await client.listTools()).tools.map(item => item.name).sort()).toEqual([
      CHATGPT_TELA_CODEX_TOOL_CALL, CHATGPT_TELA_CODEX_TOOL_INVENTORY,
    ].sort());

    const original = nativeRequest(turnId, [
      // The original Native thread can contain an enormous historical tool
      // transcript before a verified readable compaction boundary.
      { type: "message", role: "user", content: "Old Native task already summarized." },
      { type: "function_call_output", call_id: "old-completed-native-tool",
        output: "superseded-private-old-tool-output ".repeat(4_000) },
      { type: "context_compaction" },
      { type: "message", role: "user", content: "Fully readable synthetic compaction summary and verified constraints" },
      { type: "message", role: "user", content: "Continue the original Native task using its tool" },
    ]);
    const first = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, original);
    expect(first.status).toBe(200);
    const firstOutput = await first.text();
    expect(firstOutput).toContain('"call_id":"synthetic-call-1"');
    expect(firstOutput).toContain('"name":"fixture_native_tool"');
    expect(firstOutput).toContain("Web accepted the original task");
    expect(provider.submissions).toHaveLength(1);
    expect(provider.submissions[0]?.nativeTurnId).toBe(turnId);
    expect(JSON.stringify(provider.submissions[0]?.physicalContext)).toContain("Fully readable synthetic compaction summary");
    expect(JSON.stringify(provider.submissions[0]?.physicalContext)).not.toContain("superseded-private-old-tool-output");
    expect(fixture.live.current(THREAD)?.turnId).toBe(turnId);

    const followup = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken,
      nativeRequest(turnId, [{ type: "function_call_output", call_id: "synthetic-call-1", output: TOOL_RESULT }]));
    expect(followup.status).toBe(200);
    const final = await followup.text();
    expect(final).toContain("Original Web turn completed using:");
    expect(final).toContain(TOOL_RESULT);
    expect(provider.submissions).toHaveLength(1);
    expect(provider.events).toEqual([
      "web-progress", "web-requested-native-tool", "continuation-armed",
      "native-result-observed-by-web", "web-continued", "web-final",
    ]);
    expect(runtime.turns.size).toBe(0);
    expect(fixture.calls.length).toBeGreaterThan(0);
    expect(fixture.calls.every(call => call.method === "thread/read"
      && (call.params as { includeTurns?: boolean }).includeTurns === false)).toBe(true);
    expect(fixture.subscriptions).toBe(0);
    expect(surfaceClosures).toBe(0); // Retained until the owning runtime stops.
  } finally {
    await runtime.stop();
    await client.close().catch(() => {});
    await bridge.stop();
  }
  expect(surfaceClosures).toBe(1);
});

test("opaque original Legacy compaction stays nonretryable without Web submission or old-history replay", async () => {
  const turnId = "live-opaque-1";
  const fixture = legacyFixture(turnId);
  let submissions = 0;
  const runtime = await startDevelopmentRuntime({
    currentTurnSource: fixture.source,
    browserHost: new ControlledBrowserHost(async () => ({
      async navigate() {}, async reveal() {}, async hide() {}, async close() {},
    })),
    provider: {
      async observeCapabilities() { return { state: "proven" as const, value: { observed: new Set(["composer", "send"]) }, evidence: ["fixture"] }; },
      async submitTurn() { submissions++; throw Error("opaque Legacy must never reach Web submit"); },
      async observeTurn() { throw Error("unexpected Web observation"); },
      async armToolContinuation() { throw Error("unexpected tool continuation"); },
      async waitForTurnEvent() { throw Error("unexpected Web event"); },
    },
    mcp: { kind: "external", abi: "stable" },
    planWebTurn: createNativeRequestDevelopmentWebTurnPlanner({
      compactionHistory: async () => { throw new NativeHistoryBootstrapRequired("unindexed_history"); },
    }),
  });
  try {
    const response = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken,
      nativeRequest(turnId, [
        { type: "compaction", encrypted_content: "synthetic-unreadable-marker" },
        { type: "message", role: "user", content: "Continue original opaque task" },
      ], false));
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain("tela_native_history_indexed_source_required");
    expect(body).toContain("continue_on_native");
    expect(body).not.toContain("synthetic-unreadable-marker");
    expect(submissions).toBe(0);
    expect(fixture.calls.every(call => call.method === "thread/read"
      && (call.params as { includeTurns?: boolean }).includeTurns === false)).toBe(true);
    expect(fixture.subscriptions).toBe(0);
  } finally { await runtime.stop(); }
});

test("losing the original Native ACK while its Web tool is pending revokes the whole turn without tool replay", async () => {
  const turnId = "live-revoked-1";
  const fixture = legacyFixture(turnId);
  const client = new Client({ name: "synthetic-revocation", version: "1.0.0" }, { capabilities: {} });
  const provider = new OriginalTurnProvider(client);
  const runtime = await startDevelopmentRuntime({
    currentTurnSource: fixture.source,
    browserHost: new ControlledBrowserHost(async () => ({
      async navigate() {}, async reveal() {}, async hide() {}, async close() {},
    })),
    provider, mcp: { kind: "external", abi: "stable" },
    planWebTurn: createNativeRequestDevelopmentWebTurnPlanner({
      compactionHistory: async () => { throw Error("Legacy paging must remain disabled"); },
    }),
  });
  const bridge = await startCodexBridgeMcpHttpServer({ turns: runtime.turns });
  try {
    await client.connect(new StreamableHTTPClientTransport(bridge.endpointUrl, {
      requestInit: { headers: { authorization: `Bearer ${bridge.bearerToken}` } },
    }) as unknown as Transport);
    const first = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken,
      nativeRequest(turnId, [
        { type: "context_compaction" },
        { type: "message", role: "user", content: "Complete synthetic readable context" },
        { type: "message", role: "user", content: "Use one original Native tool" },
      ]));
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('"call_id":"synthetic-call-1"');
    expect(provider.events.filter(event => event === "web-requested-native-tool")).toHaveLength(1);
    fixture.live.retireThread(THREAD);
    // The original socket revoked its ACK. Wait only in this synthetic test,
    // never in production admission or Native history/proxy logic.
    for (let n = 0; n < 80 && runtime.turns.size !== 0; n++) await Bun.sleep(5);
    expect(runtime.turns.size).toBe(0);
    const replay = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken,
      nativeRequest(turnId, [{ type: "function_call_output", call_id: "synthetic-call-1", output: TOOL_RESULT }], false));
    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("tela_native_turn_already_retired");
    expect(provider.events).not.toContain("web-final");
    expect(provider.submissions).toHaveLength(1);
    expect(fixture.calls.every(call => call.method === "thread/read"
      && (call.params as { includeTurns?: boolean }).includeTurns === false)).toBe(true);
    expect(fixture.subscriptions).toBe(0);
  } finally {
    await runtime.stop();
    await client.close().catch(() => {});
    await bridge.stop();
  }
});
