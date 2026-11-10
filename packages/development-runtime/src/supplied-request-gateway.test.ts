import { expect, test } from "bun:test";
import { zstdCompressSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_DOCUMENT_LIFETIME, type BrowserHost, type BrowserSurfaceLease, type BrowserSurfaceCapability } from "@chatgpt-tela/browser-host";
import { chatGptWebFamilyKey, chatGptWebModelId, type WebConversationProvider, type WebTurnRequest } from "@chatgpt-tela/chatgpt";
import { NativeHistoryBootstrapRequired } from "@chatgpt-tela/codex";
import { listDiagnosticIncidents, readDiagnosticIncident } from "@chatgpt-tela/core";
import { startLocalResponsesServer } from "@chatgpt-tela/local-server";
import { handleNativeResponsesHttp } from "@chatgpt-tela/responses";
import { createProfileTurnBridge, createSuppliedRequestGateway } from "./supplied-request-gateway";
import { createNativeRequestDevelopmentWebTurnPlanner } from "./native-request-planner";
import { FileNativeVisiblePrefixStageJournal } from "./native-visible-prefix-journal";

const model = chatGptWebModelId(chatGptWebFamilyKey("Supplied request fixture"));
const firstInput = [{ type: "message", role: "user", content: "Inspect A." }];
test("supplied HTTP body drain retains provider delivery evidence without inventing a Native final", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-supplied-diagnostics-"));
  const file = join(root, "events.jsonl");
  const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  const f = fixture();
  const server = await startLocalResponsesServer({ gateway: f.gateway });
  try {
    const response = await fetch(new URL("responses", server.baseUrl), { method: "POST",
      headers: { authorization: `Bearer ${server.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify(request()) });
    expect(response.status).toBe(200);
    await response.text();
    const incidents = listDiagnosticIncidents(join(root, "diagnostics"));
    expect(incidents).toHaveLength(1);
    const incident = readDiagnosticIncident(join(root, "diagnostics"), incidents[0]!.ref) as { timeline: { stage: string }[] };
    const stages = incident.timeline.map(row => row.stage);
    expect(stages).toEqual(expect.arrayContaining([
      "provider_input_response_completed", "provider_input_response_ready",
      "provider_input_response_committed", "native_response_body_closed",
    ]));
    expect(stages).not.toContain("native_outcome_committed");
  } finally {
    await server.stop();
    await f.gateway.close();
    if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
function request(turn = "turn-1", input: unknown[] = firstInput) {
  return { model, stream: true, reasoning: { effort: "medium" }, input,
    client_metadata: { "x-codex-turn-metadata": { request_kind: "turn", thread_id: "thread-1", turn_id: turn } },
    tools: [],
  };
}

function fixture(options: { wait?: Promise<void>; onSubmit?: () => void; failure?: Error; planner?: ReturnType<typeof createNativeRequestDevelopmentWebTurnPlanner>;
  completedResults?: Parameters<typeof createSuppliedRequestGateway>[0]["completedResults"] } = {}) {
  const submissions: WebTurnRequest[] = [], selections: unknown[] = [], released: string[] = [];
  let acquisitions = 0, closed = false;
  const signal = new AbortController().signal;
  const host: BrowserHost = {
    async acquire({ taskId, epochId }) {
      acquisitions++;
      return { leaseId: `surface-${acquisitions}`, taskId, epochId,
        async navigate() {}, async reveal() {}, async hide() {},
        capability<T>(capability: BrowserSurfaceCapability<T>) { return capability.key === BROWSER_DOCUMENT_LIFETIME.key
          ? { current: () => ({ generation: 1, signal }) } as T : undefined; },
      } as BrowserSurfaceLease;
    },
    async release(id) { released.push(id); }, async close() { closed = true; },
  };
  const provider: WebConversationProvider = {
    async observeCapabilities() { throw Error("No redundant preflight"); },
    async submitTurn(_surface, turn) {
      submissions.push(turn);
      options.onSubmit?.();
      return { state: "proven", evidence: ["fixture"], value: { nativeTaskId: turn.nativeTaskId,
        nativeTurnId: turn.nativeTurnId, webEpochId: turn.webEpochId, providerTurnId: `web-${submissions.length}` } };
    },
    async observeTurn() { throw Error("No redundant observation"); },
    async armToolContinuation() { throw Error("No original Native tool authority"); },
    async waitForTurnEvent(_surface, handle) {
      await options.wait;
      if (options.failure) throw options.failure;
      return { state: "proven", evidence: ["fixture"], value: { kind: "completed", providerTurnId: handle.providerTurnId,
        answer: handle.nativeTurnId === "turn-1" ? "A inspected." : "B inspected." } };
    },
  };
  const gateway = createSuppliedRequestGateway({ browserHost: host, provider, profileSlot: 2,
    ...(options.completedResults ? { completedResults: options.completedResults } : {}),
    ...(options.planner ? { planner: options.planner } : {}),
    async prepareForSubmit(_surface, route) { selections.push(route); },
  });
  return { gateway, submissions, selections, released, get acquisitions() { return acquisitions; }, get closed() { return closed; } };
}

test("input-only dispatch joins duplicate observers and reuses settled response without Native capabilities", async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.gateway.handle(request()), f.gateway.handle(request())]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ type: "final", answer: "A inspected." });
    expect(await f.gateway.handle(request())).toEqual(a);
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]!.chatTools).toEqual({});
    expect(f.selections).toEqual([{ familyKey: chatGptWebFamilyKey("Supplied request fixture"), effort: "medium" }]);
    await expect(f.gateway.handle(request("turn-1", [{ role: "user", content: "Different question" }]))).rejects.toThrow("changed");
    expect(f.submissions).toHaveLength(1);
  } finally { await f.gateway.close(); }
  expect(f.closed).toBe(true);
});

test("account reset releases retained context and prevents an earlier account's in-memory replay", async () => {
  const f = fixture();
  const server = await startLocalResponsesServer({ gateway: f.gateway });
  const send = async () => {
    const response = await fetch(new URL("responses", server.baseUrl), { method: "POST",
      headers: { authorization: `Bearer ${server.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify(request()) });
    expect(response.status).toBe(200);
    await response.text();
  };
  try {
    await send();
    await send();
    expect(f.submissions).toHaveLength(1);
    expect(f.gateway.shutdownReadiness()).toBe("ready");
    await f.gateway.resetWebAccount();
    expect(f.released).toEqual(["surface-1"]);
    await send();
    expect(f.submissions).toHaveLength(2);
    expect(f.acquisitions).toBe(2);
  } finally { await server.stop(); await f.gateway.close(); }
});

test("durably preserved final releases shutdown and replays after gateway restart without model submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-supplied-final-"));
  const accountFingerprint = "a".repeat(64);
  const storage = () => ({ profileSlot: 2, accountFingerprint,
    store: new FileNativeVisiblePrefixStageJournal({ directory: join(root, "ledger"), initializationPath: join(root, "receipt") }) });
  const first = fixture({ completedResults: storage() });
  try {
    const final = await first.gateway.handle(request());
    expect(final).toMatchObject({ type: "final", answer: "A inspected." });
    expect(first.gateway.shutdownReadiness()).toBe("ready");
    first.gateway.prepareShutdown();
    await first.gateway.close();

    const restarted = fixture({ completedResults: storage() });
    try {
      const recovered = await restarted.gateway.handle(request());
      expect(recovered).toMatchObject({ type: "final", answer: "A inspected." });
      expect(restarted.submissions).toHaveLength(0);
      await expect(restarted.gateway.handle(request("turn-1", [{ role: "user", content: "Changed" }])))
        .rejects.toThrow("changed");
      expect(restarted.submissions).toHaveLength(0);
    } finally { await restarted.gateway.close(); }
  } finally { await first.gateway.close(); rmSync(root, { recursive: true, force: true }); }
});

test("two synthetic tool continuations persist their final request identity across gateway restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-final-multi-round-"));
  const accountFingerprint = "c".repeat(64);
  const storage = () => ({ profileSlot: 2, accountFingerprint,
    store: new FileNativeVisiblePrefixStageJournal({ directory: join(root, "ledger"),
      initializationPath: join(root, "receipt") }) });
  const host: BrowserHost = {
    async acquire({ taskId, epochId }) { return { leaseId: "round-surface", taskId, epochId,
      async navigate() {}, async reveal() {}, async hide() {}, capability() { return undefined; } } as BrowserSurfaceLease; },
    async release() {}, async close() {},
  };
  let gateway!: ReturnType<typeof createSuppliedRequestGateway>, capability = "", submissions = 0;
  const provider: WebConversationProvider = {
    async observeCapabilities() { throw Error("no preflight"); },
    async observeTurn() { throw Error("no preflight"); },
    async submitTurn(_surface, turn) {
      submissions++; capability = turn.chatTools!.nativeGoalControl!;
      return { state: "proven", evidence: ["fixture"], value: {
        nativeTaskId: turn.nativeTaskId, nativeTurnId: turn.nativeTurnId, webEpochId: turn.webEpochId,
        providerTurnId: "synthetic-multi-round" } };
    },
    async armToolContinuation(_surface, handle, callId) {
      return { state: "proven", evidence: ["fixture"], value: { providerTurnId: handle.providerTurnId, callId } };
    },
    async waitForTurnEvent(_surface, handle) {
      for (const callId of ["synthetic-one", "synthetic-two"]) {
        const pending = gateway.toolBridge.invoke(capability, {
          callId, wireName: "get_goal", mode: "structured", arguments: {},
        });
        expect((await pending).callId).toBe(callId);
      }
      return { state: "proven", evidence: ["fixture"], value: {
        kind: "completed", providerTurnId: handle.providerTurnId, answer: "Synthetic tool rounds complete." } };
    },
  };
  const body = { ...request(), tools: [{ type: "function", name: "get_goal",
    parameters: { type: "object" } }] };
  gateway = createSuppliedRequestGateway({ browserHost: host, provider, completedResults: storage(),
    async prepareForSubmit() {} });
  try {
    let current = body;
    for (const callId of ["synthetic-one", "synthetic-two"]) {
      const event = await gateway.handle(current);
      expect(event).toMatchObject({ type: "tool-call", item: { call_id: callId } });
      gateway.commit(event);
      if (event.type !== "tool-call") throw Error("expected synthetic tool call");
      current = { ...current, input: [...current.input, event.item,
        { type: "function_call_output", call_id: callId, output: "{}" }] };
    }
    expect(await gateway.handle(current)).toMatchObject({ type: "final", answer: "Synthetic tool rounds complete." });
    expect(gateway.shutdownReadiness()).toBe("ready");
    gateway.prepareShutdown();
    await gateway.close();

    const restarted = createSuppliedRequestGateway({ browserHost: host, provider,
      completedResults: storage(), async prepareForSubmit() {} });
    try {
      expect(await restarted.handle(current)).toMatchObject({
        type: "final", answer: "Synthetic tool rounds complete." });
      expect(submissions).toBe(1);
      await expect(restarted.handle(body)).rejects.toThrow("changed");
      expect(submissions).toBe(1);
    } finally { await restarted.close(); }
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed final preservation leaves undelivered completion blocking shutdown", async () => {
  const f = fixture({ completedResults: { profileSlot: 2, accountFingerprint: "b".repeat(64),
    store: { async readSuppliedResult() { return undefined; }, async preserveSuppliedResult() { return false; } } } });
  try {
    expect(await f.gateway.handle(request())).toMatchObject({ type: "final", answer: "A inspected." });
    expect(f.gateway.shutdownReadiness()).toBe("blocked");
    expect(() => f.gateway.prepareShutdown()).toThrow("Finish active Web work");
    expect(f.submissions).toHaveLength(1);
  } finally { await f.gateway.close(); }
});

test("exact host rejoin preserves a completed final after a transient storage failure", async () => {
  let writes = 0;
  const stored: string[] = [];
  const f = fixture({ completedResults: { profileSlot: 2, accountFingerprint: "b".repeat(64),
    store: {
      async readSuppliedResult() { return undefined; },
      async preserveSuppliedResult(result) {
        writes++;
        if (writes === 1) throw Error("synthetic storage unavailable");
        stored.push(result.answer);
        return true;
      },
    },
  } });
  try {
    const first = await f.gateway.handle(request());
    expect(first).toMatchObject({ type: "final", answer: "A inspected." });
    expect(f.gateway.shutdownReadiness()).toBe("blocked");
    const replay = await f.gateway.handle(request());
    expect(replay).toEqual(first);
    expect(writes).toBe(2);
    expect(stored).toEqual(["A inspected."]);
    expect(f.submissions).toHaveLength(1);
    expect(f.gateway.shutdownReadiness()).toBe("ready");
  } finally { await f.gateway.close(); }
});

test("account changes during Web execution do not persist a final, while HTTP still returns success", async () => {
  let release!: () => void, started!: () => void, account = "a".repeat(64), preserved = 0;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const submitted = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({ wait, onSubmit: started, completedResults: () => ({
    profileSlot: 2, accountFingerprint: account,
    store: {
      async readSuppliedResult() { return undefined; },
      async preserveSuppliedResult() { preserved++; return true; },
    },
  }) });
  const wire = new Request("http://127.0.0.1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request(), stream: false }),
  });
  try {
    const pending = handleNativeResponsesHttp(wire, f.gateway);
    await submitted;
    account = "b".repeat(64);
    release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(f.gateway.shutdownReadiness()).toBe("blocked");
    expect(JSON.stringify(await response.json())).toContain("A inspected.");
    expect(preserved).toBe(0);
    expect(f.gateway.shutdownReadiness()).toBe("ready");
    expect(f.submissions).toHaveLength(1);
  } finally { release(); await f.gateway.close(); }
});

test("input-only continuation uses the existing exact retained-delta planner and physical page", async () => {
  const f = fixture();
  try {
    f.gateway.commit(await f.gateway.handle(request()));
    await f.gateway.handle(request("turn-2", [...firstInput,
      { type: "message", role: "assistant", content: "A inspected." },
      { type: "message", role: "user", content: "Inspect B." },
    ]));
    expect(f.acquisitions).toBe(1);
    expect(f.submissions[1]!.physicalContext.mode).toBe("retained-delta");
    expect(JSON.stringify(f.submissions[1]!.physicalContext.segments)).not.toContain("Inspect A.");
    expect(JSON.stringify(f.submissions[1]!.physicalContext.segments)).toContain("Inspect B.");
    await expect(f.gateway.handle(request())).rejects.toThrow("superseded");
    expect(f.submissions).toHaveLength(2);
  } finally { await f.gateway.close(); }
});

test("disconnect detaches only the observer; the accepted Web operation is neither cancelled nor resubmitted", async () => {
  let release!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  const f = fixture({ wait }), observer = new AbortController();
  try {
    const first = f.gateway.handle(request(), { signal: observer.signal });
    const replay = f.gateway.handle(request());
    observer.abort(new Error("Presentation disconnected"));
    await expect(first).rejects.toThrow("Presentation disconnected");
    release();
    expect(await replay).toMatchObject({ type: "final" });
    expect(f.submissions).toHaveLength(1);
  } finally { release(); await f.gateway.close(); }
});

test("completed Web answer survives observer disconnect until an identical late replay", async () => {
  let release!: () => void, markSettled!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const settled = new Promise<void>(resolve => { markSettled = resolve; });
  const original = createNativeRequestDevelopmentWebTurnPlanner();
  const planner = Object.assign((...args: Parameters<typeof original>) => original(...args), {
    retireSurface: (task: string, surface: string) => original.retireSurface(task, surface),
    async planSuppliedRequest(...args: Parameters<typeof original.planSuppliedRequest>) {
      const plan = await original.planSuppliedRequest(...args);
      return { ...plan, settle: (outcome: Parameters<NonNullable<typeof plan.settle>>[0]) => {
        plan.settle?.(outcome);
        if (outcome.status === "completed") markSettled();
      } };
    },
  });
  const f = fixture({ wait, planner }), observer = new AbortController();
  const body = { ...request(), tools: [] };
  try {
    const disconnected = f.gateway.handle(body, { signal: observer.signal });
    observer.abort(new Error("Responses host disconnected"));
    await expect(disconnected).rejects.toThrow("Responses host disconnected");
    release();
    // The browser result reached the planner with no attached HTTP observer.
    await settled;
    const rejoined = await f.gateway.handle(body);
    expect(rejoined).toMatchObject({ type: "final", answer: "A inspected." });
    expect(await f.gateway.handle(body)).toEqual(rejoined);
    expect(f.submissions).toHaveLength(1);
  } finally { release(); await f.gateway.close(); }
});

test("opaque input cannot acquire Native history or a browser through supplied identifiers", async () => {
  let nativeReads = 0;
  const planner = createNativeRequestDevelopmentWebTurnPlanner({
    async compactionHistory() { nativeReads++; throw Error("Native source must stay unreachable"); },
    async preparationBudgetFor() { nativeReads++; throw Error("Native compaction budget must stay unreachable"); },
  });
  const f = fixture({ planner });
  try {
    await expect(f.gateway.handle(request("turn-1", [
      { type: "compaction", encrypted_content: "opaque" }, ...firstInput,
    ]))).rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
    expect(nativeReads).toBe(0);
    expect(f.acquisitions).toBe(0);
  } finally { await f.gateway.close(); }
});

test("a failed accepted operation stays failed for replay, with no second model send", async () => {
  const failure = new Error("Owned provider failed"), f = fixture({ failure });
  try {
    await expect(f.gateway.handle(request())).rejects.toBe(failure);
    await expect(f.gateway.handle(request())).rejects.toBe(failure);
    expect(f.submissions).toHaveLength(1);
    expect(f.released).toEqual([]);
  } finally { await f.gateway.close(); }
});

test("ordinary authenticated Responses ingress delivers a compressed input-only request over real HTTP", async () => {
  const f = fixture(), server = await startLocalResponsesServer({ gateway: f.gateway });
  try {
    const response = await fetch(new URL("responses", server.baseUrl), { method: "POST",
      headers: { authorization: `Bearer ${server.runtimeToken}`, "content-encoding": "zstd" },
      body: zstdCompressSync(Buffer.from(JSON.stringify(request()))),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("A inspected.");
    expect(body).toContain("response.completed");
    expect(f.submissions).toHaveLength(1);
  } finally { await server.stop(); await f.gateway.close(); }
});

test("structured MCP Goal calls roundtrip through the supplied host with canonical prior results", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createPublicMcpServer } = await import("../../gateway/src/public-server");
  const { DynamicChatBackend } = await import("../../gateway/src/dynamic-chat-backend");
  const { DynamicCodexTurnBridge } = await import("../../gateway/src/dynamic-codex-turn-bridge");
  const { RoutedCodexTurnBridge } = await import("../../codex-service/src/routed-turn-bridge");
  const { startCodexServiceHttpServer } = await import("../../codex-service/src/http-server");
  const { startCodexBridgeMcpHttpServer, connectCodexTurnBridge, McpTurnBridge } = await import("@chatgpt-tela/mcp");
  const { ActiveTurnRegistry, turnCapabilityRoute } = await import("@chatgpt-tela/runtime");
  const armed: string[] = [];
  let control = "", mcp: InstanceType<typeof Client>;
  const provider: WebConversationProvider = {
    async observeCapabilities() { throw Error("No preflight"); },
    async observeTurn() { throw Error("No preflight"); },
    async submitTurn(_surface, turn) {
      control = turn.chatTools!.nativeGoalControl!;
      return { state: "proven", evidence: ["fixture"], value: {
        nativeTaskId: turn.nativeTaskId, nativeTurnId: turn.nativeTurnId,
        webEpochId: turn.webEpochId, providerTurnId: "goal-web" } };
    },
    async armToolContinuation(_surface, handle, callId) {
      armed.push(callId);
      return { state: "proven", evidence: ["exact host result fence"], value: { providerTurnId: handle.providerTurnId, callId } };
    },
    async waitForTurnEvent(_surface, handle) {
      for (const [callId, name, args] of [["read-goal", "get_goal", {}],
        ["complete-goal", "update_goal", { status: "complete" }]] as const) {
        const result = await mcp.callTool({ name: "chatgpt_tela_chat_capability_call", arguments: {
          capability: "goal_control_call", arguments: { goal_control: control,
            call_id: callId, wire_name: name, arguments: args } } });
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result)).toContain(name === "get_goal" ? "paused" : "complete");
      }
      return { state: "proven", evidence: ["fixture"], value: {
        kind: "completed", providerTurnId: handle.providerTurnId, answer: "Host Goal settled." } };
    },
  };
  // Reuse the ordinary browser fixture; only the provider is replaced.
  const host: BrowserHost = {
    async acquire({ taskId, epochId }) { return { leaseId: "goal-surface", taskId, epochId,
      async navigate() {}, async reveal() {}, async hide() {}, capability() { return undefined; } } as BrowserSurfaceLease; },
    async release() {}, async close() {},
  };
  const gateway = createSuppliedRequestGateway({ browserHost: host, provider, routeId: "ProfileB2", async prepareForSubmit() {} });
  const profileBridge = createProfileTurnBridge(new McpTurnBridge(new ActiveTurnRegistry({ routeId: "ProfileB2" })), gateway);
  const profileMcp = await startCodexBridgeMcpHttpServer({ bridge: profileBridge,
    authentication: { kind: "bearer", token: "p".repeat(48) } });
  const profileClient = await connectCodexTurnBridge({ endpoint: profileMcp.endpointUrl,
    bearerToken: "p".repeat(48) });
  const router = new RoutedCodexTurnBridge();
  router.mount("ProfileB2", profileClient);
  const service = await startCodexServiceHttpServer({
    service: { tools: router } as unknown as Parameters<typeof startCodexServiceHttpServer>[0]["service"],
  });
  const codex = new DynamicCodexTurnBridge(() => ({ version: 1, service: "codex",
    instanceId: "fixture-codex-service", installId: "fixture-install", pid: 1,
    endpoint: service.endpoint.href, bearerToken: service.bearerToken,
    startedAt: "2026-11-07T00:00:00.000Z" }));
  const backend = new DynamicChatBackend(() => undefined, codex);
  const server = createPublicMcpServer({ chat: backend });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "supplied-host-goal-fixture", version: "1.0.0" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const body = { ...request(), tools: ["get_goal", "update_goal"].map(name => ({
    type: "function", name, parameters: { type: "object" } })) };
  try {
    const first = await gateway.handle(body);
    expect(turnCapabilityRoute(control)).toBe("ProfileB2");
    expect(first).toMatchObject({ type: "tool-call", item: { call_id: "read-goal", name: "get_goal" } });
    gateway.commit(first);
    const firstOutput = { type: "function_call_output", call_id: "read-goal", output: '{"status":"paused"}' };
    const secondBody = { ...body, input: [...body.input, ...(first.type === "tool-call" ? [first.item] : []), firstOutput] };
    const second = await gateway.handle(secondBody);
    expect(second).toMatchObject({ type: "tool-call", item: { call_id: "complete-goal", name: "update_goal" } });
    gateway.commit(second);
    const finalBody = { ...body, input: [...secondBody.input,
      ...(second.type === "tool-call" ? [second.item] : []),
      { type: "function_call_output", call_id: "complete-goal", output: '{"status":"complete"}' }] };
    const final = await gateway.handle(finalBody);
    expect(final).toMatchObject({ type: "final", answer: "Host Goal settled." });
    expect(await gateway.handle(finalBody)).toEqual(final);
    expect(armed).toEqual(["read-goal", "complete-goal"]);
    expect(() => gateway.toolBridge.inventory(control)).toThrow("retired");
    await expect(codex.inventory(control)).rejects.toThrow();
  } finally { await mcp.close(); await server.close(); await service.close(); await profileClient.close(); await profileMcp.stop(); await gateway.close(); }
});

test("shutdown protects accepted work and unreceived answers without retaining settled failures", async () => {
  let release!: () => void;
  const f = fixture({ wait: new Promise<void>(resolve => { release = resolve; }) });
  try {
    const answer = f.gateway.handle(request());
    expect(f.gateway.shutdownReadiness()).toBe("blocked");
    expect(() => f.gateway.prepareShutdown()).toThrow("active Web work");
    release();
    const outcome = await answer;
    expect(f.gateway.shutdownReadiness()).toBe("blocked");
    f.gateway.commit(outcome);
    expect(f.gateway.shutdownReadiness()).toBe("ready");
    f.gateway.prepareShutdown();
    await expect(f.gateway.handle(request("new-turn"))).rejects.toThrow("admission closed");
  } finally { release(); await f.gateway.close(); }
  const failed = fixture({ failure: new Error("Settled provider failure") });
  try {
    await expect(failed.gateway.handle(request())).rejects.toThrow("Settled provider failure");
    expect(failed.gateway.shutdownReadiness()).toBe("ready");
    failed.gateway.prepareShutdown();
  } finally { await failed.gateway.close(); }
});
