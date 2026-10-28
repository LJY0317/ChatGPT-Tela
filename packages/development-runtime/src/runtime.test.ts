import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BROWSER_DOCUMENT_LIFETIME, ControlledBrowserHost } from "@chatgpt-tela/browser-host";
import type {
  SemanticObservation,
  WebConversationProvider,
  WebTurnEvent,
  WebTurnHandle,
  WebTurnRequest,
} from "@chatgpt-tela/chatgpt";
import type { CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import {
  CHATGPT_TELA_CODEX_TOOL_CALL,
  CHATGPT_TELA_CODEX_TOOL_INVENTORY,
  ExistingHttpsExposure,
} from "@chatgpt-tela/mcp";
import { startDevelopmentRuntime } from "./runtime";
import { createNativeRequestDevelopmentWebTurnPlanner } from "./native-request-planner";
import { setPrivateDiagnosticCapture, structuralDiagnosticEvent } from "@chatgpt-tela/core";

const source: CanonicalCurrentTurnSource = {
  async currentTurn(threadId) {
    return {
      threadId,
      turnId: "turn-1",
      cwd: "/workspace",
      workspaceRoots: ["/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
      proof: "turn-context",
      environmentSourceTurnId: "turn-1",
    };
  },
};

function nativeRequest(input: unknown[] = []): Record<string, unknown> {
  return {
    model: "chatgpt-tela-test-model",
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": {
        request_kind: "turn",
        thread_id: "thread-1",
        turn_id: "turn-1",
      },
    },
    input,
    tools: [{
      type: "function",
      name: "exec_command",
      description: "command",
      parameters: { type: "object" },
    }],
  };
}

class ConnectorRoundProvider implements WebConversationProvider {
  #request: WebTurnRequest | undefined;
  #toolCall: Promise<void> | undefined;
  #continuationEmitted = false;

  constructor(
    readonly client: Client,
    readonly toolName = "chatgpt_tela_dev_tool_call",
    readonly expectedContract: "development" | "stable" = "development",
  ) {}

  async observeCapabilities() {
    return {
      state: "proven" as const,
      value: { observed: new Set(["composer", "send"]) },
      evidence: ["fixture"],
    };
  }

  async submitTurn(_surface: unknown, request: WebTurnRequest) {
    this.#request = request;
    return {
      state: "proven" as const,
      value: {
        nativeTaskId: request.nativeTaskId,
        nativeTurnId: request.nativeTurnId,
        webEpochId: request.webEpochId,
        providerTurnId: "web-turn-1",
      },
      evidence: ["fixture"],
    };
  }

  async observeTurn(): Promise<SemanticObservation<{ providerTurnId: string; phase: "accepted" }>> {
    return {
      state: "proven",
      value: { providerTurnId: "web-turn-1", phase: "accepted" },
      evidence: ["fixture"],
    };
  }

  async armToolContinuation(_surface: unknown, turn: WebTurnHandle, callId: string) {
    return {
      state: "proven" as const,
      value: { providerTurnId: turn.providerTurnId, callId },
      evidence: ["fixture"],
    };
  }

  async waitForTurnEvent(_surface?: unknown, _turn?: WebTurnHandle, signal?: AbortSignal): Promise<SemanticObservation<WebTurnEvent>> {
    const request = this.#request;
    if (!request?.toolBridge) throw new Error("development turn is missing its MCP capability");
    if (request.toolBridge.contract !== this.expectedContract) {
      throw new Error(`unexpected MCP bridge contract: ${request.toolBridge.contract}`);
    }
    if (!this.#toolCall) {
      this.#toolCall = this.client.callTool({
          name: this.toolName,
          arguments: {
            turn_capability: request.toolBridge.turnCapability,
            call_id: "call-1",
            wire_name: "exec_command",
            mode: "structured",
            arguments: { cmd: ["printf", "ok"] },
          },
        })
        .then(result => {
          if (result.isError) throw new Error("fixture MCP tool call failed");
        });
    }
    await this.#toolCall;
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (!this.#continuationEmitted) {
      this.#continuationEmitted = true;
      return {
        state: "proven",
        value: { kind: "continuing", providerTurnId: "web-turn-1" },
        evidence: ["fixture"],
      };
    }
    return {
      state: "proven",
      value: { kind: "completed", providerTurnId: "web-turn-1", answer: "web-final" },
      evidence: ["fixture"],
    };
  }
}

class ExternalContractProvider implements WebConversationProvider {
  observedContract: "development" | "stable" | undefined;

  async observeCapabilities() {
    return {
      state: "proven" as const,
      value: { observed: new Set(["composer", "send"]) },
      evidence: ["fixture"],
    };
  }

  async submitTurn(_surface: unknown, request: WebTurnRequest) {
    if (!request.toolBridge) throw new Error("external contract fixture requires a tool bridge");
    this.observedContract = request.toolBridge.contract;
    return {
      state: "proven" as const,
      value: {
        nativeTaskId: request.nativeTaskId,
        nativeTurnId: request.nativeTurnId,
        webEpochId: request.webEpochId,
        providerTurnId: "external-contract-turn",
      },
      evidence: ["fixture"],
    };
  }

  async observeTurn(): Promise<SemanticObservation<{ providerTurnId: string; phase: "accepted" }>> {
    return {
      state: "proven",
      value: { providerTurnId: "external-contract-turn", phase: "accepted" },
      evidence: ["fixture"],
    };
  }

  async armToolContinuation(_surface: unknown, turn: WebTurnHandle, callId: string) {
    return {
      state: "proven" as const,
      value: { providerTurnId: turn.providerTurnId, callId },
      evidence: ["fixture"],
    };
  }

  async waitForTurnEvent(): Promise<SemanticObservation<WebTurnEvent>> {
    return {
      state: "proven",
      value: { kind: "completed", providerTurnId: "external-contract-turn", answer: "external-v2-final" },
      evidence: ["fixture"],
    };
  }
}

class RetainedFinalProvider implements WebConversationProvider {
  readonly surfaceLeaseIds: string[] = [];

  async observeCapabilities(): ReturnType<WebConversationProvider["observeCapabilities"]> {
    throw new Error("runtime must not perform redundant readiness probing");
  }

  async submitTurn(surface: { leaseId: string }, request: WebTurnRequest) {
    this.surfaceLeaseIds.push(surface.leaseId);
    return {
      state: "proven" as const,
      value: {
        nativeTaskId: request.nativeTaskId,
        nativeTurnId: request.nativeTurnId,
        webEpochId: request.webEpochId,
        providerTurnId: `web-${request.nativeTurnId}`,
      },
      evidence: ["fixture"],
    };
  }

  async observeTurn(_surface: unknown, turn: WebTurnHandle) {
    return {
      state: "proven" as const,
      value: { providerTurnId: turn.providerTurnId, phase: "accepted" as const },
      evidence: ["fixture"],
    };
  }

  async armToolContinuation(_surface: unknown, turn: WebTurnHandle, callId: string) {
    return {
      state: "proven" as const,
      value: { providerTurnId: turn.providerTurnId, callId },
      evidence: ["fixture"],
    };
  }

  async waitForTurnEvent(_surface: unknown, turn: WebTurnHandle) {
    return {
      state: "proven" as const,
      value: { kind: "completed" as const, providerTurnId: turn.providerTurnId, answer: `done:${turn.nativeTurnId}` },
      evidence: ["fixture"],
    };
  }
}

class HangingProvider implements WebConversationProvider {
  async observeCapabilities() {
    return {
      state: "proven" as const,
      value: { observed: new Set(["composer", "send"]) },
      evidence: ["fixture"],
    };
  }

  async submitTurn(_surface: unknown, request: WebTurnRequest) {
    return {
      state: "proven" as const,
      value: {
        nativeTaskId: request.nativeTaskId,
        nativeTurnId: request.nativeTurnId,
        webEpochId: request.webEpochId,
        providerTurnId: "hanging-web-turn",
      },
      evidence: ["fixture"],
    };
  }

  async observeTurn(): Promise<SemanticObservation<{ providerTurnId: string; phase: "accepted" }>> {
    return {
      state: "proven",
      value: { providerTurnId: "hanging-web-turn", phase: "accepted" },
      evidence: ["fixture"],
    };
  }

  async armToolContinuation(_surface: unknown, turn: WebTurnHandle, callId: string) {
    return {
      state: "proven" as const,
      value: { providerTurnId: turn.providerTurnId, callId },
      evidence: ["fixture"],
    };
  }

  async waitForTurnEvent(
    _surface?: unknown,
    _turn?: WebTurnHandle,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebTurnEvent>> {
    return await new Promise((_, reject) => {
      const abort = () => reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("aborted", "AbortError"),
      );
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

async function post(baseUrl: URL, token: string, body: unknown): Promise<Response> {
  return fetch(new URL("responses", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("development runtime composition", () => {
  test.each([false, true] as const)(
    "a fresh full Native projection never reuses a completed Web page when the epoch repeats (document proof: %s)",
    async hasDocumentProof => {
      // The transport epoch is deterministically derived from the canonical
      // Native head. Two distinct original Native turns can have identical
      // request text, hence identical epoch IDs. Whether or not the prior Web
      // page has a document-lifetime proof, the new request has no matching
      // preceding Native assistant answer and must use a fresh physical page.
      let nativeTurnId = "turn-1";
      let created = 0;
      let closed = 0;
      const host = new ControlledBrowserHost(async () => {
        created++;
        return {
          async navigate() {}, async reveal() {}, async hide() {},
          async close() { closed++; },
          // A present document owner is still not license to append a *full*
          // reconstruction when no canonical Native assistant boundary matches.
          capability(capability) {
            return hasDocumentProof && capability === BROWSER_DOCUMENT_LIFETIME
              ? { current: () => ({ generation: 1, signal: new AbortController().signal }) } as never
              : undefined;
          },
        };
      });
      const provider = new RetainedFinalProvider();
      const originalPlanner = createNativeRequestDevelopmentWebTurnPlanner();
      const modes: string[] = [];
      const epochs: string[] = [];
      const runtime = await startDevelopmentRuntime({
        currentTurnSource: {
          async currentTurn(threadId) {
            return {
              ...(await source.currentTurn(threadId))!,
              turnId: nativeTurnId, environmentSourceTurnId: nativeTurnId,
            };
          },
        },
        browserHost: host, provider,
        mcp: { kind: "external", abi: "stable" },
        async planWebTurn(turn, request, preparation) {
          const plan = await originalPlanner(turn, request, preparation);
          modes.push(plan.physicalContext.mode);
          epochs.push(plan.webEpochId);
          return plan;
        },
      });
      const request = () => ({
        ...nativeRequest([{ type: "message", role: "user", content: "Repeat the same source-only request." }]),
        client_metadata: { "x-codex-turn-metadata": {
          request_kind: "turn", thread_id: "thread-1", turn_id: nativeTurnId,
        } },
      });
      try {
        const first = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, request());
        expect(first.status).toBe(200);
        expect(await first.text()).toContain("done:turn-1");
        nativeTurnId = "turn-2";
        const second = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, request());
        expect(second.status).toBe(200);
        expect(await second.text()).toContain("done:turn-2");
        expect(modes).toEqual(["full", "full"]);
        expect(epochs[1]).toBe(epochs[0]);
        expect(provider.surfaceLeaseIds).toHaveLength(2);
        expect(new Set(provider.surfaceLeaseIds).size).toBe(2);
        expect(created).toBe(2);
        expect(closed).toBe(1);
      } finally {
        await runtime.stop();
      }
      expect(closed).toBe(created);
    },
  );

  test("retains one browser surface across sequential Native turns in the same Web epoch", async () => {
    let canonicalTurnId = "turn-1";
    const sequentialSource: CanonicalCurrentTurnSource = {
      async currentTurn(threadId) {
        return {
          threadId,
          turnId: canonicalTurnId,
          cwd: "/workspace",
          workspaceRoots: ["/workspace"],
          sandbox: { kind: "read-only", network: "restricted" },
          proof: "turn-context",
          environmentSourceTurnId: canonicalTurnId,
        };
      },
    };
    const browserEvents: string[] = [];
    let browserCreations = 0;
    const browserHost = new ControlledBrowserHost(async () => {
      browserCreations += 1;
      return {
        async navigate() {}, async reveal() {}, async hide() {},
        async close() { browserEvents.push("surface-close"); },
        capability(capability) { return capability === BROWSER_DOCUMENT_LIFETIME ? { current: () => ({ generation: 1, signal: new AbortController().signal }) } as never : undefined; },
      };
    });
    const provider = new RetainedFinalProvider();
    const submitted: WebTurnRequest[] = [];
    const submit = provider.submitTurn.bind(provider);
    provider.submitTurn = async (surface, request) => {
      submitted.push(request);
      return submit(surface, request);
    };
    let committedSurface: string | undefined;
    const runtime = await startDevelopmentRuntime({
      profileSlot: 2,
      currentTurnSource: sequentialSource,
      browserHost,
      mcp: { kind: "external", abi: "stable" },
      provider,
      planWebTurn(turn) {
        const turnId = turn.channel.binding.authority.turnId;
        return {
          nativeTaskId: turn.channel.binding.authority.threadId,
          webEpochId: "shared-epoch",
          ...(committedSurface ? { retainedSurfaceLeaseId: committedSurface, retainedDocumentGeneration: 1 } : {}),
          settle(outcome) {
            committedSurface = outcome.status === "completed" ? outcome.surfaceLeaseId : undefined;
          },
          physicalContext: {
            headRevisionId: `revision-${turnId}`,
            mode: turnId === "turn-1" ? "full" : "retained-delta",
            ...(turnId === "turn-2" ? { baseRevisionId: "revision-turn-1" } : {}),
            activeRequestRevisionId: `revision-${turnId}`,
            logicalTokens: turnId === "turn-1" ? 10 : 20,
            transferTokens: 10,
            segments: [{
              type: "revision",
              revisionId: `revision-${turnId}`,
              kind: "user",
              content: `request:${turnId}`,
            }],
          },
        };
      },
    });
    const requestFor = (turnId: string) => ({
      ...nativeRequest([{ type: "message", role: "user", content: `request:${turnId}` }]),
      client_metadata: {
        "x-codex-turn-metadata": {
          request_kind: "turn",
          thread_id: "thread-1",
          turn_id: turnId,
        },
      },
    });

    try {
      const first = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, requestFor("turn-1"));
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("done:turn-1");
      canonicalTurnId = "turn-2";
      const second = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, requestFor("turn-2"));
      expect(second.status).toBe(200);
      expect(await second.text()).toContain("done:turn-2");

      expect(browserCreations).toBe(1);
      // Even when the Native request advertises a command tool, the default
      // Web route carries no exact Native turn bearer to either submission.
      expect(submitted).toHaveLength(2);
      expect(submitted.map(request => Object.hasOwn(request, "toolBridge"))).toEqual([false, false]);
      expect(submitted.map(request => request.chatTools)).toEqual([{ defaultProfileSlot: 2 }, { defaultProfileSlot: 2 }]);
      expect(submitted.map(request => request.physicalContext.mode)).toEqual(["full", "retained-delta"]);
      expect(submitted[0]!.webEpochId).toBe(submitted[1]!.webEpochId);
      expect(provider.surfaceLeaseIds).toHaveLength(2);
      expect(new Set(provider.surfaceLeaseIds).size).toBe(1);
      expect(browserEvents).toEqual([]);
    } finally {
      await runtime.stop();
    }
    expect(browserEvents).toEqual(["surface-close"]);
  });

  test.each(["replaced-epoch", "wrong-lease", "missing-lease", "replaced-document", "missing-document"] as const)(
    "rejects retained context before submission when its physical owner is %s",
    async mismatch => {
      let turnId = "turn-1";
      let lease: string | undefined;
      let failed = false;
      let closed = 0;
      const browserHost = new ControlledBrowserHost(async () => ({
        async navigate() {}, async reveal() {}, async hide() {}, async close() { closed += 1; },
        capability(capability) { return capability === BROWSER_DOCUMENT_LIFETIME && !(mismatch === "missing-document" && turnId === "turn-2") ? { current: () => ({ generation: mismatch === "replaced-document" && turnId === "turn-2" ? 2 : 1, signal: new AbortController().signal }) } as never : undefined; },
      }));
      const provider = new RetainedFinalProvider();
      const runtime = await startDevelopmentRuntime({
        currentTurnSource: { async currentTurn(threadId) { return { ...(await source.currentTurn(threadId))!, turnId, environmentSourceTurnId: turnId }; } },
        browserHost, provider, mcp: { kind: "external", abi: "stable" },
        planWebTurn(turn) {
          const retained = turnId === "turn-2";
          const expectedLease = retained ? (mismatch === "wrong-lease" ? "other-page" : mismatch === "missing-lease" ? undefined : lease) : undefined;
          return {
            nativeTaskId: turn.channel.binding.authority.threadId,
            webEpochId: retained && mismatch === "replaced-epoch" ? "new-epoch" : "epoch",
            ...(expectedLease ? { retainedSurfaceLeaseId: expectedLease, retainedDocumentGeneration: 1 } : {}),
            physicalContext: { headRevisionId: turnId, activeRequestRevisionId: turnId,
              mode: retained ? "retained-delta" : "full", logicalTokens: 1, transferTokens: 1,
              segments: [{ type: "revision", revisionId: turnId, kind: "user", content: "request" }],
            },
            settle(outcome) { if (outcome.status === "completed") lease = outcome.surfaceLeaseId; else failed = true; },
          };
        },
      });
      const request = () => ({ ...nativeRequest(), client_metadata: { "x-codex-turn-metadata": {
        request_kind: "turn", thread_id: "thread-1", turn_id: turnId,
      } } });
      try {
        const first = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, request());
        expect(first.status).toBe(200); await first.text();
        turnId = "turn-2";
        const second = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, request());
        expect(second.status).toBe(400);
        expect(await second.text()).toContain("surviving physical surface");
        expect(provider.surfaceLeaseIds).toHaveLength(1);
        expect(failed).toBe(true);
        expect(closed).toBe(mismatch === "replaced-epoch" ? 2 : 1);
      } finally { await runtime.stop(); }
    },
  );

  test.each(["before-submit", "during-response"] as const)("document loss %s stops the turn without committing its answer", async phase => {
    const documentController = new AbortController();
    let completed = false;
    let failed = false;
    let closed = 0;
    const browserHost = new ControlledBrowserHost(async () => ({
      async navigate() {}, async reveal() {}, async hide() {}, async close() { closed += 1; },
      capability(capability) { return capability === BROWSER_DOCUMENT_LIFETIME ? { current: () => ({ generation: 1, signal: documentController.signal }) } as never : undefined; },
    }));
    const provider = new RetainedFinalProvider();
    const submit = provider.submitTurn.bind(provider);
    provider.submitTurn = async (surface, request) => {
      if (phase === "before-submit") {
        documentController.abort(new Error("fixture document lost"));
        documentController.signal.throwIfAborted();
      }
      return submit(surface, request);
    };
    const event = provider.waitForTurnEvent.bind(provider);
    provider.waitForTurnEvent = async (surface, turn) => { documentController.abort(new Error("fixture document lost")); return event(surface, turn); };
    const runtime = await startDevelopmentRuntime({
      currentTurnSource: source, browserHost, provider, mcp: { kind: "external", abi: "stable" },
      planWebTurn: turn => ({ nativeTaskId: turn.channel.binding.authority.threadId, webEpochId: "epoch",
        physicalContext: { headRevisionId: "revision", mode: "full", logicalTokens: 1, transferTokens: 1, segments: [] },
        settle(outcome) { completed = outcome.status === "completed"; failed = outcome.status === "failed"; },
      }),
    });
    try {
      const response = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, nativeRequest());
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("fixture document lost");
      expect(provider.surfaceLeaseIds).toHaveLength(phase === "before-submit" ? 0 : 1);
      expect(completed).toBe(false); expect(failed).toBe(true); expect(closed).toBe(1);
    } finally { await runtime.stop(); }
  });

  test("bounded idle eviction reconstructs canonical history through the real planner on later explicit use", async () => {
    const requests: WebTurnRequest[] = [];
    let turnId = "turn-1";
    let closed = 0;
    const host = new ControlledBrowserHost(async () => ({
      async navigate() {}, async reveal() {}, async hide() {}, async close() { closed += 1; },
      capability(capability) { return capability === BROWSER_DOCUMENT_LIFETIME ? { current: () => ({generation:1,signal:new AbortController().signal}) } as never : undefined; },
    }));
    const provider = new RetainedFinalProvider();
    const submit = provider.submitTurn.bind(provider);
    provider.submitTurn = async (surface, request) => { requests.push(request); return submit(surface, request); };
    const runtime = await startDevelopmentRuntime({
      currentTurnSource: { async currentTurn(threadId) { return {...(await source.currentTurn(threadId))!,turnId,environmentSourceTurnId:turnId}; } },
      browserHost: host, provider, mcp: {kind:"external",abi:"stable"},
      planWebTurn: createNativeRequestDevelopmentWebTurnPlanner(), maxIdleBrowserEpochs: 1,
    });
    const send = async (threadId: string, input: unknown[]) => {
      const response = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, {
        ...nativeRequest(input),client_metadata:{"x-codex-turn-metadata":{request_kind:"turn",thread_id:threadId,turn_id:turnId}},
      });
      expect(response.status).toBe(200); await response.text();
    };
    try {
      const firstInput=[{type:"message",role:"user",content:"Task A exact history"}];
      await send("task-A",firstInput);
      await send("task-B",[{type:"message",role:"user",content:"Task B"}]);
      expect(closed).toBe(1); expect(host.activeSurfaceCount).toBe(1);
      turnId="turn-2";
      await send("task-A",[...firstInput,{type:"message",role:"assistant",content:"done:turn-1"},{type:"message",role:"user",content:"Continue A"}]);
      expect(requests[2]!.physicalContext.mode).toBe("full");
      expect(JSON.stringify(requests[2]!.physicalContext.segments)).toContain("Task A exact history");
      expect(provider.surfaceLeaseIds[2]).not.toBe(provider.surfaceLeaseIds[0]);
      expect(host.activeSurfaceCount).toBe(1);
    } finally { await runtime.stop(); }
  });

  test("original Native thread survives model switch, readable compaction, Web failure and fresh recovery without stale epoch replay", async () => {
    let turnId = "turn-1";
    let browserCreated = 0;
    let browserClosed = 0;
    const observations: Array<{
      turnId: string;
      mode: string;
      epoch: string;
      segments: string[];
    }> = [];
    const nativeSource: CanonicalCurrentTurnSource = {
      async currentTurn(threadId) {
        return { ...(await source.currentTurn(threadId))!, turnId,
          environmentSourceTurnId: turnId };
      },
    };
    const browserHost = new ControlledBrowserHost(async () => {
      browserCreated += 1;
      return {
        async navigate() {}, async reveal() {}, async hide() {},
        async close() { browserClosed += 1; },
        capability(capability) {
          return capability === BROWSER_DOCUMENT_LIFETIME
            ? { current: () => ({ generation: 1, signal: new AbortController().signal }) } as never
            : undefined;
        },
      };
    });
    const provider = new RetainedFinalProvider();
    const normalEvent = provider.waitForTurnEvent.bind(provider);
    provider.waitForTurnEvent = async (surface, handle) => {
      if (handle.nativeTurnId === "turn-6") {
        throw new Error("synthetic Web observation rejected after Native submission");
      }
      return normalEvent(surface, handle);
    };
    const realPlanner = createNativeRequestDevelopmentWebTurnPlanner();
    const runtime = await startDevelopmentRuntime({
      currentTurnSource: nativeSource,
      browserHost, provider, mcp: { kind: "external", abi: "stable" },
      async planWebTurn(turn, request, preparation) {
        const plan = await realPlanner(turn, request, preparation);
        observations.push({
          turnId: turn.channel.binding.authority.turnId,
          mode: plan.physicalContext.mode,
          epoch: plan.webEpochId,
          segments: plan.physicalContext.segments.map(segment => segment.content),
        });
        return plan;
      },
    });
    const message = (role: string, content: string) => ({ type: "message", role, content });
    const history = [message("user", "Read the source repository.")];
    const run = async (current: string, model: string, input: unknown[], expectedStatus = 200) => {
      turnId = current;
      const response = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, {
        ...nativeRequest(input), model,
        client_metadata: { "x-codex-turn-metadata": {
          request_kind: "turn", thread_id: "thread-1", turn_id: current,
        } },
      });
      const output = await response.text();
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 200) expect(output).toContain(`done:${current}`);
      return output;
    };
    try {
      await run("turn-1", "native-model-a", history);
      history.push(message("assistant", "done:turn-1"), message("user", "Inspect the next file."));
      await run("turn-2", "native-model-a", history);
      expect(observations[1]!.mode).toBe("retained-delta");
      expect(provider.surfaceLeaseIds[1]).toBe(provider.surfaceLeaseIds[0]);

      history.push(message("assistant", "done:turn-2"), message("user", "Change model, preserve prior findings."));
      await run("turn-3", "native-model-b", history);
      expect(observations[2]!.mode).toBe("full");
      expect(observations[2]!.epoch).not.toBe(observations[1]!.epoch);
      expect(observations[2]!.segments.join("\n")).toContain("Inspect the next file.");
      expect(provider.surfaceLeaseIds[2]).not.toBe(provider.surfaceLeaseIds[1]);

      history.push(message("assistant", "done:turn-3"), message("user", "Continue in model B."));
      await run("turn-4", "native-model-b", history);
      expect(observations[3]!.mode).toBe("retained-delta");
      expect(provider.surfaceLeaseIds[3]).toBe(provider.surfaceLeaseIds[2]);

      const compacted = [
        { type: "context_compaction" },
        message("user", "Verified Native readable compaction summary: both files inspected."),
        message("user", "Continue the compacted task."),
      ];
      await run("turn-5", "native-model-b", compacted);
      expect(observations[4]!.mode).toBe("full");
      expect(observations[4]!.epoch).not.toBe(observations[3]!.epoch);
      expect(observations[4]!.segments.join("\n")).toContain("Verified Native readable compaction summary");
      expect(observations[4]!.segments.join("\n")).not.toContain("Read the source repository.");

      const failedInput = [...compacted, message("assistant", "done:turn-5"),
        message("user", "Check the next file but do not commit on Web error.")];
      await run("turn-6", "native-model-b", failedInput, 400);
      expect(observations[5]!.mode).toBe("retained-delta");

      await run("turn-7", "native-model-b", [...failedInput,
        message("user", "Recover by rebuilding canonical Native history.")]);
      expect(observations[6]!.mode).toBe("full");
      expect(observations[6]!.segments.join("\n")).toContain("Check the next file");
      expect(observations[6]!.segments.join("\n")).toContain("Recover by rebuilding");
      expect(provider.surfaceLeaseIds[6]).not.toBe(provider.surfaceLeaseIds[5]);
      expect(browserCreated).toBe(4);
      expect(browserClosed).toBe(3);
    } finally {
      await runtime.stop();
    }
    expect(browserClosed).toBe(browserCreated);
  });

  test("owns one Native HTTP -> browser -> MCP -> Native result -> Web final lifecycle", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "chatgpt-tela-dev-runtime-test", version: "0.0.0" }, { capabilities: {} });
    const browserEvents: string[] = [];
    const browserHost = new ControlledBrowserHost(async () => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() { browserEvents.push("surface-close"); },
    }));
    const provider = new ConnectorRoundProvider(client);
    const runtime = await startDevelopmentRuntime({
      currentTurnSource: source,
      browserHost,
      mcp: { kind: "transport", transport: serverTransport },
      provider,
      planWebTurn(turn) {
        return {
          nativeTaskId: turn.channel.binding.authority.threadId,
          legacyNativeToolBridge: true,
          webEpochId: "epoch-1",
          physicalContext: {
            headRevisionId: "revision-1",
            mode: "full",
            logicalTokens: 1,
            transferTokens: 1,
            segments: [{
              type: "revision",
              revisionId: "revision-1",
              kind: "user",
              content: "do the work",
            }],
          },
        };
      },
    });

    try {
      await client.connect(clientTransport);

      const first = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, nativeRequest());
      expect(first.status).toBe(200);
      const firstText = await first.text();
      expect(firstText).toContain('"call_id":"call-1"');
      expect(firstText).toContain('"name":"exec_command"');

      const second = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, nativeRequest([
        { type: "function_call_output", call_id: "call-1", output: "ok" },
      ]));
      expect(second.status).toBe(200);
      const secondText = await second.text();
      expect(secondText).toContain('"delta":"web-final"');
      expect(runtime.turns.size).toBe(1);
      // A successful task epoch remains physically retained for a later Native turn.
      expect(browserEvents).toEqual([]);
    } finally {
      await runtime.stop();
      await client.close();
    }
    expect(browserEvents).toEqual(["surface-close"]);
  });

  test("can run the same exact-turn lifecycle through the stable Codex bridge contract", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "chatgpt-tela-stable-runtime-test", version: "1.0.0" }, { capabilities: {} });
    const browserHost = new ControlledBrowserHost(async () => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() {},
    }));
    const provider = new ConnectorRoundProvider(client, CHATGPT_TELA_CODEX_TOOL_CALL, "stable");
    const runtime = await startDevelopmentRuntime({
      currentTurnSource: source,
      browserHost,
      mcp: { kind: "transport", abi: "stable", transport: serverTransport },
      provider,
      planWebTurn(turn) {
        return {
          nativeTaskId: turn.channel.binding.authority.threadId,
          legacyNativeToolBridge: true,
          webEpochId: "epoch-stable",
          physicalContext: {
            headRevisionId: "revision-stable",
            mode: "full",
            logicalTokens: 1,
            transferTokens: 1,
            segments: [{
              type: "revision",
              revisionId: "revision-stable",
              kind: "user",
              content: "do the work through the stable bridge",
            }],
          },
        };
      },
    });

    try {
      expect(runtime.mcp.abi).toBe("stable");
      await client.connect(clientTransport);
      const first = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, nativeRequest());
      expect(first.status).toBe(200);
      const second = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, nativeRequest([
        { type: "function_call_output", call_id: "call-1", output: "ok" },
      ]));
      expect(second.status).toBe(200);
      expect(await second.text()).toContain('"delta":"web-final"');
    } finally {
      await runtime.stop();
      await client.close();
    }
  });

  test("external stable connector projects the stable Web contract without starting a local public MCP server", async () => {
    const browserHost = new ControlledBrowserHost(async () => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() {},
    }));
    const provider = new ExternalContractProvider();
    const runtime = await startDevelopmentRuntime({
      currentTurnSource: source,
      browserHost,
      mcp: { kind: "external", abi: "stable" },
      provider,
      planWebTurn(turn) {
        return {
          nativeTaskId: turn.channel.binding.authority.threadId,
          legacyNativeToolBridge: true,
          webEpochId: "epoch-stable-external",
          physicalContext: {
            headRevisionId: "revision-stable-external",
            mode: "full",
            logicalTokens: 1,
            transferTokens: 1,
            segments: [{
              type: "revision",
              revisionId: "revision-stable-external",
              kind: "user",
              content: "do the work through the external stable connector",
            }],
          },
        };
      },
    });
    try {
      expect(runtime.mcp).toMatchObject({ kind: "external", abi: "stable" });
      const response = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, nativeRequest());
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"delta":"external-v2-final"');
      expect(provider.observedContract).toBe("stable");
    } finally {
      await runtime.stop();
    }
  });

  test("stop is idempotent and closes the owned browser host", async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const browserHost = new ControlledBrowserHost(async () => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() {},
    }));
    const runtime = await startDevelopmentRuntime({
      currentTurnSource: source,
      browserHost,
      mcp: { kind: "transport", transport: serverTransport },
      planWebTurn: turn => ({
        nativeTaskId: turn.channel.binding.authority.threadId,
        webEpochId: "epoch-1",
        physicalContext: {
          headRevisionId: "revision-1",
          mode: "full",
          logicalTokens: 1,
          transferTokens: 1,
          segments: [{
            type: "revision",
            revisionId: "revision-1",
            kind: "user",
            content: "work",
          }],
        },
      }),
    });
    await runtime.stop();
    await runtime.stop();

    expect(runtime.turns.size).toBe(0);
    await expect(browserHost.acquire({ taskId: "after-stop", epochId: "epoch" }))
      .rejects.toThrow("browser host is closed");
  });

  test("optional Web turn deadline fails a hanging development turn closed", async () => {
    const diagnosticDirectory = mkdtempSync(join(tmpdir(), "tela-web-timeout-proof-"));
    const diagnosticFile = join(diagnosticDirectory, "events.jsonl");
    const previousDiagnosticFile = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = diagnosticFile;
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const browserHost = new ControlledBrowserHost(async () => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() {},
    }));
    const runtime = await startDevelopmentRuntime({
      currentTurnSource: source,
      browserHost,
      mcp: { kind: "transport", transport: serverTransport },
      provider: new HangingProvider(),
      webTurnTimeoutMs: 25,
      planWebTurn: turn => ({
        nativeTaskId: turn.channel.binding.authority.threadId,
        webEpochId: "epoch-timeout",
        physicalContext: {
          headRevisionId: "revision-timeout",
          mode: "full",
          logicalTokens: 1,
          transferTokens: 1,
          segments: [{
            type: "revision",
            revisionId: "revision-timeout",
            kind: "user",
            content: "hang until the development deadline",
          }],
        },
      }),
    });

    try {
      const response = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, nativeRequest());
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("development Web turn timed out after 25ms");
      const events = readFileSync(diagnosticFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const timeout = events.find(event => event.stage === "web_turn_timeout");
      const failure = events.find(event => event.stage === "web_turn_failed");
      expect(timeout).toMatchObject({ deadline_ms: 25, tool_round_count: 0, tool_pending: false });
      expect(timeout.operation_fingerprint).toMatch(/^[a-f0-9]{24}$/);
      expect(failure.operation_fingerprint).toBe(timeout.operation_fingerprint);
      expect(readFileSync(diagnosticFile, "utf8")).not.toContain("hang until the development deadline");
    } finally {
      await runtime.stop();
      if (previousDiagnosticFile === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previousDiagnosticFile;
      rmSync(diagnosticDirectory, { recursive: true, force: true });
    }
  });

  test("development Web turn deadline rejects invalid values before startup", async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const browserHost = new ControlledBrowserHost(async () => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() {},
    }));
    await expect(startDevelopmentRuntime({
      currentTurnSource: source,
      browserHost,
      mcp: { kind: "transport", transport: serverTransport },
      webTurnTimeoutMs: 0,
      planWebTurn: turn => ({
        nativeTaskId: turn.channel.binding.authority.threadId,
        webEpochId: "epoch-invalid-timeout",
        physicalContext: {
          headRevisionId: "revision-invalid-timeout",
          mode: "full",
          logicalTokens: 1,
          transferTokens: 1,
          segments: [],
        },
      }),
    })).rejects.toThrow("positive safe integer");
  });

  test("HTTP exposure mode owns local MCP HTTP plus an existing authenticated public route", async () => {
    const browserHost = new ControlledBrowserHost(async () => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() {},
    }));
    const token = "t".repeat(48);
    const runtime = await startDevelopmentRuntime({
      currentTurnSource: source,
      browserHost,
      mcp: {
        kind: "http-exposure",
        local: { authentication: { kind: "bearer", token } },
        exposure: () => new ExistingHttpsExposure({
          url: "https://chatgpt-tela.example.ts.net/mcp",
          authentication: { kind: "bearer", secretReference: "fixture:chatgpt-tela" },
          probe: async () => ({ ready: true }),
        }),
      },
      planWebTurn: turn => ({
        nativeTaskId: turn.channel.binding.authority.threadId,
        webEpochId: "epoch-1",
        physicalContext: {
          headRevisionId: "revision-1",
          mode: "full",
          logicalTokens: 1,
          transferTokens: 1,
          segments: [{
            type: "revision",
            revisionId: "revision-1",
            kind: "user",
            content: "work",
          }],
        },
      }),
    });

    try {
      expect(runtime.mcp.kind).toBe("http-exposure");
      if (runtime.mcp.kind !== "http-exposure") throw new Error("expected HTTP exposure runtime");
      if (runtime.mcp.exposure.publicEndpoint.kind !== "https") throw new Error("expected HTTPS endpoint");
      expect(runtime.mcp.exposure.publicEndpoint.url.href).toBe("https://chatgpt-tela.example.ts.net/mcp");

      const transport = new StreamableHTTPClientTransport(runtime.mcp.exposure.local.endpointUrl, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: "chatgpt-tela-runtime-http-test", version: "0.0.0" }, { capabilities: {} });
      try {
        await client.connect(transport as unknown as Transport);
        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name).sort()).toEqual([
          "chatgpt_tela_dev_tool_call",
          "chatgpt_tela_dev_tool_inventory",
        ]);
      } finally {
        await client.close().catch(() => {});
      }
    } finally {
      await runtime.stop();
    }
  });

  test("HTTP exposure mode can serve the stable private Codex bridge contract", async () => {
    const browserHost = new ControlledBrowserHost(async () => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() {},
    }));
    const token = "v".repeat(48);
    const runtime = await startDevelopmentRuntime({
      currentTurnSource: source,
      browserHost,
      mcp: {
        kind: "http-exposure",
        abi: "stable",
        local: { authentication: { kind: "bearer", token } },
        exposure: () => new ExistingHttpsExposure({
          url: "https://chatgpt-tela.example.ts.net/stable",
          authentication: { kind: "bearer", secretReference: "fixture:chatgpt-tela-stable-bridge" },
          probe: async () => ({ ready: true }),
        }),
      },
      planWebTurn: turn => ({
        nativeTaskId: turn.channel.binding.authority.threadId,
        webEpochId: "epoch-stable-http",
        physicalContext: {
          headRevisionId: "revision-stable-http",
          mode: "full",
          logicalTokens: 1,
          transferTokens: 1,
          segments: [],
        },
      }),
    });

    try {
      expect(runtime.mcp.kind).toBe("http-exposure");
      expect(runtime.mcp.abi).toBe("stable");
      if (runtime.mcp.kind !== "http-exposure") throw new Error("expected HTTP exposure runtime");
      const transport = new StreamableHTTPClientTransport(runtime.mcp.exposure.local.endpointUrl, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: "chatgpt-tela-stable-runtime-http-test", version: "1.0.0" }, { capabilities: {} });
      try {
        await client.connect(transport as unknown as Transport);
        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name).sort()).toEqual([
          CHATGPT_TELA_CODEX_TOOL_CALL,
          CHATGPT_TELA_CODEX_TOOL_INVENTORY,
        ]);
      } finally {
        await client.close().catch(() => {});
      }
    } finally {
      await runtime.stop();
    }
  });
});

test("HTTP disconnect preserves Web work; exact Native termination retires its accepted surface", async () => {
  const nativeController = new AbortController();
  const disconnected = new AbortController();
  let observeSignal: AbortSignal | undefined;
  let entered!: () => void;
  const accepted = new Promise<void>(resolve => { entered = resolve; });
  let closedWatch!: () => void;
  const watchClosed = new Promise<void>(resolve => { closedWatch = resolve; });
  let surfaceClosed = 0;
  let submissions = 0;
  let failedSettlement = false;
  const provider = new HangingProvider();
  const submit = provider.submitTurn.bind(provider);
  provider.submitTurn = async (surface, request) => { submissions++; return submit(surface, request); };
  const wait = provider.waitForTurnEvent.bind(provider);
  provider.waitForTurnEvent = async (surface, handle, signal) => {
    observeSignal = signal; entered(); return wait(surface, handle, signal);
  };
  const runtime = await startDevelopmentRuntime({
    currentTurnSource: { ...source, async watchTurn(threadId, turnId) {
      expect(threadId).toBe("thread-1"); expect(turnId).toBe("turn-1");
      return { signal: nativeController.signal, async close() { closedWatch(); } };
    } },
    browserHost: new ControlledBrowserHost(async () => ({
      async navigate() {}, async reveal() {}, async hide() {}, async close() { surfaceClosed++; },
    })),
    provider, mcp: {kind: "external", abi: "stable"},
    planWebTurn: turn => ({
      nativeTaskId: turn.channel.binding.authority.threadId, webEpochId: "epoch-1",
      physicalContext: {headRevisionId:"r",activeRequestRevisionId:"r",mode:"full",logicalTokens:1,transferTokens:1,segments:[{type:"revision",revisionId:"r",kind:"user",content:"fixture"}]},
      settle(outcome) { failedSettlement = outcome.status === "failed"; },
    }),
  });
  try {
    const response = fetch(new URL("responses", runtime.responses.baseUrl), {
      method:"POST", headers:{authorization:`Bearer ${runtime.responses.runtimeToken}`,"content-type":"application/json"},
      body:JSON.stringify(nativeRequest()),signal:disconnected.signal,
    });
    response.catch(() => {});
    await accepted;
    disconnected.abort(); await response.catch(() => {});
    expect(observeSignal?.aborted).toBe(false);
    nativeController.abort(new Error("Native interrupted fixture"));
    await watchClosed;
    expect(observeSignal?.aborted).toBe(true);
    expect(submissions).toBe(1);
    expect(surfaceClosed).toBe(1);
    expect(failedSettlement).toBe(true);
    expect(runtime.turns.active("thread-1", "turn-1")).toBeUndefined();
  } finally { await runtime.stop(); }
});

test.each(['native_watch','context_plan'] as const)('preparation failure at %s is recorded without browser work or replay',async phase=>{
  const root=mkdtempSync(join(tmpdir(),'tela-preparation-diagnostic-'));
  const file=join(root,'events.jsonl'),previous=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
  setPrivateDiagnosticCapture(join(root,'diagnostics'),'until-disabled');
  let browserCreations=0,watchCloses=0,plannerCalls=0;
  const error=new Error(phase==='context_plan'?'Native compaction history includes unsupported user content':'private lifecycle exception');
  const runtime=await startDevelopmentRuntime({
    currentTurnSource:{...source,async watchTurn(){if(phase==='native_watch')throw error;return {signal:new AbortController().signal,async close(){watchCloses++;}};}},
    browserHost:new ControlledBrowserHost(async()=>{browserCreations++;throw Error('Browser must not be acquired');}),
    mcp:{kind:'external',abi:'stable'},
    planWebTurn(){plannerCalls++;throw error;},
  });
  try {
    const request=nativeRequest([{role:'user',content:'synthetic private request'}]);
    const response=await post(runtime.responses.baseUrl,runtime.responses.runtimeToken,request);
    expect(response.status).toBe(400);expect(await response.text()).toContain(error.message);
    const replay=await post(runtime.responses.baseUrl,runtime.responses.runtimeToken,request);
    expect(replay.status).toBe(400);expect(await replay.text()).toContain('already retired');
    const raw=readFileSync(file,'utf8');const events=raw.trim().split('\n').map(line=>JSON.parse(line));
    const preparation=events.filter(event=>event.stage==='web_preparation_failed');
    expect(preparation).toHaveLength(1);
    expect(structuralDiagnosticEvent(preparation[0])).toMatchObject({phase,reason_class:phase==='context_plan'?'history_user_format_unsupported':'unclassified',tool_round_count:0});
    expect(preparation[0].scope_fingerprint).toMatch(/^[a-f0-9]{24}$/);
    expect(raw).not.toContain(error.message);expect(raw).not.toContain('synthetic private request');
    expect(browserCreations).toBe(0);expect(plannerCalls).toBe(phase==='context_plan'?1:0);expect(watchCloses).toBe(phase==='context_plan'?1:0);
    const captures=readdirSync(join(root,'diagnostics','private')).filter(name=>name.endsWith('.json')&&!name.endsWith('.meta.json'));
    expect(captures).toHaveLength(1);
    expect(readFileSync(join(root,'diagnostics','private',captures[0]!),'utf8')).toContain('web_preparation_failure');
  }finally{
    await runtime.stop();await new Promise<void>(resolve=>setImmediate(resolve));
    if(previous===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=previous;
    rmSync(root,{recursive:true,force:true});
  }
});
test.each([
  { stage: "native_continuity" as const, substage: undefined },
  { stage: "checkpoint_lookup" as const, substage: "working_checkpoint_journal_publish" as const },
])("context planner failure retains verified stage and journal publication substage ($stage)", async ({stage,substage}) => {
  const root=mkdtempSync(join(tmpdir(),"tela-planner-substage-"));
  const file=join(root,"events.jsonl"), previous=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
  const primary=new Error("private source-specific failure");
  const runtime=await startDevelopmentRuntime({
    currentTurnSource:source,
    browserHost:new ControlledBrowserHost(async()=>{ throw Error("browser must not start"); }),
    mcp:{kind:"external",abi:"stable"},
    planWebTurn(_turn,_request,preparation) {
      preparation?.onPlannerStage?.(stage);
      if (substage) preparation?.onPlannerSubstage?.(substage);
      throw primary;
    },
  });
  try {
    const response=await post(runtime.responses.baseUrl,runtime.responses.runtimeToken,nativeRequest());
    expect(response.status).toBe(400);
    const rows=readFileSync(file,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    const failure=rows.find(row=>row.stage==="web_preparation_failed");
    expect(structuralDiagnosticEvent(failure)).toMatchObject({
      phase:"context_plan",planner_stage:stage,reason_class:"unclassified",error_kind:"error",
      ...(substage ? { planner_substage:substage } : {}),
    });
    expect(readFileSync(file,"utf8")).not.toContain(primary.message);
  } finally {
    await runtime.stop();
    if(previous===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=previous;
    rmSync(root,{recursive:true,force:true});
  }
});

test("preparation streams presentation and follows Native owner cancellation before browser execution", async () => {
  const owner = new AbortController();
  let signal: AbortSignal | undefined, acquisitions = 0;
  let closeWatch!: () => void;
  const closed = new Promise<void>(resolve => { closeWatch = resolve; });
  const runtime = await startDevelopmentRuntime({
    currentTurnSource: { ...source, async watchTurn() { return { signal: owner.signal, async close() { closeWatch(); } }; } },
    browserHost: new ControlledBrowserHost(async () => {
      acquisitions++;
      return { async navigate() {}, async reveal() {}, async hide() {}, async close() {} };
    }),
    provider: new HangingProvider(), mcp: { kind: "external", abi: "stable" },
    async planWebTurn(_turn, _body, preparation) {
      if (!preparation) throw Error("missing preparation contract");
      signal = preparation.signal;
      preparation.onProgress("Preparing prior conversation context.");
      await new Promise<never>((_resolve, reject) => {
        preparation.signal.addEventListener("abort", () => reject(preparation.signal.reason), { once: true });
      });
      throw Error("unreachable");
    },
  });
  try {
    const response = await fetch(new URL("responses", runtime.responses.baseUrl), {
      method: "POST", headers: { authorization: `Bearer ${runtime.responses.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify(nativeRequest()),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder(); let text = "";
    while (!text.includes("response.reasoning_summary_text.delta")) text += decoder.decode((await reader.read()).value);
    expect(text).toContain("Preparing prior conversation context.");
    expect(signal?.aborted).toBe(false);
    owner.abort(new Error("Native owner stopped during preparation"));
    await closed;
    expect(signal?.aborted).toBe(true);
    expect(acquisitions).toBe(0);
    expect(runtime.turns.active("thread-1", "turn-1")).toBeUndefined();
    await reader.cancel();
  } finally { await runtime.stop(); }
});

test("Native cancellation immediately after context planning releases its pending transaction for a later original turn", async () => {
  const firstOwner = new AbortController();
  let currentTurnId = "turn-1";
  let planned = 0;
  let browserAcquisitions = 0;
  const actualPlanner = createNativeRequestDevelopmentWebTurnPlanner();
  const runtime = await startDevelopmentRuntime({
    currentTurnSource: {
      ...source,
      async currentTurn(threadId) {
        return { ...(await source.currentTurn(threadId))!, turnId: currentTurnId,
          environmentSourceTurnId: currentTurnId };
      },
      async watchTurn(_threadId, turnId) {
        return { signal: turnId === "turn-1" ? firstOwner.signal : new AbortController().signal,
          async close() {} };
      },
    },
    browserHost: new ControlledBrowserHost(async () => {
      browserAcquisitions += 1;
      return { async navigate() {}, async reveal() {}, async hide() {}, async close() {} };
    }),
    mcp: { kind: "external", abi: "stable" },
    provider: new ExternalContractProvider(),
    async planWebTurn(turn, request, preparation) {
      const result = await actualPlanner(turn, request, preparation);
      planned += 1;
      if (planned === 1) firstOwner.abort(new Error("original Native turn retired after planning"));
      return { ...result, legacyNativeToolBridge: true };
    },
  });
  const request = () => ({
    ...nativeRequest([{ type: "message", role: "user", content: "Same canonical task." }]),
    client_metadata: { "x-codex-turn-metadata": {
      request_kind: "turn", thread_id: "thread-1", turn_id: currentTurnId,
    } },
  });
  try {
    const first = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, request());
    expect(first.status).toBe(400);
    expect(await first.text()).toContain("original Native turn retired after planning");
    expect(browserAcquisitions).toBe(0);
    expect(runtime.turns.active("thread-1", "turn-1")).toBeUndefined();

    currentTurnId = "turn-2";
    const next = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, request());
    expect(next.status).toBe(200);
    expect(await next.text()).toContain("external-v2-final");
    expect(planned).toBe(2);
    expect(browserAcquisitions).toBe(1);
  } finally { await runtime.stop(); }
});

test("same Native turn continuation runs two settled Web cycles through the real planner and retained browser owner", async () => {
  const diagnosticDirectory = mkdtempSync(join(tmpdir(), "tela-context-link-proof-"));
  const diagnosticFile = join(diagnosticDirectory, "events.jsonl");
  const previousDiagnosticFile = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = diagnosticFile;
  const owner = new AbortController();
  const provider = new ExternalContractProvider();
  const submitted: WebTurnRequest[] = [];
  const originalSubmit = provider.submitTurn.bind(provider);
  provider.submitTurn = async (surface, request) => { submitted.push(request); return originalSubmit(surface, request); };
  let acquisitions = 0;
  const retainedPlanner = createNativeRequestDevelopmentWebTurnPlanner();
  const runtime = await startDevelopmentRuntime({
    currentTurnSource: { ...source, async watchTurn() { return { signal: owner.signal, async close() {} }; } },
    browserHost: new ControlledBrowserHost(async () => {
      acquisitions++;
      return { async navigate() {}, async reveal() {}, async hide() {}, async close() {},
        capability(capability) { return capability === BROWSER_DOCUMENT_LIFETIME ? { current: () => ({ generation: 1, signal: new AbortController().signal }) } as never : undefined; } };
    }), provider, mcp: { kind: "external", abi: "stable" },
    async planWebTurn(turn, request, preparation) {
      return { ...await retainedPlanner(turn, request, preparation), legacyNativeToolBridge: true };
    },
  });
  try {
    const first = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, nativeRequest([{ role: "user", content: "initial" }]));
    expect(first.status).toBe(200); expect(await first.text()).toContain("external-v2-final");
    const secondBody = nativeRequest([{ role: "user", content: "initial" }, { role: "assistant", content: "external-v2-final" }, { role: "user", content: "followup" }]);
    const second = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, secondBody);
    expect(second.status).toBe(200); expect(await second.text()).toContain("external-v2-final");
    expect(submitted).toHaveLength(2); expect(acquisitions).toBe(1);
    expect(submitted[1]!.nativeTurnId).toBe(submitted[0]!.nativeTurnId);
    expect(submitted[1]!.toolBridge?.turnCapability).not.toBe(submitted[0]!.toolBridge?.turnCapability);
    expect(submitted[1]!.physicalContext.mode).toBe("retained-delta");
    expect(JSON.stringify(submitted[1]!.physicalContext)).toContain("followup");
    const rows = readFileSync(diagnosticFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const plans = rows.filter(row => row.stage === "web_turn_plan");
    const settled = rows.filter(row => row.stage === "web_context_settled");
    expect(plans).toHaveLength(2); expect(settled).toHaveLength(2);
    expect(plans[1]).toMatchObject({ context_mode: "retained-delta", document_generation: 1,
      retained_input_head_fingerprint: settled[0].head_revision_fingerprint,
      surface_fingerprint: settled[0].surface_fingerprint, epoch_fingerprint: settled[0].epoch_fingerprint });
    expect(plans[0].head_revision_fingerprint).toMatch(/^[a-f0-9]{24}$/);
    expect(plans[1].active_request_revision_fingerprint).toMatch(/^[a-f0-9]{24}$/);
    expect(plans[1].active_request_kind).toBe("user");
    expect(plans[1].active_request_inline).toBe(true);
    expect(rows.some(row => row.stage === "native_response_observer_started")).toBe(true);
    expect(rows.filter(row => row.stage === "native_outcome_committed" && row.outcome === "final")).toHaveLength(2);
    const duplicate = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken, secondBody);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: { code: "tela_native_response_cycle_conflict", retryable: false } });
    expect(submitted).toHaveLength(2);
    owner.abort(new Error("Native completed")); expect(runtime.turns.size).toBe(0);
  } finally {
    await runtime.stop();
    if (previousDiagnosticFile === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previousDiagnosticFile;
    rmSync(diagnosticDirectory, { recursive: true, force: true });
  }
});


for (const deferred of [true, false]) test(`runtime keeps owner-bound original history readable for ${deferred ? "deferred seeds" : "compacted checkpoint continuations"}`, async () => {
  const { McpTurnBridge } = await import('@chatgpt-tela/mcp');
  const { CONTEXT_HISTORY_TOOL } = await import('@chatgpt-tela/core');
  const host = new ControlledBrowserHost(async () => ({
    async navigate() {}, async reveal() {}, async hide() {}, async close() {}, capability() { return undefined; },
  }));
  const provider = new RetainedFinalProvider();
  let historyControl = '', bodyReads = 0, readBytes = 0;
  const submit = provider.submitTurn.bind(provider), finish = provider.waitForTurnEvent.bind(provider);
  provider.submitTurn = async (surface, request) => {
    historyControl = request.chatTools?.nativeHistoryControl ?? '';
    expect(historyControl).not.toBe(''); expect(request.toolBridge).toBeUndefined();
    return submit(surface, request);
  };
  let runtime!: Awaited<ReturnType<typeof startDevelopmentRuntime>>;
  provider.waitForTurnEvent = async (surface, turn) => {
    const bridge = new McpTurnBridge(runtime.turns);
    const result = await bridge.invoke(historyControl, { callId: 'original-read', wireName: CONTEXT_HISTORY_TOOL.wireName,
      mode: 'structured', arguments: { turn_id: 'past' } });
    expect(JSON.parse(result.content as string).text).toContain('original answer');
    readBytes = runtime.turns.active('thread-1', 'turn-1')!.channel.releasedToolResultBytes;
    expect(readBytes).toBeGreaterThan(0);
    expect(runtime.turns.active('thread-1', 'turn-1')!.channel.toolRoundCount).toBe(0);
    return finish(surface, turn);
  };
  runtime = await startDevelopmentRuntime({ browserHost: host, provider, mcp: { kind: 'external', abi: 'stable' },
    currentTurnSource: { ...source, async readHistoryPage(owner, selection) {
      bodyReads++; expect(owner.threadId).toBe('thread-1'); expect(selection.turnId).toBe('past');
      return { data: [{ turnId: 'past', item: { type: 'agentMessage', id: 'old', text: 'original answer' } }], nextCursor: null };
    }, async readHistoryIndex() { return { data: [{ turnId: 'past', status: 'completed' }], nextCursor: null }; } },
    planWebTurn() { return { nativeTaskId: 'thread-1', webEpochId: 'scope-epoch', physicalContext: {
      mode: deferred ? 'full' : 'checkpoint-delta', headRevisionId: 'current', activeRequestRevisionId: 'current', logicalTokens: 100, transferTokens: 100,
      segments: [
        ...(!deferred ? [{ type: 'checkpoint' as const, checkpointId: 'summary', sourceRevisionId: 'past', content: 'Maintained summary' }] : []),
        { type: 'revision', revisionId: 'current', kind: 'user', content: 'Current request' },
      ],
      ...(deferred ? { deferredHistory: { scope: 'prior-native-history' as const } } : {}),
    } }; },
  });
  try {
    const response = await post(runtime.responses.baseUrl, runtime.responses.runtimeToken,
      nativeRequest([{ role: 'user', content: 'Current request' }]));
    expect(await response.text()).toContain('done:turn-1');
    expect(bodyReads).toBe(1); expect(readBytes).toBeGreaterThan(0);
    await expect(runtime.turns.readHistoryPage(historyControl, { turnId: 'past' })).rejects.toThrow();
    expect(bodyReads).toBe(1);
  } finally { await runtime.stop(); }
});
