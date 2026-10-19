import { WebSubmissionUnproven, WEB_SUBMISSION_PROOF_REASONS } from "@chatgpt-tela/core";
import { describe, expect, test } from "bun:test";
import { WebObservationUnproven } from "@chatgpt-tela/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerCurrentTurnSource, type CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import {
  ActiveTurnRegistry,
  NativeResponsesGateway,
} from "@chatgpt-tela/runtime";
import { handleNativeResponsesHttp } from "./transport";
import { WebRetainedContextUnproven, WEB_RETAINED_CONTEXT_REASONS } from "@chatgpt-tela/core";
import { NativeProjectionUnsupported, NativeWebHandoffUnproven } from "@chatgpt-tela/core";

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

test("HTTP disconnect aborts its observer while a subsequent request reuses the single Web execution", async () => {
  let release!: () => void, ready!: () => void, launches = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async registered => {
    launches++; ready(); await gate;
    registered.channel.markSubmitted(); registered.channel.markAccepted(); registered.channel.complete("preserved execution");
  });
  const controller = new AbortController();
  const first = handleNativeResponsesHttp(new Request("http://127.0.0.1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body([], false)), signal: controller.signal,
  }), gateway);
  try {
    await started; controller.abort();
    const old = await Promise.race([first, Bun.sleep(100).then(() => null)]);
    expect(old).not.toBeNull();
    const fresh = handleNativeResponsesHttp(post(body([], false)), gateway);
    release(); const response = await fresh;
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("preserved execution");
    expect(launches).toBe(1);
  } finally { release(); await gateway.close(); }
});

describe("Native Responses HTTP transport", () => {
  test.each(["conversation_changed", "request_changed", "lineage_conflict"] as const)("accepted observation failure remains terminal with original cause after retirement: %s", async reason => {
    let sends=0;
    const gateway=new NativeResponsesGateway(source,new ActiveTurnRegistry(),async turn=>{
      sends++; turn.channel.markSubmitted(); turn.channel.markAccepted();
      throw new WebObservationUnproven(reason,"PRIVATE_BROWSER_EXCEPTION");
    });
    try {
      const first=await handleNativeResponsesHttp(post(body()),gateway);
      expect(first.status).toBe(400); const receipt=await first.json();
      expect(receipt.error).toMatchObject({code:"tela_web_observation_unproven",reason,retryable:false,
        recovery:{requires_new_conversation:false,reuse_verified_context_first:true}});
      expect(JSON.stringify(receipt)).not.toContain("PRIVATE_BROWSER_EXCEPTION");
      const replay=await handleNativeResponsesHttp(post(body()),gateway);
      expect(replay.status).toBe(400); expect(await replay.json()).toEqual(receipt); expect(sends).toBe(1);
    } finally {await gateway.close();}
  });

  test("accepted observation failure after progress has identical SSE and retired replay recovery", async () => {
    let fail!: (error:unknown)=>void;
    const pending=new Promise<void>((_,reject)=>{fail=reject;}); let sends=0;
    const gateway=new NativeResponsesGateway(source,new ActiveTurnRegistry(),async turn=>{
      turn.channel.publishProgress("Preparing work"); sends++;
      turn.channel.markSubmitted(); turn.channel.markAccepted(); await pending;
    });
    try {
      const response=await handleNativeResponsesHttp(post(body()),gateway);
      fail(new WebObservationUnproven("conversation_changed"));
      const events=(await response.text()).split("\n").filter(line=>line.startsWith("data: {"))
        .map(line=>JSON.parse(line.slice(6)));
      const error=events.find(event=>event.type==='response.failed').response.error;
      expect(error).toMatchObject({code:'tela_web_observation_unproven',reason:'conversation_changed',retryable:false});
      expect(events.some(event=>event.type==='response.completed')).toBe(false);
      const replay=await handleNativeResponsesHttp(post(body()),gateway);
      expect(replay.status).toBe(400); expect((await replay.json()).error).toEqual(error); expect(sends).toBe(1);
    } finally {await gateway.close();}
  });
  test("completed-cycle continuation without proven new input is terminal rather than a reconnectable 409", async () => {
    let launches = 0;
    const owner = new AbortController();
    const gateway = new NativeResponsesGateway({ ...source, async watchTurn() {
      return { signal: owner.signal, inputs: () => [], async close() {} };
    } }, new ActiveTurnRegistry(), async turn => {
      launches++; turn.channel.markSubmitted(); turn.channel.markAccepted(); turn.channel.complete("final");
    });
    const initial = await handleNativeResponsesHttp(post(body([], false)), gateway);
    expect(initial.status).toBe(200); await initial.text();
    const response = await handleNativeResponsesHttp(post(body([], false)), gateway);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ type: "invalid_request_error",
      code: "tela_native_response_cycle_conflict", retryable: false });
    expect(launches).toBe(1); await gateway.close();
  });

  test("unproven submission preserves the first cause across retirement and cannot send twice", async () => {
    for (const reason of WEB_SUBMISSION_PROOF_REASONS) {
      let reads = 0, sends = 0;
      const gateway = new NativeResponsesGateway({ async currentTurn(threadId) {
        reads++; return source.currentTurn(threadId);
      } }, new ActiveTurnRegistry(), async turn => {
        sends++; turn.channel.markSubmitted(); throw new WebSubmissionUnproven(reason);
      });
      try {
        const first = await handleNativeResponsesHttp(post(body()), gateway);
        expect(first.status).toBe(400);
        const receipt = await first.json();
        expect(receipt.error).toMatchObject({ code: "tela_web_submission_unproven", reason,
          retryable: false, recovery: { kind: "reconcile_web_submission", requires_new_native_turn: true } });
        for (let i = 0; i < 2; i++) {
          const replay = await handleNativeResponsesHttp(post(body()), gateway);
          expect(replay.status).toBe(400); expect(await replay.json()).toEqual(receipt);
        }
        expect(reads).toBe(1); expect(sends).toBe(1);
      } finally { await gateway.close(); }
    }
  });

  test("unproven submission after preparation progress has identical SSE and replay recovery", async () => {
    let fail!: (error: unknown) => void;
    const pending = new Promise<void>((_, reject) => { fail = reject; });
    let sends = 0;
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async turn => {
      turn.channel.publishProgress("Prepared context"); sends++; turn.channel.markSubmitted(); await pending;
    });
    try {
      const response = await handleNativeResponsesHttp(post(body()), gateway);
      fail(new WebSubmissionUnproven("ambiguous_author_root"));
      const events = (await response.text()).split("\n").filter(line => line.startsWith("data: {"))
        .map(line => JSON.parse(line.slice(6)));
      const error = events.find(event => event.type === "response.failed").response.error;
      expect(error).toMatchObject({ code: "tela_web_submission_unproven", reason: "ambiguous_author_root", retryable: false });
      expect(events.some(event => event.type === "response.completed")).toBe(false);
      const replay = await handleNativeResponsesHttp(post(body()), gateway);
      expect(replay.status).toBe(400); expect((await replay.json()).error).toEqual(error);
      expect(sends).toBe(1);
    } finally { await gateway.close(); }
  });

  test("retained-context failure survives retirement without replaying execution or losing its cause", async () => {
    for (const reason of WEB_RETAINED_CONTEXT_REASONS) {
      let reads = 0, launches = 0;
      const turns = new ActiveTurnRegistry();
      const gateway = new NativeResponsesGateway({ async currentTurn(threadId) {
        reads++; return source.currentTurn(threadId);
      } }, turns, async () => { launches++; throw new WebRetainedContextUnproven(reason); });
      const first = await handleNativeResponsesHttp(post(body()), gateway);
      expect(first.status).toBe(400);
      const expected = await first.json();
      expect(expected.error).toMatchObject({ code: "tela_web_retained_context_unproven", reason,
        retryable: false, recovery: { requires_new_native_turn: true, original_history_preserved: true } });
      for (let retry = 0; retry < 2; retry++) {
        const response = await handleNativeResponsesHttp(post(body()), gateway);
        expect(response.status).toBe(400); expect(await response.json()).toEqual(expected);
      }
      expect(turns.size).toBe(0); expect(reads).toBe(1); expect(launches).toBe(1);
      await gateway.close();
    }
  });

  test("retained-context failure after progress has the same safe recovery as HTTP", async () => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async turn => {
      turn.channel.markSubmitted(); turn.channel.publishProgress("Checking context"); await pending;
    });
    const response = await handleNativeResponsesHttp(post(body()), gateway);
    reject(new WebRetainedContextUnproven("observed_body_incomplete"));
    const text = await response.text();
    const failed = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
      .find(event => event.type === "response.failed");
    expect(failed.response.error).toMatchObject({ code: "tela_web_retained_context_unproven",
      reason: "observed_body_incomplete", retryable: false });
    const replay = await handleNativeResponsesHttp(post(body()), gateway);
    expect(replay.status).toBe(400);
    const recovered = await replay.json();
    expect(failed.response.error).toEqual(recovered.error);
    await gateway.close();
  });

  test("retries preserve the original history recovery without restoring execution authority", async () => {
    for (const recoveryReason of ["unindexed_history", "source_unavailable", "checkpoint_interrupted", "checkpoint_closed", "checkpoint_rejected", "source_budget"] as const) {
      let reads = 0;
      let launches = 0;
      const turns = new ActiveTurnRegistry();
      const gateway = new NativeResponsesGateway({
        async currentTurn(threadId) { reads++; return source.currentTurn(threadId); },
      }, turns, async () => {
        launches++;
        throw Object.assign(new Error("PRIVATE HISTORY AND ORIGINAL EXCEPTION"), {
          code: "native_history_bootstrap_required", recoveryReason,
        });
      });
      const first = await handleNativeResponsesHttp(post(body()), gateway);
      expect(first.status).toBe(400);
      const expected = await first.json();
      if (recoveryReason === "checkpoint_rejected") expect(expected.error).toMatchObject({
        code: "tela_native_checkpoint_response_rejected", retryable: false,
        recovery: { kind: "explicit_native_handoff", requires_new_native_turn: true },
      });
      if (recoveryReason === "source_budget") expect(expected.error).toMatchObject({
        code: "tela_native_context_checkpoint_required", type: "invalid_request_error", retryable: false,
      });
      if (recoveryReason === "checkpoint_closed") {
        expect(expected.error).toMatchObject({code: "tela_native_checkpoint_operation_closed", retryable: false,
          recovery: {kind: "explicit_native_handoff", requires_new_native_turn: true}});
        expect(expected.error.message).not.toContain("Reconcile");
      }
      if (recoveryReason === "checkpoint_interrupted") expect(expected.error).toMatchObject({
        code: "tela_native_checkpoint_reconciliation_required", retryable: false,
        recovery: { kind: "reconcile_checkpoint", requires_new_native_turn: true },
      });
      expect(turns.size).toBe(0);
      for (let retry = 0; retry < 5; retry++) {
        const response = await handleNativeResponsesHttp(post(body()), gateway);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual(expected);
        expect(turns.size).toBe(0);
      }
      expect(JSON.stringify(expected)).not.toContain("PRIVATE HISTORY");
      expect(launches).toBe(1);
      expect(reads).toBe(1);
      await gateway.close();
    }
  });

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
    expect(turns.size).toBe(1);
    await gateway.close();
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
  test("late streamed Native history failure preserves the nonretryable recovery contract without exposing private error text", async () => {
    const folder = mkdtempSync(join(tmpdir(), "tela-stream-recovery-"));
    const log = join(folder, "diagnostics.jsonl");
    const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = log;
    try {
      for (const recoveryReason of ["unindexed_history", "source_unavailable"] as const) {
        const turns = new ActiveTurnRegistry();
        let fail!: () => void;
        const gateway = new NativeResponsesGateway(source, turns, async registered => {
          registered.channel.markSubmitted();
          registered.channel.markAccepted();
          registered.channel.publishProgress("Checking owned context");
          await new Promise<void>((_, reject) => {
            fail = () => reject(Object.assign(
              new Error("PRIVATE ORIGINAL NATIVE TRANSCRIPT CONTENT"),
              { code: "native_history_bootstrap_required", recoveryReason },
            ));
          });
        });
        const response = await handleNativeResponsesHttp(post(body()), gateway);
        // A started SSE stream cannot be retroactively changed into HTTP 400.
        expect(response.status).toBe(200);
        fail();
        const text = await response.text();
        const events = text.split("\n")
          .filter(line => line.startsWith("data: {"))
          .map(line => JSON.parse(line.slice(6)) as Record<string, any>);
        const failures = events.filter(event => event.type === "response.failed");
        expect(failures).toHaveLength(1);
        expect(failures[0]!.response.error).toMatchObject({
          code: recoveryReason === "unindexed_history"
            ? "tela_native_history_indexed_source_required"
            : "tela_native_history_checkpoint_required",
          retryable: false,
          recovery: {
            kind: recoveryReason === "unindexed_history"
              ? "continue_on_native" : "explicit_native_handoff",
            requires_user_action: true,
            requires_new_native_turn: recoveryReason !== "unindexed_history",
            original_history_preserved: true,
          },
        });
        expect(text).not.toContain("PRIVATE ORIGINAL NATIVE TRANSCRIPT CONTENT");
        expect(events.some(event => event.type === "response.completed")).toBe(false);
        expect(turns.size).toBe(0);
      }
      const diagnostics = readFileSync(log, "utf8");
      const recoveryEvents = diagnostics.trim().split("\n").map(line => JSON.parse(line))
        .filter(row => row.stage === "native_context_recovery_streamed");
      expect(recoveryEvents.map(row => [row.reason_class, row.transport_phase])).toEqual([
        ["history_mode_unindexed", "sse_after_progress"],
        ["history_bootstrap_required", "sse_after_progress"],
      ]);
      for (const privateSource of ["PRIVATE ORIGINAL NATIVE TRANSCRIPT CONTENT", "thread-1", "turn-1"]) {
        expect(diagnostics).not.toContain(privateSource);
      }
    } finally {
      if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
      rmSync(folder, { recursive: true, force: true });
    }
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
  test("generic retirement uses terminal InvalidRequest and distinguishes a new turn from a new conversation", async () => {
    const owner = new AbortController();
    const watched = { ...source, async watchTurn() { return { signal: owner.signal, async close() {} }; } };
    let launches = 0;
    const gateway = new NativeResponsesGateway(watched, new ActiveTurnRegistry(), async turn => {
      launches++;
      turn.channel.markSubmitted();
      turn.channel.markAccepted();
      turn.channel.complete("fixture answer");
    });
    try {
      const first = await handleNativeResponsesHttp(post(body([], false)), gateway);
      expect(first.status).toBe(200);
      await first.json();
      owner.abort(new Error("fixture owner completed"));
      const replay = await handleNativeResponsesHttp(post(body([], false)), gateway);
      expect(replay.status).toBe(400);
      expect((await replay.json() as { error: unknown }).error).toMatchObject({
        code: "tela_native_turn_already_retired", retryable: false,
        recovery: { kind: "authorized_native_continuation", requires_user_action: true,
          requires_new_native_turn: true, requires_new_conversation: false,
          reuse_verified_context_first: true, prior_execution_settled: "unknown" },
      });
      expect(launches).toBe(1);
    } finally { await gateway.close(); }
  });
  test("oversized cold Native history reports a recoverable 400 instead of pretending to be a connection outage", async () => {
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
    expect(first.status).toBe(400);
    const result=await first.json() as {error:{
      type:string;code:string;message:string;retryable:boolean;
      recovery?:{kind:string;requires_user_action:boolean;requires_new_native_turn:boolean;original_history_preserved:boolean};
    }};
    expect(result.error).toMatchObject({
      type:"invalid_request_error",
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
    expect(replay.status).toBe(400);
    const retry = await replay.json() as {error:{code?:string;retryable?:boolean;message:string}};
    expect(retry.error.code).toBe("tela_native_history_checkpoint_required");
    expect(retry.error.retryable).toBe(false);
    expect(retry).toEqual(result);

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
    expect(response.status).toBe(400);
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

  test("real bounded current-turn binding returns Legacy 400 before any tool, history paging or Web launch", async () => {
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
    expect(response.status).toBe(400);
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
    expect(missing.status).toBe(400);
    expect((await missing.json() as { error: { code: string; retryable: boolean } }).error)
      .toMatchObject({ code: "tela_native_tool_result_missing", retryable: false });

    const followup = body([
      { type: "function_call_output", call_id: "call-1", output: "ok" },
    ]);
    const final = await handleNativeResponsesHttp(post(followup), gateway, { now: () => 124_000 });
    const finalText = await final.text();
    expect(finalText).toContain('"delta":"done:ok"');
    expect(finalText).toContain("response.completed");
    expect(turns.size).toBe(1);
    await gateway.close();
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
      role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    }]);
    expect(turns.size).toBe(1);
    await gateway.close();
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
  expect(turns.size).toBe(1);
  await gateway.close();
  expect(turns.size).toBe(0);
});


test("projection failure stays sanitized and terminal after retirement without executing twice", async () => {
  let starts = 0;
  const registry = new ActiveTurnRegistry();
  const gateway = new NativeResponsesGateway(source, registry, async () => {
    starts++;
    const failure = new NativeProjectionUnsupported();
    failure.message = "PRIVATE request content";
    throw failure;
  });
  try {
    let first: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await handleNativeResponsesHttp(post(body([], false)), gateway);
      expect(response.status).toBe(400);
      const value = await response.json();
      expect(value).toMatchObject({ error: { type: "invalid_request_error",
        code: "tela_native_projection_unsupported", retryable: false,
        recovery: { kind: "continue_on_native", original_history_preserved: true } } });
      expect(JSON.stringify(value)).not.toContain("PRIVATE");
      if (attempt === 0) first = value;
      else expect(value).toEqual(first);
    }
    expect(starts).toBe(1);
    expect(registry.size).toBe(0);
  } finally { await gateway.close(); }
});

test("late streamed projection rejection preserves recovery and the next Native retry is terminal", async () => {
  let fail!: () => void;
  const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async turn => {
    turn.channel.markSubmitted(); turn.channel.markAccepted();
    turn.channel.publishProgress("Preparing context");
    await new Promise<void>(resolve => { fail = resolve; });
    throw new NativeProjectionUnsupported();
  });
  try {
    const response = await handleNativeResponsesHttp(post(body()), gateway);
    fail();
    const text = await response.text();
    expect(text).toContain("response.failed");
    expect(text).toContain("tela_native_projection_unsupported");
    expect(text).toContain('"retryable":false');
    expect(text).not.toContain("response.completed");
    // Native currently retries unknown response.failed codes regardless of retryable=false.
    // The retired replay must preserve the projection cause and end that retry as HTTP 400.
    const replay = await handleNativeResponsesHttp(post(body()), gateway);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({error:{code:"tela_native_projection_unsupported"}});
  } finally { await gateway.close(); }
});


test("unproven post-result handoff preserves safe terminal recovery after retirement", async () => {
  for(const proof of ["probable","ambiguous"] as const) {
    let launches=0;
    const gateway=new NativeResponsesGateway(source,new ActiveTurnRegistry(),async turn=>{
      launches++;turn.channel.markSubmitted();turn.channel.markAccepted();
      const error=new NativeWebHandoffUnproven(proof);error.message="PRIVATE upstream evidence";throw error;
    });
    try {
      let prior:unknown;
      for(let attempt=0;attempt<2;attempt++) {
        const response=await handleNativeResponsesHttp(post(body([],false)),gateway);
        expect(response.status).toBe(400);
        const json=await response.json();
        expect(json).toMatchObject({error:{code:"tela_native_handoff_reconciliation_required",retryable:false,
          recovery:{kind:"reconcile_tool_handoff",requires_new_native_turn:true,prior_execution_settled:"unknown"}}});
        expect(JSON.stringify(json)).not.toContain("PRIVATE");
        if(attempt===0)prior=json;else expect(json).toEqual(prior);
      }
      expect(launches).toBe(1);
    } finally {await gateway.close();}
  }
});


test("streamed handoff failure keeps reconciliation advice and a terminal retired retry",async()=>{
 let fail!:()=>void;
 const gateway=new NativeResponsesGateway(source,new ActiveTurnRegistry(),async turn=>{
  turn.channel.markSubmitted();turn.channel.markAccepted();turn.channel.publishProgress("Waiting for tool result");
  await new Promise<void>(resolve=>{fail=resolve;});throw new NativeWebHandoffUnproven("probable");
 });
 try{
  const response=await handleNativeResponsesHttp(post(body()),gateway);fail();const text=await response.text();
  expect(text).toContain("response.failed");expect(text).toContain("tela_native_handoff_reconciliation_required");
  expect(text).not.toContain("response.completed");
  const retry=await handleNativeResponsesHttp(post(body()),gateway);expect(retry.status).toBe(400);
  expect(await retry.json()).toMatchObject({error:{code:"tela_native_handoff_reconciliation_required"}});
 }finally{await gateway.close();}
});

test('fit failures preserve identical terminal cause over HTTP, progressed SSE and retired replay',async()=>{
 const {WebContextFitFailed,WEB_CONTEXT_FIT_REASONS}=await import('@chatgpt-tela/core');
 for(const reason of WEB_CONTEXT_FIT_REASONS){
  let expected:unknown;
  for(const stream of [false,true]){
   let launches=0;
   const gateway=new NativeResponsesGateway(source,new ActiveTurnRegistry(),async turn=>{
    launches++;if(stream)turn.channel.publishProgress('Preparing context.');
    throw new WebContextFitFailed(reason,{required:123456,budget:24000});
   });
   const response=await handleNativeResponsesHttp(post(body([],stream)),gateway);
   let error:any;
   if(stream){
    expect(response.status).toBe(200);
    const frames=(await response.text()).split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
    error=frames.find(f=>f.type==='response.failed').response.error;
   }else{expect(response.status).toBe(400);error=(await response.json() as any).error;expected=error;}
   expect(error).toEqual(expected);
   expect(error).toMatchObject({code:'tela_web_context_fit_failed',retryable:false,recovery:{reason,requires_new_conversation:false}});
   const replay=await handleNativeResponsesHttp(post(body([],false)),gateway);
   expect(replay.status).toBe(400);expect((await replay.json() as any).error).toEqual(error);expect(launches).toBe(1);
  }
 }
});
