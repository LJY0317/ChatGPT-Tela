import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeWorkIncident } from "./work-incident";

describe("Work structural incident inspection", () => {
  test("shows a bounded failure timeline while refusing payloads, paths, and arbitrary fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "tela-work-incident-"));
    const path = join(directory, "diagnostics.jsonl");
    const nowMs = Date.parse("2026-09-29T12:00:00.000Z");
    try {
      writeFileSync(path, [
        { ts: "2026-09-29T11:59:58.000Z", event: "chatgpt_tela_work", stage: "web_turn_plan", logical_estimate: 123, prompt: "private prompt", path: "/private/repo" },
        { ts: "2026-09-29T11:59:59.000Z", event: "chatgpt_tela_work", stage: "web_turn_timeout", duration_ms: 42, deadline_ms: 25, turn_phase: "accepted", operation_fingerprint: "a".repeat(24), tool_pending: false, output: "private output", arbitrary: "private token" },
        { ts: "2026-09-29T12:00:00.000Z", event: "chatgpt_tela_chat", stage: "capability_call_complete", result_bytes: 99 },
      ].map(value => JSON.stringify(value)).join("\n"));
      const result = summarizeWorkIncident({ paths: [path], mode: "incident", nowMs });
      expect(result.status).toBe("ready");
      expect(result.observedEvents).toBe(2);
      expect(result.timeline).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain("private");
      expect(JSON.stringify(result)).not.toContain(directory);
      expect(JSON.stringify(result)).toContain('"logical_estimate":123');
      expect(JSON.stringify(result)).toContain('"turn_phase":"accepted"');
      expect(JSON.stringify(result)).toContain('"operation_fingerprint":"' + "a".repeat(24) + '"');
      expect(JSON.stringify(result)).toContain('"deadline_ms":25');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("absence of a failure is reported as unobserved and trace remains on demand", () => {
    const directory = mkdtempSync(join(tmpdir(), "tela-work-trace-"));
    const path = join(directory, "diagnostics.jsonl");
    const nowMs = Date.parse("2026-09-29T12:00:00.000Z");
    try {
      writeFileSync(path, `${JSON.stringify({ ts: new Date(nowMs).toISOString(), event: "chatgpt_tela_work", stage: "web_turn_plan", retained_surface: true })}\n`);
      expect(summarizeWorkIncident({ paths: [path], mode: "incident", nowMs }).status).toBe("not-observed");
      const trace = summarizeWorkIncident({ paths: [path], mode: "trace", nowMs });
      expect(trace.timeline).toHaveLength(1);
      expect(trace.mutating).toBe(false);
      expect(() => summarizeWorkIncident({ paths: [path], mode: "trace", minutes: 121, nowMs })).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

test("model delivery and lifecycle fields remain available to Work incident analysis",()=>{
 const directory=mkdtempSync(join(tmpdir(),"tela-catalog-incident-"));const path=join(directory,"diagnostics.jsonl");const nowMs=Date.parse("2026-10-06T00:00:00Z");
 try{writeFileSync(path,JSON.stringify({ts:new Date(nowMs).toISOString(),event:"chatgpt_tela_codex",stage:"desktop_catalog_delivery_failed",connection_fingerprint:"b".repeat(24),kind:"external_client",status:"client_closed",web_model_count:3,native_model_count:8,hidden_web_model_count:0,include_hidden:true,pending_count:1,phase:"connecting",raw_model:"private-model",raw_error:"private-error"})+'\n');
  const result=summarizeWorkIncident({paths:[path],mode:"incident",nowMs});const text=JSON.stringify(result);expect(text).toContain('"web_model_count":3');expect(text).toContain('"kind":"external_client"');expect(text).toContain('"status":"client_closed"');expect(text).toContain('"phase":"connecting"');expect(text).toContain('"connection_fingerprint":"'+"b".repeat(24)+'"');expect(text).not.toContain("private");
 }finally{rmSync(directory,{recursive:true,force:true});}
});
