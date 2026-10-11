import { describe, expect, test } from "bun:test";
import { AppServerCurrentTurnSource, type CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import {
  ActiveTurnRegistry,
  NativeResponsesGateway,
} from "@chatgpt-tela/runtime";
import { handleNativeResponsesHttp } from "./transport";

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

function body(input: unknown[] = [], stream = true): Record<string, unknown> {
  return {
    model: "chatgpt-tela-test-model",
    stream,
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

function post(value: unknown): Request {
  return new Request("http://127.0.0.1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

describe("Native Responses HTTP transport", () => {
  test("delivers public progress before final without committing it as an outcome", async () => {
    const turns = new ActiveTurnRegistry();
    let channel: import("@chatgpt-tela/runtime").RuntimeTurnChannel | undefined;
    const gateway = new NativeResponsesGateway(source, turns, async registered => {
      channel = registered.channel; channel.markSubmitted(); channel.markAccepted();
      channel.publishProgress("Inspecting files");
      await channel.waitForFinal();
    });
    const response = await handleNativeResponsesHttp(post(body()), gateway);
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = "";
    while (!text.includes("response.reasoning_summary_text.delta")) text += decoder.decode((await reader.read()).value);
    expect(text).toContain("Inspecting files");
    expect(turns.size).toBe(1);
    expect(channel!.phase).toBe("accepted");
    channel!.complete("**Final**");
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); }
    const events = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events.filter(event => event.type === "response.created")).toHaveLength(1);
    const complete = events.find(event => event.type === "response.completed").response;
    expect(complete.id).toBe(events[0].response.id);
    expect(complete.output.map((item: any) => item.type)).toEqual(["reasoning", "message"]);
    expect(complete.output[1].content[0].text).toBe("**Final**");
    expect(events.find(event => event.type === "response.output_text.delta").output_index).toBe(1);
    expect(turns.size).toBe(0);
  });

  test("cancelling after progress leaves an unread tool identity replayable", async () => {
    const turns = new ActiveTurnRegistry(); let launches = 0;
    const gateway = new NativeResponsesGateway(source, turns, async registered => {
      launches++; registered.channel.markSubmitted(); registered.channel.markAccepted();
      registered.channel.publishProgress("Preparing inspection");
      await registered.channel.requestTool({ callId: "call-progress", wireName: "exec_command",
        mode: "structured", arguments: { cmd: "synthetic" } });
    });
    const response = await handleNativeResponsesHttp(post(body()), gateway);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("response.created");
    await reader.cancel();
    expect(turns.active("thread-1", "turn-1")!.channel.outstandingNativeDelivery).toBe("queued");
    const replay = await handleNativeResponsesHttp(post(body()), gateway);
    expect(await replay.text()).toContain('"call_id":"call-progress"');
    expect(turns.active("thread-1", "turn-1")!.channel.outstandingNativeDelivery).toBe("delivered");
    expect(launches).toBe(1);
  });

  test("failure after visible progress terminates the same stream without a final answer", async () => {
    const turns = new ActiveTurnRegistry();
    let fail!: () => void;
    const gateway = new NativeResponsesGateway(source, turns, async registered => {
      registered.channel.markSubmitted(); registered.channel.markAccepted();
      registered.channel.publishProgress("Checking state");
      await new Promise<void>((_, reject) => { fail = () => reject(new Error("synthetic failure")); });
    });
    const response = await handleNativeResponsesHttp(post(body()), gateway);
    expect(response.status).toBe(200); fail();
    const text = await response.text();
    expect(text).toContain("response.failed"); expect(text).toContain("synthetic failure");
    expect(text).not.toContain("response.completed"); expect(turns.size).toBe(0);
  });
  test("propagates the catalog invalidation code only for the declared semantic failure", async () => {
    for (const code of ["tela_web_model_unavailable", "arbitrary-provider-code"]) {
      const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async () => {
        throw Object.assign(new Error("fixture failure"), { code });
      });
      const response = await handleNativeResponsesHttp(post(body()), gateway);
      expect(response.status).toBe(409);
      const failure = await response.json() as { error: { code?: string } };
      expect(failure.error.code).toBe(code === "tela_web_model_unavailable" ? code : undefined);
    }
  });
  test("oversized cold Native history reports a recoverable 422 instead of pretending to be a connection outage", async () => {
    const turns=new ActiveTurnRegistry();
    let starts=0;
    let nativeReads=0;
    const verifiedSource = { async currentTurn(threadId: string) {
      nativeReads++;
      return source.currentTurn(threadId);
    }};
    const gateway=new NativeResponsesGateway(verifiedSource,turns,async()=>{
      starts++;
      throw Object.assign(new Error("Private source contents must not cross transport"),{
        code:"native_history_bootstrap_required",
      });
    });
    const first=await handleNativeResponsesHttp(post(body([],false)),gateway);
    expect(first.status).toBe(422);
    const result=await first.json() as {error:{
      type:string;code:string;message:string;retryable:boolean;
      recovery?:{kind:string;requires_user_action:boolean;requires_new_native_turn:boolean;original_history_preserved:boolean};
    }};
    expect(result.error).toMatchObject({
      type:"tela_context_recovery_required",
      code:"tela_native_history_checkpoint_required",
    });
    expect(result.error.message).toContain("verified readable checkpoint");
    expect(result.error.retryable).toBe(false);
    expect(result.error.recovery).toEqual({
      kind:"explicit_native_handoff",
      requires_user_action:true,
      requires_new_native_turn:true,
      original_history_preserved:true,
    });
    expect(JSON.stringify(result)).not.toContain("Private source contents");
    expect(starts).toBe(1);
    const replay=await handleNativeResponsesHttp(post(body([],false)),gateway);
    expect(replay.status).toBe(409);
    const retry = await replay.json() as {error:{code?:string;retryable?:boolean;message:string}};
    expect(retry.error.code).toBe("tela_native_turn_already_retired");
    expect(retry.error.retryable).toBe(false);
    expect(retry.error.message).toContain("new, explicitly authorized Native turn");
    expect(nativeReads).toBe(1);
    expect(starts).toBe(1);
    expect(turns.size).toBe(0);
  });

  test("unindexed Legacy history returns a nonretryable Native-only recovery, not an impossible replay promise", async () => {
    const turns = new ActiveTurnRegistry();
    let starts = 0;
    const gateway = new NativeResponsesGateway(source, turns, async () => {
      starts++;
      throw Object.assign(new Error("PRIVATE original Legacy history may not be exported"), {
        code: "native_history_bootstrap_required",
        recoveryReason: "unindexed_history",
      });
    });
    const response = await handleNativeResponsesHttp(post(body([], false)), gateway);
    expect(response.status).toBe(422);
    const reply = await response.json() as { error: {
      code: string; retryable: boolean; message: string;
      recovery: {
        kind: string; requires_user_action: boolean;
        requires_new_native_turn: boolean; original_history_preserved: boolean;
      };
    } };
    expect(reply.error.code).toBe("tela_native_history_indexed_source_required");
    expect(reply.error.retryable).toBe(false);
    expect(reply.error.recovery).toEqual({
      kind: "continue_on_native",
      requires_user_action: true,
      requires_new_native_turn: false,
      original_history_preserved: true,
    });
    expect(reply.error.message).toContain("new handoff turn alone cannot");
    expect(JSON.stringify(reply)).not.toContain("PRIVATE original Legacy history");
    expect(starts).toBe(1);
    expect(turns.size).toBe(0);
  });

  test("real bounded current-turn binding returns Legacy 422 before any tool, history paging or Web launch", async () => {
    const methods: string[] = [];
    let closes = 0;
    let launches = 0;
    const canonical = new AppServerCurrentTurnSource(async () => ({
      async request(method: string, params?: unknown) {
        methods.push(method);
        if (method !== "thread/read"
          || (params as { includeTurns?: boolean })?.includeTurns !== false) {
          throw Error("No unbounded Legacy history read or model launch is permitted");
        }
        return { thread: {
          id: "thread-1", historyMode: "legacy", status: { type: "active" },
        } };
      },
      async close() { closes++; },
    }), { preferBoundedTurnProof: true });
    const turns = new ActiveTurnRegistry();
    const gateway = new NativeResponsesGateway(canonical, turns, async () => {
      launches++;
      throw Error("Web must not be launched on unproved Native authority");
    });
    const response = await handleNativeResponsesHttp(post(body([], false)), gateway);
    expect(response.status).toBe(422);
    const reply = await response.json() as { error: {
      code: string; retryable: boolean;
      recovery: { kind: string; original_history_preserved: boolean };
    } };
    expect(reply.error.code).toBe("tela_native_history_indexed_source_required");
    expect(reply.error.retryable).toBe(false);
    expect(reply.error.recovery).toMatchObject({
      kind: "continue_on_native",
      original_history_preserved: true,
    });
    expect(methods).toEqual(["thread/read"]);
    expect(closes).toBe(1);
    expect(launches).toBe(0);
    expect(turns.size).toBe(0);
  });
  test("cancellation before a tool identity frame keeps delivery replayable; reading it commits fail-closed", async () => {
    const turns = new ActiveTurnRegistry();
    let launches = 0;
    const gateway = new NativeResponsesGateway(source, turns, async registered => {
      launches += 1;
      registered.channel.markSubmitted();
      registered.channel.markAccepted();
      const waitingResult = registered.channel.requestTool({
        callId: "call-1",
        wireName: "exec_command",
        mode: "structured",
        arguments: { cmd: ["printf", "ok"] },
      });
      let state = registered.channel.state();
      while (!(state.phase === "tool-result-delivered"
        && state.nativeResultReady === true
        && state.outstandingToolCallId === "call-1")) {
        state = await registered.channel.waitForStateChange(state.revision);
      }
      registered.channel.releaseNativeToolResultToWeb("call-1");
      const result = await waitingResult;
      registered.channel.markWebContinuation();
      registered.channel.complete(`done:${String(result.content)}`);
    });

    const first = await handleNativeResponsesHttp(post(body()), gateway, { now: () => 123_000 });
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    const firstReader = first.body!.getReader();
    const firstFrame = new TextDecoder().decode((await firstReader.read()).value);
    expect(firstFrame).toContain("response.created");
    await firstReader.cancel();
    expect(turns.active("thread-1", "turn-1")?.channel.outstandingNativeDelivery).toBe("queued");

    const replay = await handleNativeResponsesHttp(post(body()), gateway, { now: () => 123_000 });
    const replayText = await replay.text();
    expect(replayText).toContain('"call_id":"call-1"');
    expect(replayText).toContain("data: [DONE]");
    expect(turns.active("thread-1", "turn-1")?.channel.outstandingNativeDelivery).toBe("delivered");
    expect(launches).toBe(1);

    const missing = await handleNativeResponsesHttp(post(body()), gateway);
    expect(missing.status).toBe(409);
    expect(await missing.text()).toContain("follow-up request must contain its result");

    const followup = body([
      { type: "function_call_output", call_id: "call-1", output: "ok" },
    ]);
    const final = await handleNativeResponsesHttp(post(followup), gateway, { now: () => 124_000 });
    const finalText = await final.text();
    expect(finalText).toContain('"delta":"done:ok"');
    expect(finalText).toContain("response.completed");
    expect(turns.size).toBe(0);
  });

  test("non-stream mode returns a standard completed response object", async () => {
    const turns = new ActiveTurnRegistry();
    const gateway = new NativeResponsesGateway(source, turns, async registered => {
      registered.channel.markSubmitted();
      registered.channel.markAccepted();
      registered.channel.complete("hello");
    });

    const response = await handleNativeResponsesHttp(post(body([], false)), gateway, { now: () => 125_000 });
    expect(response.headers.get("content-type")).toContain("application/json");
    const json = await response.json() as Record<string, unknown>;
    expect(json.status).toBe("completed");
    expect(json.created_at).toBe(125);
    expect(json.output).toEqual([{
      type: "message",
      id: expect.stringMatching(/^msg_tela_/),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    }]);
    expect(turns.size).toBe(0);
  });

  test("rejects malformed transport input before starting runtime work", async () => {
    let launches = 0;
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async () => {
      launches += 1;
    });

    const malformed = await handleNativeResponsesHttp(new Request("http://127.0.0.1/responses", {
      method: "POST",
      body: "{not-json",
    }), gateway);
    expect(malformed.status).toBe(400);

    const missingModel = await handleNativeResponsesHttp(post({ stream: true }), gateway);
    expect(missingModel.status).toBe(400);
    expect(launches).toBe(0);
  });
});

test("SSE carries gap progress into the next tool round without repeating committed summaries", async () => {
  const turns = new ActiveTurnRegistry();
  const gateway = new NativeResponsesGateway(source, turns, async registered => {
    const channel = registered.channel;
    channel.markSubmitted(); channel.markAccepted(); channel.publishProgress("Initial inspection");
    await channel.requestTool({ callId: "gap-tool", wireName: "exec_command", mode: "structured", arguments: {} });
  });
  const first = await handleNativeResponsesHttp(post(body()), gateway);
  expect(await first.text()).toContain("Initial inspection");
  const channel = turns.active("thread-1", "turn-1")!.channel;
  expect(channel.progressTransportCursor).toBe(1);
  channel.publishProgress("Public explanation during tool execution");
  const next = handleNativeResponsesHttp(post(body([{ type: "function_call_output", call_id: "gap-tool", output: "ok" }])), gateway);
  let state = channel.state();
  while (!state.nativeResultReady) state = await channel.waitForStateChange(state.revision);
  channel.releaseNativeToolResultToWeb("gap-tool"); channel.markWebContinuation(); channel.complete("Done");
  const text = await (await next).text();
  const events = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  expect(events.filter(event => event.type === "response.reasoning_summary_text.delta").map(event => event.delta))
    .toEqual(["Public explanation during tool execution"]);
  expect(turns.size).toBe(0);
});
