import { expect, test } from "bun:test";
import type { NativeResponsesGateway } from "@chatgpt-tela/runtime";
import { NativeProgressStream } from "./live-progress";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticFingerprint, observeDiagnosticEvents, readDiagnosticTail, withDiagnosticContext } from "@chatgpt-tela/core";

test("progress diagnostics distinguish queued text from HTTP pulls without retaining prose", async () => {
  const root=mkdtempSync(join(tmpdir(),"tela-progress-delivery-"));
  const prior=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  const file=join(root,"events.jsonl"); process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
  try {
    const stream=new NativeProgressStream("fixture-model",0);
    const scope=diagnosticFingerprint("scope");
    withDiagnosticContext({scope_fingerprint:scope},()=>stream.progress("PRIVATE 진행 문장"));
    expect(readDiagnosticTail(file).events.map(row=>row.stage)).toEqual(["public_progress_sse_queued"]);
    const reader=stream.response().body!.getReader();
    for(let i=0;i<4;i++) await reader.read();
    expect(readDiagnosticTail(file).events.at(-1)).toMatchObject({stage:"public_progress_sse_pulled",scope_fingerprint:scope,summary_index:0,delivery:"http_body_consumer"});
    await reader.cancel();
    expect(readFileSync(file,"utf8")).not.toContain("PRIVATE");
    expect(readFileSync(file,"utf8")).not.toContain("진행 문장");
  } finally {
    if(prior===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=prior;
    rmSync(root,{recursive:true,force:true});
  }
});

test("an active idle stream emits protocol liveness without fabricating model text or committing a result", async () => {
  const stream = new NativeProgressStream("fixture-model", 0, 5);
  stream.progress("Preparing conversation context (1/5).");
  const reader = stream.response().body!.getReader(), decoder = new TextDecoder();
  for (let i = 0; i < 6; i++) await reader.read();
  const idle = decoder.decode((await reader.read()).value);
  expect(idle).toContain("event: response.in_progress");
  expect(idle).not.toContain("reasoning_summary"); expect(idle).not.toContain("delta");
  let commits = 0;
  stream.finish({ type: "final", answer: "real result", delivery: { capability: "fixture" } },
    { commit() { commits++; } } as unknown as NativeResponsesGateway);
  expect(commits).toBe(0);
  let text = "";
  for (;;) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value); }
  expect(text).toContain("real result"); expect(commits).toBe(1);
});

test("cancelling a waiting stream settles its reader and removes its active idle wait", async () => {
  const stream = new NativeProgressStream("fixture-model", 0, 10);
  stream.progress("preparing");
  const reader = stream.response().body!.getReader();
  for (let i = 0; i < 6; i++) await reader.read();
  const pending = reader.read(); await reader.cancel();
  expect((await pending).done).toBe(true); expect(stream.signal.signal.aborted).toBe(true);
  expect((await reader.read()).done).toBe(true);
});

 test("completion diagnostics distinguish a delivered delta from completed history-bearing frames", async () => {
  const rows: any[] = [];
  const stop = observeDiagnosticEvents(row => rows.push(row));
  try {
    const stream = new NativeProgressStream("fixture", 0);
    stream.progress("first private summary"); stream.progress("second private summary");
    stream.finish({ type: "final", answer: "answer", delivery: { capability: "fixture" } },
      { commit() {} } as unknown as NativeResponsesGateway);
    const wire = await stream.response().text();
    const closed = rows.find(row => row.stage === "public_progress_stream_closed");
    expect(closed).toMatchObject({ reason_class: "drained", summary_count: 2, pulled_summary_count: 2,
      completed_summary_part_count: 2, completed_reasoning_item_count: 1, completed_response_count: 1,
      delivery: "http_body_consumer", ui_observed: false });
    expect(wire).toContain('"summary_index":1');
    expect(JSON.stringify(rows)).not.toContain("private summary");
    const cancelled = new NativeProgressStream("fixture", 0);
    cancelled.progress("delta only");
    const reader = cancelled.response().body!.getReader();
    for (let i = 0; i < 4; i++) await reader.read();
    await reader.cancel();
    expect(rows.at(-1)).toMatchObject({ reason_class: "consumer_cancelled", pulled_summary_count: 1,
      completed_summary_part_count: 0, completed_reasoning_item_count: 0, completed_response_count: 0 });
  } finally { stop?.(); }
});
