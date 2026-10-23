import { expect, test } from "bun:test";
import { nativeProjectionFailureFields, nativeProjectionPrivateShape } from "./native-projection-diagnostics";
import { structuralDiagnosticEvent } from "@chatgpt-tela/core";
import { emitDiagnosticEvent, readDiagnosticTail } from "@chatgpt-tela/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("rejected Native item retains its position, count, safe type and question relationship", () => {
  const input = [
    { type: "function_call", name: "request_user_input", call_id: "private-call", arguments: "PRIVATE QUESTION" },
    { type: "function_call_output", call_id: "private-call", output: "PRIVATE ANSWER" },
    { type: "future-PRIVATE-TYPE", role: "assistant", content: [{type:"future-PRIVATE-PART",text:"PRIVATE"}] },
  ];
  const fields = nativeProjectionFailureFields(input, 2, 0);
  const event = structuralDiagnosticEvent({ ts: new Date().toISOString(), event: "chatgpt_tela_work",
    stage: "web_preparation_failed", ...fields });
  expect(event).toMatchObject({ input_item_count: 3, input_item_index: 2, input_part_index: 0,
    input_type_class: "unknown", input_part_type_class: "unknown", input_role_kind: "assistant",
    question_call_count: 1, question_answer_count: 1, question_relation: "matched" });
  expect(event?.input_type_fingerprint).toMatch(/^[a-f0-9]{24}$/);
  expect(JSON.stringify(event)).not.toContain("PRIVATE");
  expect(JSON.stringify(nativeProjectionPrivateShape(input, 2, 0))).not.toContain("PRIVATE QUESTION");
});

test("unrecognized structural strings are discarded at log read boundary", () => {
  const event = structuralDiagnosticEvent({ ts: new Date().toISOString(), event: "chatgpt_tela_work",
    stage: "web_preparation_failed", input_type_class: "private_type",
    question_relation: "PRIVATE CHOICE", input_container_kind: "array" });
  expect(event).toMatchObject({input_container_kind:"array"});
  expect(event).not.toHaveProperty("input_type_class");
  expect(event).not.toHaveProperty("question_relation");
});

test("projection failure evidence survives emission, disk and sanitized readback", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-projection-proof-"));
  const file = join(root, "events.jsonl");
  const old = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  try {
    const raw = [{type:"private-future-item",role:"user",content:"PRIVATE USER REQUEST"}];
    emitDiagnosticEvent("chatgpt_tela_work", "web_preparation_failed", {
      phase:"context_plan", planner_stage:"logical_projection",
      reason_class:"request_projection_input_item_type",
      ...nativeProjectionFailureFields(raw, 0), web_send_count:0,
      web_accept_count:0, local_final_committed:false,
    });
    const events = readDiagnosticTail(file).events;
    expect(events.at(-1)).toMatchObject({input_item_index:0,input_item_count:1,
      input_type_class:"unknown",input_role_kind:"user",
      planner_stage:"logical_projection",web_send_count:0,web_accept_count:0});
    expect(JSON.stringify(events)).not.toContain("PRIVATE USER REQUEST");
  } finally {
    if (old === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = old;
    rmSync(root,{recursive:true,force:true});
  }
});
