import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capturePrivateDiagnosticValue, privateDiagnosticFailureGuidance } from "./diagnostic-private";
import { diagnosticFingerprint } from "./diagnostic-events";
import { withDiagnosticContext } from "./diagnostic-context";
import { traceDiagnosticToolCall } from "./diagnostic-trace";
import { readDiagnosticTail, setPrivateDiagnosticCapture } from "./diagnostic-store";
const original = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
const roots: string[] = [];
afterEach(() => {
  if (original === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = original;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), "tela-capture-boundary-")); roots.push(root);
  const file = join(root, "events.jsonl"); process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  const center = join(root, "diagnostics"); setPrivateDiagnosticCapture(center, enabled ? 1 : 0);
  return { root, file, center };
}
const context = { request_fingerprint: diagnosticFingerprint("request"), turn_fingerprint: diagnosticFingerprint("turn") };
test("failure evidence has a correlated structural receipt while raw data stays private", () => {
  const f = fixture();
  withDiagnosticContext(context, () => capturePrivateDiagnosticValue("web_preparation_failure", { text: "PRIVATE evidence", token: "PRIVATE token" }));
  const rows = readDiagnosticTail(f.file).events;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ...context, stage: "private_capture_recorded", reason_class: "captured", phase: "web_preparation_failure" });
  expect(rows[0]?.item_fingerprint).toMatch(/^[a-f0-9]{24}$/);
  expect(rows[0]?.requested_bytes).toBeGreaterThan(0);
  expect(readFileSync(f.file, "utf8")).not.toContain("PRIVATE");
  const artifact = readdirSync(join(f.center, "private")).find(name => name.endsWith(".json") && !name.endsWith(".meta.json"))!;
  const body = readFileSync(join(f.center, "private", artifact), "utf8");
  expect(body).toContain("PRIVATE evidence"); expect(body).not.toContain("PRIVATE token");
});
test("disabled failure capture is explicit, while normal trace calls remain quiet", () => {
  const f = fixture(false);
  capturePrivateDiagnosticValue("tool_request", { text: "PRIVATE" });
  withDiagnosticContext(context, () => capturePrivateDiagnosticValue("web_preparation_failure", { text: "PRIVATE" }));
  expect(readDiagnosticTail(f.file).events).toMatchObject([{ ...context, stage: "private_capture_omitted", reason_class: "capture_disabled" }]);
  expect(readdirSync(join(f.center, "private"))).toHaveLength(0);
});
test("missing request ownership is diagnosed instead of writing unattributed raw evidence", () => {
  const f = fixture();
  capturePrivateDiagnosticValue("web_preparation_failure", { text: "PRIVATE" });
  expect(readDiagnosticTail(f.file).events).toMatchObject([{ stage: "private_capture_omitted", reason_class: "correlation_missing" }]);
  expect(readdirSync(join(f.center, "private"))).toHaveLength(0);
});
test("serialization failure cannot mask the original operation or leak its exception", () => {
  const f = fixture();
  const value = Object.defineProperty({}, "text", { enumerable: true, get() { throw new Error("PRIVATE exception"); } });
  expect(() => withDiagnosticContext(context, () => capturePrivateDiagnosticValue("web_execution_failure", value))).not.toThrow();
  expect(readDiagnosticTail(f.file).events).toMatchObject([{ ...context, stage: "private_capture_omitted", reason_class: "capture_error" }]);
  expect(readFileSync(f.file, "utf8")).not.toContain("PRIVATE");
});
test("oversized raw evidence records the byte omission without publishing content", () => {
  const f = fixture();
  withDiagnosticContext(context, () => capturePrivateDiagnosticValue("web_preparation_failure", Array(24).fill("PRIVATE".repeat(3000))));
  expect(readDiagnosticTail(f.file).events).toMatchObject([{ ...context, stage: "private_capture_omitted", reason_class: "byte_budget" }]);
  expect(readFileSync(f.file, "utf8")).not.toContain("PRIVATE");
  expect(readdirSync(join(f.center, "private"))).toHaveLength(0);
});


test("current capture settings cannot erase or certify evidence from an earlier failure", () => {
  const f=fixture();
  withDiagnosticContext(context,()=>capturePrivateDiagnosticValue("web_execution_failure",{detail:"PRIVATE prior failure"}));
  const artifacts=readdirSync(join(f.center,"private"));
  expect(artifacts.length).toBeGreaterThan(0);
  setPrivateDiagnosticCapture(f.center,0);
  const disabled=privateDiagnosticFailureGuidance(f.center);
  expect(disabled).toMatchObject({capture:"off",evidence:"unverified",reason:"current_capture_disabled"});
  expect(readdirSync(join(f.center,"private"))).toEqual(artifacts);
  setPrivateDiagnosticCapture(f.center,1);
  expect(privateDiagnosticFailureGuidance(f.center)).toMatchObject({capture:"enabled",evidence:"unverified"});
  expect(JSON.stringify(disabled)).not.toContain("PRIVATE");
});


test.each([false,true])("explicit tool error results keep failure evidence only with opt-in=%s",async enabled=>{
  const f=fixture(enabled),result={isError:true,content:[{type:"text",text:"PRIVATE tool failure"}]};
  expect(await withDiagnosticContext(context,()=>traceDiagnosticToolCall("goal_control",{}, {},async()=>result))).toBe(result);
  const metadata=readdirSync(join(f.center,"private")).filter(name=>name.endsWith(".meta.json"))
    .map(name=>JSON.parse(readFileSync(join(f.center,"private",name),"utf8")));
  expect(metadata.filter(item=>item.evidenceClass==="failure")).toHaveLength(enabled ? 1 : 0);
  expect(readDiagnosticTail(f.file).events).toContainEqual(expect.objectContaining({phase:"tool_failure",
    stage:enabled ? "private_capture_recorded" : "private_capture_omitted"}));
  expect(readFileSync(f.file,"utf8")).not.toContain("PRIVATE tool failure");
});
