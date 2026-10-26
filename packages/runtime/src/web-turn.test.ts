import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  WebObservationUnproven,
  NativeToolInventory,
  defineNativeTurnAuthority,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import { RuntimeTurnChannel } from "./turn-channel";
import { runBrowserTurnOnSurface, runBrowserTurn } from "./web-turn";

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
  test("accepted failure preserves original error and releases without a second observation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tela-primary-exception-"));
    const file = join(directory, "events.jsonl");
    const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
    const failure = new Error("private exception /private/file@example.invalid");
    try {
      const fixture = provider(new EventQueue()); const channel = new RuntimeTurnChannel(binding());
      const released: string[] = [];
      let secondaryObservations = 0;
      const wrapped: WebConversationProvider = { ...fixture,
        async waitForTurnEvent() { throw failure; },
        async observeTurn() { secondaryObservations++; throw new Error("redundant observation"); },
      };
      await expect(runBrowserTurn({ browserHost: browserHost(released), provider: wrapped, channel,
        nativeTaskId: "task-1", webEpochId: "epoch-1", physicalContext })).rejects.toBe(failure);
      const text = readFileSync(file, "utf8");
      const events = text.trim().split("\n").map(line => JSON.parse(line));
      const primary = events.findIndex(event => event.stage === "web_execution_exception");
      expect(primary).toBeGreaterThanOrEqual(0);
      expect(events[primary]).toMatchObject({ boundary: "event_wait", accepted: true,
        reason_class: "unclassified", owner_aborted: false, tool_round_count: 0 });
      expect(text).not.toContain(failure.message);
      expect(secondaryObservations).toBe(0);
      expect(released).toEqual(["surface-1"]);
      expect(String(channel.phase)).toBe("indeterminate-after-acceptance");
    } finally {
      if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("a real submission needs no separate preflight readiness mutation", async () => {
    const events = new EventQueue();
    events.push({ kind: "completed", providerTurnId: "web-turn-1", answer: "done" });
    const normal = provider(events);
    const withoutProbe: WebConversationProvider = {
      ...normal,
      async observeCapabilities() { throw new Error("redundant composer probe"); },
    };
    const result = await runBrowserTurn({
      browserHost: browserHost([]), provider: withoutProbe,
      channel: new RuntimeTurnChannel(binding()),
      nativeTaskId: "task-1", webEpochId: "epoch-1", physicalContext,
    });
    expect(result).toBe("done");
  });
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
    })).rejects.toMatchObject({code:"web_context_fit_failed",reason:"composer_window_exceeded"});
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

  test("a final Web event cannot commit after the original Native owner revokes its signal", async () => {
    const owner = new AbortController();
    const events = new EventQueue();
    const channel = new RuntimeTurnChannel(binding());
    const released: string[] = [];
    const run = runBrowserTurn({
      browserHost: browserHost(released),
      provider: provider(events),
      channel,
      nativeTaskId: "task-1",
      webEpochId: "epoch-1",
      physicalContext,
      signal: owner.signal,
    });

    while (channel.phase !== "accepted") await Promise.resolve();
    // A callback from the original Native owner may revoke this turn while
    // a previously queued provider completion settles in the same event loop.
    events.push({ kind: "completed", providerTurnId: "web-turn-1", answer: "stale Web final" });
    owner.abort(new Error("Native live turn ownership was revoked"));
    await expect(run).rejects.toThrow("Native live turn ownership was revoked");
    expect(String(channel.phase)).not.toBe("completed");
    await expect(channel.waitForFinal()).rejects.toThrow();
    expect(released).toEqual(["surface-1"]);
  });

  test.each(["success", "failure", "hung"] as const)("Native cancellation stops the accepted Web turn once before release; stop=%s", async stopMode => {
    const owner = new AbortController();
    const channel = new RuntimeTurnChannel(binding());
    const released: string[] = [];
    const fixture = provider(new EventQueue());
    let stopped = 0, submissions = 0;
    const failure = new Error("Native owner stopped");
    const wrapped: WebConversationProvider = { ...fixture,
      async submitTurn(...args) { submissions++; return fixture.submitTurn(...args); },
      async cancelTurn(surface, handle) {
        stopped++;
        expect(surface.leaseId).toBe("surface-1");
        expect(handle.providerTurnId).toBe("web-turn-1");
        expect(released).toEqual([]);
        expect(String(channel.phase)).toBe("indeterminate-after-acceptance");
        expect(() => channel.complete("late answer")).toThrow();
        if (stopMode === "failure") throw new Error("Web stop unconfirmed");
        if (stopMode === "hung") await new Promise<void>(() => {});
      },
    };
    const run = runBrowserTurn({ browserHost: browserHost(released), provider: wrapped, channel,
      nativeTaskId: "task-1", webEpochId: "epoch-1", physicalContext, signal: owner.signal });
    while (channel.phase !== "accepted") await Promise.resolve();
    owner.abort(failure);
    await expect(run).rejects.toBe(failure);
    expect(stopped).toBe(1);
    expect(submissions).toBe(1);
    expect(released).toEqual(["surface-1"]);
    await expect(channel.waitForFinal()).rejects.toThrow();
  }, 10_000);

  test("Native tool-state wake must not discard an already observed one-shot Web event", async () => {
    const channel = new RuntimeTurnChannel(binding());
    const released: string[] = [];
    const progress: string[] = [];
    channel.subscribeProgress(summary => progress.push(summary));
    const fixture = provider(new EventQueue());
    let waitCalls = 0;
    let firstObservationSettled = false;
    let pendingNativeTool: Promise<unknown> | undefined;
    const observed = (value: WebTurnEvent): SemanticObservation<WebTurnEvent> => ({
      state: "proven", value, evidence: ["single-use renderer event fixture"],
    });
    const wrapped: WebConversationProvider = {
      ...fixture,
      async waitForTurnEvent() {
        waitCalls++;
        if (waitCalls === 1) {
          // The Native channel becomes ready while a real renderer observation
          // is already in flight. Its one-shot result cannot be re-observed.
          pendingNativeTool = channel.requestTool({
            callId: "call-1", wireName: "exec_command",
            mode: "structured", arguments: { cmd: ["synthetic"] },
          });
          queueMicrotask(async () => {
            const tool = await channel.nextNativeTool();
            channel.markNativeToolDelivered(tool.callId);
            channel.deliverNativeToolResult({ callId: tool.callId, content: "synthetic-result", isError: false });
          });
          return await new Promise<SemanticObservation<WebTurnEvent>>(resolve => {
            setTimeout(() => {
              firstObservationSettled = true;
              resolve(observed({ kind: "progress", providerTurnId: "web-turn-1",
                summary: "Web has observed the original Native tool request" }));
            }, 10);
          });
        }
        if (!firstObservationSettled) {
          throw new Error("concurrent provider wait discarded a one-shot Web event");
        }
        if (waitCalls === 2) {
          return observed({ kind: "continuing", providerTurnId: "web-turn-1" });
        }
        if (waitCalls === 3) {
          return observed({ kind: "completed", providerTurnId: "web-turn-1",
            answer: "original Native turn finished" });
        }
        throw new Error("duplicate Web observation after final");
      },
    };

    const result = await runBrowserTurn({
      browserHost: browserHost(released), provider: wrapped, channel,
      nativeTaskId: "task-1", webEpochId: "epoch-1", physicalContext,
    });
    expect(result).toBe("original Native turn finished");
    expect(progress).toContain("Web has observed the original Native tool request");
    expect(await pendingNativeTool).toMatchObject({ callId: "call-1", content: "synthetic-result" });
    expect(waitCalls).toBe(3);
    expect(String(channel.phase)).toBe("completed");
    expect(released).toEqual(["surface-1"]);
  });
});


test("unproven handoff never releases the exact Native result or submits twice",async()=>{
 for(const proof of ["probable","ambiguous"] as const){
  const channel=new RuntimeTurnChannel(binding());const fixture=provider(new EventQueue());let submits=0,released=false;
  const wrapped:WebConversationProvider={...fixture,async submitTurn(...args){submits++;return fixture.submitTurn(...args);},
   async armToolContinuation(_surface,turn,callId){return proof==="probable"
    ?{state:proof,value:{providerTurnId:turn.providerTurnId,callId},evidence:["synthetic terminal assistant"]}
    :{state:proof,candidates:[],evidence:["synthetic ambiguous lineage"]};}};
  const run=runBrowserTurn({browserHost:browserHost([]),provider:wrapped,channel,nativeTaskId:"task-1",webEpochId:"epoch-1",physicalContext});
  void run.catch(()=>{});
  while(channel.phase!=="accepted")await Promise.resolve();
  const waiting=channel.requestTool({callId:"handoff-call",wireName:"exec_command",mode:"structured",arguments:{}});
  void waiting.then(()=>{released=true;},()=>{});
  channel.deliverNativeToolResult({callId:"handoff-call",content:"Synthetic result",isError:false});
  await expect(run).rejects.toMatchObject({code:"native_web_handoff_unproven",proofState:proof});
  expect(released).toBe(false);expect(submits).toBe(1);expect(String(channel.phase)).toBe("indeterminate-after-acceptance");
 }
});


test("provider failed event retains its owned classification and still releases the surface", async () => {
  const events = new EventQueue();
  events.push({ kind: "failed", providerTurnId: "web-turn-1", detail: "Error in message stream" });
  const released: string[] = [];
  await expect(runBrowserTurn({ browserHost: browserHost(released), provider: provider(events),
    channel: new RuntimeTurnChannel(binding()), nativeTaskId: "task-1", webEpochId: "epoch-1", physicalContext }))
    .rejects.toMatchObject({ code: "tela_web_provider_response_failed", message: "Web turn failed: Error in message stream" });
  expect(released).toEqual(["surface-1"]);
});


test("delivery timeout revokes final authority without Stop, release, resend or completing the Goal", async () => {
  const released: string[] = [];
  const host = browserHost(released);
  const surface = await host.acquire({ taskId: "task-1", epochId: "epoch-1" });
  const channel = new RuntimeTurnChannel(binding());
  const fixture = provider(new EventQueue());
  let sends = 0, stops = 0;
  const error = new WebObservationUnproven("response_wait_timeout");
  const wrapped: WebConversationProvider = { ...fixture,
    async submitTurn(...args) { sends++; expect(args[1].isToolExecutionPending?.()).toBe(false); return fixture.submitTurn(...args); },
    async waitForTurnEvent() { throw error; },
    async cancelTurn() { stops++; },
  };
  await expect(runBrowserTurnOnSurface({ surface, provider: wrapped, channel,
    nativeTaskId: "task-1", webEpochId: "epoch-1", physicalContext })).rejects.toBe(error);
  expect(sends).toBe(1); expect(stops).toBe(0); expect(released).toEqual([]);
  expect(channel.phase).toBe("indeterminate-after-acceptance");
  expect(() => channel.complete("late answer")).toThrow();
});
