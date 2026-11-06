import { expect, test } from "bun:test";
import { zstdCompressSync } from "node:zlib";
import { BROWSER_DOCUMENT_LIFETIME, type BrowserHost, type BrowserSurfaceLease, type BrowserSurfaceCapability } from "@chatgpt-tela/browser-host";
import { chatGptWebFamilyKey, chatGptWebModelId, type WebConversationProvider, type WebTurnRequest } from "@chatgpt-tela/chatgpt";
import { NativeHistoryBootstrapRequired } from "@chatgpt-tela/codex";
import { startLocalResponsesServer } from "@chatgpt-tela/local-server";
import { createSuppliedRequestGateway } from "./supplied-request-gateway";
import { createNativeRequestDevelopmentWebTurnPlanner } from "./native-request-planner";

const model = chatGptWebModelId(chatGptWebFamilyKey("Supplied request fixture"));
const firstInput = [{ type: "message", role: "user", content: "Inspect A." }];
function request(turn = "turn-1", input: unknown[] = firstInput) {
  return { model, stream: true, reasoning: { effort: "medium" }, input,
    client_metadata: { "x-codex-turn-metadata": { request_kind: "turn", thread_id: "thread-1", turn_id: turn } },
    tools: [{ type: "function", name: "update_goal", parameters: { type: "object" } }],
  };
}

function fixture(options: { wait?: Promise<void>; failure?: Error; planner?: ReturnType<typeof createNativeRequestDevelopmentWebTurnPlanner> } = {}) {
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
    expect(f.submissions[0]!.chatTools).toEqual({ defaultProfileSlot: 2 });
    expect(f.selections).toEqual([{ familyKey: chatGptWebFamilyKey("Supplied request fixture"), effort: "medium" }]);
    await expect(f.gateway.handle(request("turn-1", [{ role: "user", content: "Different question" }]))).rejects.toThrow("changed");
    expect(f.submissions).toHaveLength(1);
  } finally { await f.gateway.close(); }
  expect(f.closed).toBe(true);
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
