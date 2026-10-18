import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeToolInventory,
  defineNativeTurnAuthority,
  type NativeToolDescriptor,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import { RuntimeTurnChannel } from "./turn-channel";

function tool(
  wireName: string,
  kind: NativeToolDescriptor["kind"] = "function",
): NativeToolDescriptor {
  return {
    wireName,
    name: wireName,
    description: wireName,
    kind,
    inputSchema: { type: "object" },
  };
}

function binding(tools: readonly NativeToolDescriptor[] = [tool("exec_command")]): NativeTurnBinding {
  const authority = defineNativeTurnAuthority({
    threadId: "thread-1",
    turnId: "turn-1",
    cwd: "/workspace",
    workspaceRoots: ["/workspace"],
    sandbox: { kind: "read-only", network: "restricted" },
  });
  return {
    claim: {
      threadId: "thread-1",
      turnId: "turn-1",
      requestKind: "turn",
      toolObservations: [{ source: "fixture", tools }],
    },
    authority,
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

describe("runtime turn channel", () => {
  test("replays progress between viewers and keeps journal prose out of diagnostics", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "tela-progress-boundary-"));
    const file = join(scratch, "events.jsonl");
    const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
    try {
      const channel = new RuntimeTurnChannel(binding());
      channel.markSubmitted(); channel.markAccepted();
      channel.publishProgress("PRIVATE_PROGRESS_BEFORE_VIEWER");
      const received: string[] = [];
      channel.subscribeProgress(value => received.push(value));
      // A later subscriber recovers the turn-owned journal.
      expect(received).toEqual(["PRIVATE_PROGRESS_BEFORE_VIEWER"]);
      channel.publishProgress("PRIVATE_PROGRESS_AFTER_VIEWER");
      expect(received).toEqual(["PRIVATE_PROGRESS_BEFORE_VIEWER", "PRIVATE_PROGRESS_AFTER_VIEWER"]);
      channel.publishProgress("x".repeat(16385));
      channel.complete("PRIVATE_FINAL");
      expect(await channel.waitForFinal()).toBe("PRIVATE_FINAL");
      const log = readFileSync(file, "utf8");
      const rows = log.trim().split("\n").map(line => JSON.parse(line));
      expect(rows.filter(row => row.stage === "public_progress_published").map(row => [row.progress_sequence, row.listener_count])).toEqual([[1, 0], [2, 1]]);
      expect(rows.find(row => row.stage === "public_progress_rejected")).toMatchObject({ reason_class: "character_budget", progress_characters: 16385 });
      const last = rows.at(-1);
      expect(last).toMatchObject({ turn_phase: "completed", public_progress_published_count: 2,
        public_progress_without_viewer_count: 1, public_progress_budget_rejected_count: 1 });
      expect(log).not.toMatch(/PRIVATE_PROGRESS|PRIVATE_FINAL/);
    } finally {
      if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  test("progress is bounded presentation, isolated from tool/final authority and failing viewers", async () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted(); channel.markAccepted();
    const summaries: string[] = [];
    channel.subscribeProgress(() => { throw new Error("viewer disconnected"); });
    const unsubscribe = channel.subscribeProgress(summary => summaries.push(summary));
    const revision = channel.stateRevision;
    channel.publishProgress("Checking files");
    expect(summaries).toEqual(["Checking files"]);
    expect(channel.stateRevision).toBe(revision);
    expect(channel.phase).toBe("accepted");
    channel.publishProgress("x".repeat(16385));
    expect(summaries).toHaveLength(1);
    unsubscribe(); channel.publishProgress("No viewer");
    expect(summaries).toHaveLength(1);
    channel.complete("final");
    channel.publishProgress("Too late");
    expect(await channel.waitForFinal()).toBe("final");
  });
  test("carries one causal tool round through same-turn continuation to final", async () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted();
    channel.markAccepted();

    const waitingNative = channel.nextNativeTool();
    const waitingWeb = channel.requestTool({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: { cmd: ["printf", "ok"] },
    });

    expect(await waitingNative).toEqual({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: { cmd: ["printf", "ok"] },
    });
    expect(channel.phase).toBe("tool-wait");

    channel.deliverNativeToolResult({
      callId: "call-1",
      content: "ok",
      isError: false,
    });
    channel.releaseNativeToolResultToWeb("call-1");
    expect(await waitingWeb).toEqual({ callId: "call-1", content: "ok", isError: false });
    expect(channel.releasedToolResultBytes).toBe(4); // JSON wire string includes quotes
    expect(channel.phase).toBe("tool-result-delivered");
    expect(() => channel.complete("too early")).toThrow("continuation is proven");

    channel.markWebContinuation();
    channel.complete("done");
    expect(await channel.waitForFinal()).toBe("done");
    expect(channel.phase).toBe("completed");
    expect(channel.toolRoundCount).toBe(1);
  });

  test("does not permit an accepted turn to be submitted again", () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted();
    channel.markAccepted();
    expect(() => channel.markSubmitted()).toThrow("invalid turn transition");
  });

  test("enforces the exact advertised tool semantics", () => {
    const channel = new RuntimeTurnChannel(binding([
      tool("apply_patch", "freeform"),
      tool("future_tool", "other"),
    ]));
    channel.markSubmitted();
    channel.markAccepted();

    expect(() => channel.requestTool({
      callId: "call-1",
      wireName: "apply_patch",
      mode: "structured",
      arguments: { input: "patch" },
    })).toThrow("requires raw input");
    expect(() => channel.requestTool({
      callId: "call-2",
      wireName: "future_tool",
      mode: "structured",
      arguments: {},
    })).toThrow("semantics are not yet executable");
    expect(channel.phase).toBe("accepted");
  });

  test("a used call id cannot be replayed into the same turn", async () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted();
    channel.markAccepted();
    const result = channel.requestTool({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: {},
    });
    channel.deliverNativeToolResult({ callId: "call-1", content: "ok", isError: false });
    channel.releaseNativeToolResultToWeb("call-1");
    await result;
    channel.markWebContinuation();

    expect(() => channel.requestTool({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: {},
    })).toThrow("already used");
  });

  test("committed Native tool delivery is not emitted again while its result is pending", async () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted();
    channel.markAccepted();
    const waitingWeb = channel.requestTool({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: {},
    });

    expect((await channel.nextNativeTool()).callId).toBe("call-1");
    channel.markNativeToolDelivered("call-1");
    expect(channel.outstandingNativeDelivery).toBe("delivered");
    const controller = new AbortController();
    const next = channel.nextNativeTool(controller.signal);
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });

    channel.deliverNativeToolResult({ callId: "call-1", content: "ok", isError: false });
    channel.releaseNativeToolResultToWeb("call-1");
    await waitingWeb;
  });

  test("state changes are event-driven and include the exact outstanding tool boundary", async () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted();
    channel.markAccepted();
    const revision = channel.stateRevision;
    const waiting = channel.waitForStateChange(revision);

    const result = channel.requestTool({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: {},
    });
    expect(await waiting).toEqual({
      revision: revision + 1,
      phase: "tool-wait",
      toolRoundCount: 1,
      outstandingToolCallId: "call-1",
      outstandingNativeDelivery: "queued",
      nativeResultReady: false,
    });

    const deliveryRevision = channel.stateRevision;
    channel.markNativeToolDelivered("call-1");
    expect(channel.state()).toEqual({
      revision: deliveryRevision + 1,
      phase: "tool-wait",
      toolRoundCount: 1,
      outstandingToolCallId: "call-1",
      outstandingNativeDelivery: "delivered",
      nativeResultReady: false,
    });
    channel.deliverNativeToolResult({ callId: "call-1", content: "ok", isError: false });
    expect(channel.state()).toMatchObject({
      phase: "tool-result-delivered",
      outstandingToolCallId: "call-1",
      nativeResultReady: true,
    });
    channel.releaseNativeToolResultToWeb("call-1");
    await result;
  });

  test("aborting a turn-state wait removes it without changing turn state", async () => {
    const channel = new RuntimeTurnChannel(binding());
    const controller = new AbortController();
    const waiting = channel.waitForStateChange(channel.stateRevision, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(channel.state()).toEqual({ revision: 0, phase: "prepared", toolRoundCount: 0 });
  });
});

test("progress cursor replays only uncommitted events across gaps and settlement", () => {
  const channel = new RuntimeTurnChannel(binding());
  channel.markSubmitted(); channel.markAccepted();
  channel.publishProgress("first"); channel.publishProgress("first");
  const seen: number[] = [];
  const stop = channel.subscribeProgress((_summary, sequence) => seen.push(sequence));
  expect(seen).toEqual([1]);
  channel.commitProgressTransport(1); stop();
  channel.publishProgress("gap"); channel.complete("final");
  channel.subscribeProgress((_summary, sequence) => seen.push(sequence));
  expect(seen).toEqual([1, 2]);
  channel.commitProgressTransport(2);
  channel.subscribeProgress((_summary, sequence) => seen.push(sequence));
  expect(seen).toEqual([1, 2]);
  expect(() => channel.commitProgressTransport(3)).toThrow();
  channel.releaseProgress();
  channel.subscribeProgress((_summary, sequence) => seen.push(sequence), 0);
  expect(seen).toEqual([1, 2]);
});

test("progress replay handles reentrant publication and failing subscribers without losing journal", () => {
  const channel = new RuntimeTurnChannel(binding());
  channel.publishProgress("first");
  const seen: string[] = [];
  channel.subscribeProgress(summary => { seen.push(summary); if (summary === "first") channel.publishProgress("second"); });
  expect(seen).toEqual(["first", "second"]);
  channel.subscribeProgress(() => { throw new Error("closed"); });
  const replay: string[] = [];
  channel.subscribeProgress(summary => replay.push(summary));
  expect(replay).toEqual(seen);
});

test("Native diagnostic witnesses correlate a queued call, local delivery and error result without asserting execution", async () => {
  const scratch=mkdtempSync(join(tmpdir(),"tela-native-tool-witness-"));const file=join(scratch,"events.jsonl");
  const prior=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
  try {
    const channel=new RuntimeTurnChannel(binding([tool("PRIVATE_WIRE")]));channel.markSubmitted();channel.markAccepted();
    const wait=channel.requestTool({callId:"PRIVATE_CALL",wireName:"PRIVATE_WIRE",mode:"structured",arguments:{cmd:"PRIVATE_COMMAND"}});
    channel.markNativeToolDelivered("PRIVATE_CALL");
    const result={callId:"PRIVATE_CALL",content:"PRIVATE_RESULT",isError:true};
    channel.deliverNativeToolResult(result);channel.releaseNativeToolResultToWeb("PRIVATE_CALL");
    expect(await wait).toEqual(result);channel.markWebContinuation();channel.complete("done");expect(await channel.waitForFinal()).toBe("done");
    const raw=readFileSync(file,"utf8");expect(raw).not.toMatch(/PRIVATE_|\/workspace/);
    const rows=raw.trim().split("\n").map(x=>JSON.parse(x)).filter(x=>x.stage.startsWith("native_tool_"));
    expect(rows.map(x=>x.stage)).toEqual(["native_tool_queued","native_tool_delivery_committed","native_tool_result_error","native_tool_result_released"]);
    expect(new Set(rows.map(x=>x.operation_fingerprint)).size).toBe(1);expect(new Set(rows.map(x=>x.schema_fingerprint)).size).toBe(1);
    expect(rows[0]).toMatchObject({policy:"read-only",root_count:1,native_delivery_committed:false,result_received:false});
    expect(rows[2]).toMatchObject({native_delivery_committed:true,result_received:true,error_result_reported:true});
    expect(rows[3]).toMatchObject({native_delivery_committed:true,result_received:true,execution_proven:false,origin_proven:false});
  }finally{
    if(prior===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=prior;
    await new Promise(resolve=>setImmediate(resolve));rmSync(scratch,{recursive:true,force:true});
  }
});
