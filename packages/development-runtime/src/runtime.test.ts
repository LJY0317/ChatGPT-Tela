import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ControlledBrowserHost } from "@chatgpt-tela/browser-host";
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
      expect(runtime.turns.size).toBe(0);
      expect(browserEvents).toEqual(["surface-close"]);
    } finally {
      await runtime.stop();
      await client.close();
    }
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
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("development Web turn timed out after 25ms");
    } finally {
      await runtime.stop();
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
