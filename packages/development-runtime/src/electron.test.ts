import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrowserWindowConstructorOptions } from "electron";
import type { ElectronBrowserWindowLike } from "@chatgpt-tela/electron-host";
import type {
  SemanticObservation,
  WebConversationProvider,
  WebContextCheckpointProvider,
  WebContextCheckpointRequest,
  WebToolContinuationBoundary,
  WebTurnEvent,
  WebTurnHandle,
  WebTurnRequest,
} from "@chatgpt-tela/chatgpt";
import type { CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import { FileContextCheckpointCache } from "./context-cache";
import { startElectronDevelopmentRuntime } from "./electron";

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

class FakeWindow implements ElectronBrowserWindowLike {
  readonly events: string[] = [];
  destroyed = false;
  readonly webContents = {
    executeJavaScript: async () => 0,
    isDestroyed: () => this.destroyed,
  };

  async loadURL(url: string): Promise<void> { this.events.push(`load:${url}`); }
  show(): void { this.events.push("show"); }
  hide(): void { this.events.push("hide"); }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.events.push("destroy");
  }
}

class FinalProvider implements WebConversationProvider {
  submitted: WebTurnRequest | undefined;

  async observeCapabilities() {
    return {
      state: "proven" as const,
      value: { observed: new Set(["composer", "send"]) },
      evidence: ["fixture"],
    };
  }

  async submitTurn(_surface: unknown, request: WebTurnRequest) {
    this.submitted = request;
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

  async armToolContinuation(
    _surface: unknown,
    turn: WebTurnHandle,
    callId: string,
  ): Promise<SemanticObservation<WebToolContinuationBoundary>> {
    return {
      state: "proven",
      value: { providerTurnId: turn.providerTurnId, callId },
      evidence: ["fixture"],
    };
  }

  async waitForTurnEvent(): Promise<SemanticObservation<WebTurnEvent>> {
    return {
      state: "proven",
      value: { kind: "completed", providerTurnId: "web-turn-1", answer: "desktop-ok" },
      evidence: ["fixture"],
    };
  }
}

function nativeRequest(): Record<string, unknown> {
  return {
    model: "chatgpt-tela-test-model",
    stream: false,
    client_metadata: {
      "x-codex-turn-metadata": {
        request_kind: "turn",
        thread_id: "thread-1",
        turn_id: "turn-1",
      },
    },
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "desktop-native-context" }],
    }],
    tools: [],
  };
}

function compactableNativeRequest(): Record<string, unknown> {
  return {
    ...nativeRequest(),
    instructions: "I".repeat(80),
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "N".repeat(20) }],
    }],
  };
}

class FixtureCheckpointProvider implements WebContextCheckpointProvider {
  readonly requests: WebContextCheckpointRequest[] = [];

  async observeCapabilities() {
    return {
      state: "proven" as const,
      value: { observed: new Set(["composer", "send"]) },
      evidence: ["fixture-checkpoint-capabilities"],
    };
  }

  async createContextCheckpoint(_surface: unknown, request: WebContextCheckpointRequest) {
    this.requests.push(request);
    return {
      state: "proven" as const,
      value: {
        nativeTaskId: request.nativeTaskId,
        webEpochId: request.webEpochId,
        sourceRevisionId: request.sourceRevisionId,
        providerOperationId: "checkpoint-op-1",
        content: "compact instructions",
      },
      evidence: ["fixture-checkpoint-result"],
    };
  }
}

describe("Electron development runtime composition", () => {
  test("discovers Web model families on one disposable non-Native surface", async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const windows: FakeWindow[] = [];
    class RuntimeWindow extends FakeWindow {
      constructor(_input: BrowserWindowConstructorOptions) {
        super();
        windows.push(this);
      }
    }
    let observedTaskId: string | undefined;
    const runtime = await startElectronDevelopmentRuntime({
      profileId: "profile-models",
      currentTurnSource: source,
      mcp: { kind: "transport", transport: serverTransport },
      provider: new FinalProvider(),
      async modelFamilyDiscovery(surface) {
        observedTaskId = surface.taskId;
        return [{ key: "a".repeat(20), label: "Observed Web", availableEfforts: ["medium", "high"] }];
      },
      electron: {
        async loadRuntime() {
          return {
            app: { setPath() {}, async whenReady() {} },
            BrowserWindow: RuntimeWindow,
          };
        },
      },
    });
    try {
      const families = await runtime.discoverChatGptWebModelFamilies();
      expect(families).toEqual([{
        key: "a".repeat(20),
        label: "Observed Web",
        availableEfforts: ["medium", "high"],
      }]);
      expect(observedTaskId).toBe("profile-model-catalog:profile-models");
      expect(windows).toHaveLength(1);
      expect(windows[0]?.destroyed).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  test("one profile boundary creates the persistent Electron host and shared runtime lifecycle", async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const events: string[] = [];
    const windows: FakeWindow[] = [];
    const options: BrowserWindowConstructorOptions[] = [];
    class RuntimeWindow extends FakeWindow {
      constructor(input: BrowserWindowConstructorOptions) {
        super();
        options.push(input);
        windows.push(this);
        events.push("window-created");
      }
    }

    const provider = new FinalProvider();
    const userDataDir = resolve("/tmp/chatgpt-tela-development-runtime-test");
    const runtime = await startElectronDevelopmentRuntime({
      profileId: "profile-1",
      currentTurnSource: source,
      mcp: { kind: "transport", transport: serverTransport },
      provider,
      electron: {
        userDataDir,
        async loadRuntime() {
          return {
            app: {
              setPath(name, path) { events.push(`set-path:${name}:${path}`); },
              async whenReady() { events.push("app-ready"); },
            },
            BrowserWindow: RuntimeWindow,
          };
        },
      },
    });

    try {
      expect(events).toEqual([
        `set-path:userData:${userDataDir}`,
        "app-ready",
      ]);
      const readiness = await runtime.probeChatGptReadiness();
      expect([...readiness.observed].sort()).toEqual(["composer", "send"]);
      expect(windows[0]?.events).toEqual(["load:https://chatgpt.com/", "destroy"]);
      const setup = await runtime.openProfileSetupSurface();
      expect(events).toEqual([
        `set-path:userData:${userDataDir}`,
        "app-ready",
        "window-created",
        "window-created",
      ]);
      expect(windows[1]?.events).toEqual(["load:https://chatgpt.com/", "show"]);
      const response = await fetch(new URL("responses", runtime.responses.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.responses.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(nativeRequest()),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("desktop-ok");
      expect(events).toEqual([
        `set-path:userData:${userDataDir}`,
        "app-ready",
        "window-created",
        "window-created",
        "window-created",
      ]);
      expect(options[0]?.webPreferences?.partition).toMatch(/^persist:chatgpt-tela-/);
      expect(options[1]?.webPreferences?.partition).toBe(options[0]?.webPreferences?.partition);
      expect(options[2]?.webPreferences?.partition).toBe(options[0]?.webPreferences?.partition);
      expect(JSON.stringify(provider.submitted?.physicalContext)).toContain("desktop-native-context");
      await setup.close();
    } finally {
      await runtime.stop();
    }

    expect(windows).toHaveLength(3);
    expect(windows[0]?.events).toEqual(["load:https://chatgpt.com/", "destroy"]);
    expect(windows[1]?.events).toEqual(["load:https://chatgpt.com/", "show", "destroy"]);
    expect(windows[2]?.events).toEqual(["load:https://chatgpt.com/", "destroy"]);
  });

  test("explicit checkpoint provider is isolated from the ordinary turn provider and feeds the derived cache once", async () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-tela-electron-checkpoint-test-"));
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const windows: FakeWindow[] = [];
    class RuntimeWindow extends FakeWindow {
      constructor(_input: BrowserWindowConstructorOptions) {
        super();
        windows.push(this);
      }
    }
    const provider = new FinalProvider();
    const checkpointProvider = new FixtureCheckpointProvider();
    const cache = new FileContextCheckpointCache({ directory: root });
    const runtime = await startElectronDevelopmentRuntime({
      profileId: "profile-checkpoint",
      currentTurnSource: source,
      mcp: { kind: "transport", transport: serverTransport },
      provider,
      checkpointProvider,
      context: { checkpointCache: cache, budgetTokens: 10 },
      electron: {
        async loadRuntime() {
          return {
            app: { setPath() {}, async whenReady() {} },
            BrowserWindow: RuntimeWindow,
          };
        },
      },
    });

    try {
      const response = await fetch(new URL("responses", runtime.responses.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.responses.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(compactableNativeRequest()),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("desktop-ok");
      expect(checkpointProvider.requests).toHaveLength(1);
      expect(checkpointProvider.requests[0]?.physicalContext).toMatchObject({
        mode: "full",
        segments: [{ type: "revision", kind: "system", content: "I".repeat(80) }],
      });
      expect(provider.submitted?.physicalContext.mode).toBe("checkpoint-delta");
      expect(provider.submitted?.toolBridge).toBeDefined();
      expect(await cache.list("thread-1")).toHaveLength(1);
      expect(windows).toHaveLength(2);
      expect(windows[0]?.destroyed).toBe(true); // one-purpose checkpoint surface
      expect(windows[1]?.destroyed).toBe(false); // successful ordinary epoch stays retained
    } finally {
      await runtime.stop();
      expect(windows.every(window => window.destroyed)).toBe(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ordinary turn provider is never reused implicitly as checkpoint authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-tela-electron-no-checkpoint-provider-test-"));
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const provider = new FinalProvider();
    const cache = new FileContextCheckpointCache({ directory: root });
    const runtime = await startElectronDevelopmentRuntime({
      profileId: "profile-no-checkpoint-provider",
      currentTurnSource: source,
      mcp: { kind: "transport", transport: serverTransport },
      provider,
      context: { checkpointCache: cache, budgetTokens: 10 },
      electron: {
        async loadRuntime() {
          return {
            app: { setPath() {}, async whenReady() {} },
            BrowserWindow: FakeWindow as unknown as new (input: BrowserWindowConstructorOptions) => FakeWindow,
          };
        },
      },
    });

    try {
      const response = await fetch(new URL("responses", runtime.responses.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.responses.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(compactableNativeRequest()),
      });
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("requires a checkpoint");
      expect(provider.submitted).toBeUndefined();
      expect(await cache.list("thread-1")).toEqual([]);
    } finally {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
