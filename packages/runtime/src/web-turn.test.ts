import { describe, expect, test } from "bun:test";
import type { BrowserHost, BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import type {
  ChatGptContextAttachment,
  SemanticObservation,
  WebConversationProvider,
  WebTurnEvent,
  WebTurnHandle,
} from "@chatgpt-tela/chatgpt";
import { createChatGptContextAttachment } from "@chatgpt-tela/chatgpt";
import {
  NativeToolInventory,
  defineNativeTurnAuthority,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import { RuntimeTurnChannel } from "./turn-channel";
import { runBrowserTurn } from "./web-turn";

const physicalContext = {
  headRevisionId: "r1",
  mode: "full" as const,
  logicalTokens: 10,
  transferTokens: 10,
  segments: [{
    type: "revision" as const,
    revisionId: "r1",
    kind: "user" as const,
    content: "hello",
  }],
};

function binding(): NativeTurnBinding {
  const tools = [{
    wireName: "exec_command",
    name: "exec_command",
    description: "command",
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

class EventQueue {
  readonly #queued: SemanticObservation<WebTurnEvent>[] = [];
  readonly #waiters: Array<{
    resolve: (event: SemanticObservation<WebTurnEvent>) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  push(event: WebTurnEvent): void {
    const observation: SemanticObservation<WebTurnEvent> = {
      state: "proven",
      value: event,
      evidence: ["fixture"],
    };
    const waiter = this.#waiters.shift();
    if (waiter) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(observation);
    }
    else this.#queued.push(observation);
  }

  next(signal?: AbortSignal): Promise<SemanticObservation<WebTurnEvent>> {
    const queued = this.#queued.shift();
    if (queued) return Promise.resolve(queued);
    if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const waiter: {
        resolve: (event: SemanticObservation<WebTurnEvent>) => void;
        reject: (error: unknown) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new DOMException("aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }
}

function browserHost(released: string[]): BrowserHost {
  const lease: BrowserSurfaceLease = {
    leaseId: "surface-1",
    taskId: "task-1",
    epochId: "epoch-1",
    async navigate() {},
    async reveal() {},
    async hide() {},
    capability() { return undefined; },
  };
  return {
    async acquire() { return lease; },
    async release(leaseId) { released.push(leaseId); },
    async close() {},
  };
}

function provider(events: EventQueue, submitState: "proven" | "probable" = "proven"): WebConversationProvider {
  const handle: WebTurnHandle = {
    nativeTaskId: "task-1",
    nativeTurnId: "turn-1",
    webEpochId: "epoch-1",
    providerTurnId: "web-turn-1",
  };
  return {
    async observeCapabilities() {
      return {
        state: "proven",
        value: { observed: new Set(["composer", "send"]) },
        evidence: ["fixture"],
      };
    },
    async submitTurn() {
      return {
        state: submitState,
        value: handle,
        evidence: ["fixture"],
      } as SemanticObservation<WebTurnHandle>;
    },
    async observeTurn() {
      return {
        state: "proven",
        value: { providerTurnId: handle.providerTurnId, phase: "accepted" as const },
        evidence: ["fixture"],
      };
    },
    async armToolContinuation(_surface, turn, callId) {
      return {
        state: "proven",
        value: { providerTurnId: turn.providerTurnId, callId },
        evidence: ["fixture"],
      };
    },
    async waitForTurnEvent(_surface, _turn, signal) {
      return events.next(signal);
    },
  };
}

describe("browser turn runner", () => {
  test("receipt-proven context preload completes before the real Native execution submit", async () => {
    const events = new EventQueue();
    events.push({ kind: "completed", providerTurnId: "web-turn-1", answer: "done" });
    const order: string[] = [];
    const fixture = provider(events);
    const attachment = createChatGptContextAttachment({
      ...physicalContext,
      activeRequestRevisionId: "r1",
    });
    const wrapped: WebConversationProvider = {
      ...fixture,
      async preloadContextAttachment(_surface, request) {
        order.push("preload");
        return {
          state: "proven",
          value: {
            nativeTaskId: request.nativeTaskId,
            webEpochId: request.webEpochId,
            attachmentName: request.attachment.name,
            attachmentSha256: request.attachment.sha256,
            providerOperationId: "preload-1",
          },
          evidence: ["fixture"],
        };
      },
      async submitTurn(...args) {
        order.push("submit");
        return fixture.submitTurn(...args);
      },
    };
    const result = await runBrowserTurn({
      browserHost: browserHost([]),
      provider: wrapped,
      channel: new RuntimeTurnChannel(binding()),
      nativeTaskId: "task-1",
      webEpochId: "epoch-1",
      physicalContext: { ...physicalContext, activeRequestRevisionId: "r1" },
      contextAttachment: attachment,
    });
    expect(result).toBe("done");
    expect(order).toEqual(["preload", "submit"]);
  });

  test("unproven context preload blocks the real Native execution submit", async () => {
    const events = new EventQueue();
    const order: string[] = [];
    const fixture = provider(events);
    const attachment: ChatGptContextAttachment = createChatGptContextAttachment({
      ...physicalContext,
      activeRequestRevisionId: "r1",
    });
    const wrapped: WebConversationProvider = {
      ...fixture,
      async preloadContextAttachment(_surface, request) {
        order.push("preload");
        return {
          state: "probable",
          value: {
            nativeTaskId: request.nativeTaskId,
            webEpochId: request.webEpochId,
            attachmentName: request.attachment.name,
            attachmentSha256: request.attachment.sha256,
            providerOperationId: "preload-uncertain",
          },
          evidence: ["receipt mismatch"],
        };
      },
      async submitTurn(...args) {
        order.push("submit");
        return fixture.submitTurn(...args);
      },
    };
    const channel = new RuntimeTurnChannel(binding());
    await expect(runBrowserTurn({
      browserHost: browserHost([]),
      provider: wrapped,
      channel,
      nativeTaskId: "task-1",
      webEpochId: "epoch-1",
      physicalContext: { ...physicalContext, activeRequestRevisionId: "r1" },
      contextAttachment: attachment,
    })).rejects.toThrow("requires proven state");
    expect(order).toEqual(["preload"]);
    expect(channel.phase).toBe("prepared");
  });

  test("integrates a tool round, proven continuation, final response, and surface release", async () => {
    const events = new EventQueue();
    const released: string[] = [];
    const channel = new RuntimeTurnChannel(binding());
    const run = runBrowserTurn({
      browserHost: browserHost(released),
      provider: provider(events),
      channel,
      nativeTaskId: "task-1",
      webEpochId: "epoch-1",
      physicalContext,
    });

    while (channel.phase !== "accepted") await Promise.resolve();
    const waitingWeb = channel.requestTool({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: { cmd: ["printf", "ok"] },
    });
    expect((await channel.nextNativeTool()).callId).toBe("call-1");
    channel.deliverNativeToolResult({ callId: "call-1", content: "ok", isError: false });
    await waitingWeb;

    events.push({ kind: "continuing", providerTurnId: "web-turn-1" });
    events.push({ kind: "completed", providerTurnId: "web-turn-1", answer: "done" });

    expect(await run).toBe("done");
    expect(await channel.waitForFinal()).toBe("done");
    expect(String(channel.phase)).toBe("completed");
    expect(released).toEqual(["surface-1"]);
  });

  test("ambiguous submission is never converted into permission to resubmit", async () => {
    const events = new EventQueue();
    const released: string[] = [];
    const channel = new RuntimeTurnChannel(binding());

    await expect(runBrowserTurn({
      browserHost: browserHost(released),
      provider: provider(events, "probable"),
      channel,
      nativeTaskId: "task-1",
      webEpochId: "epoch-1",
      physicalContext,
    })).rejects.toThrow("requires proven state");

    expect(channel.phase).toBe("submitted");
    expect(() => channel.markSubmitted()).toThrow("invalid turn transition");
    expect(released).toEqual(["surface-1"]);
  });

  test("surface preparation completes before the consequential submit boundary", async () => {
    const events = new EventQueue();
    const channel = new RuntimeTurnChannel(binding());
    const order: string[] = [];
    const fixture = provider(events);
    const wrapped: WebConversationProvider = {
      ...fixture,
      async submitTurn(...args) {
        order.push("submit");
        return fixture.submitTurn(...args);
      },
    };
    events.push({ kind: "completed", providerTurnId: "web-turn-1", answer: "done" });
    const result = await runBrowserTurn({
      browserHost: browserHost([]),
      provider: wrapped,
      channel,
      nativeTaskId: "task-1",
      webEpochId: "epoch-1",
      physicalContext,
      prepareForSubmit: async () => { order.push("prepare"); },
    });
    expect(result).toBe("done");
    expect(order).toEqual(["prepare", "submit"]);
  });

  test("exact browser-message char preflight fails before model preparation or submit", async () => {
    const events = new EventQueue();
    const channel = new RuntimeTurnChannel(binding());
    const order: string[] = [];
    const fixture = provider(events);
    const wrapped: WebConversationProvider = {
      ...fixture,
      async submitTurn(...args) {
        order.push("submit");
        return fixture.submitTurn(...args);
      },
    };
    await expect(runBrowserTurn({
      browserHost: browserHost([]),
      provider: wrapped,
      channel,
      nativeTaskId: "task-1",
      webEpochId: "epoch-1",
      physicalContext: {
        ...physicalContext,
        segments: [{
          type: "revision",
          revisionId: "r1",
          kind: "user",
          content: "x".repeat(5_000),
        }],
      },
      physicalLimits: {
        rolloverTokenLimit: 100,
        contextWindowTokenLimit: 200,
        composerCharLimit: 100,
      },
      prepareForSubmit: async () => { order.push("prepare"); },
    })).rejects.toThrow("browser message limit");
    expect(order).toEqual([]);
    expect(channel.phase).toBe("prepared");
  });

  test("completion after a tool result fails closed until Web continuation is observed", async () => {
    const events = new EventQueue();
    const channel = new RuntimeTurnChannel(binding());
    const run = runBrowserTurn({
      browserHost: browserHost([]),
      provider: provider(events),
      channel,
      nativeTaskId: "task-1",
      webEpochId: "epoch-1",
      physicalContext,
    });

    while (channel.phase !== "accepted") await Promise.resolve();
    const waitingWeb = channel.requestTool({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: {},
    });
    channel.deliverNativeToolResult({ callId: "call-1", content: "ok", isError: false });
    await waitingWeb;
    events.push({ kind: "completed", providerTurnId: "web-turn-1", answer: "unproven" });

    await expect(run).rejects.toThrow("continuation is proven");
    expect(String(channel.phase)).toBe("indeterminate-after-acceptance");
  });
});
