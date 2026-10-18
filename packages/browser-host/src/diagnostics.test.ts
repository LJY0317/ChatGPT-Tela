import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { diagnosticFingerprint, setPrivateDiagnosticCapture, withDiagnosticContext } from "@chatgpt-tela/core";
import { captureBrowserDiagnosticEvidence, captureBrowserDiagnosticCheckpoint, DIAGNOSTIC_DOM_CAPTURE } from "./diagnostics";
import { BROWSER_PAGE_AUTOMATION } from "./page-automation";
import { BROWSER_READ_ONLY_PREVIEW, type BrowserSurfaceLease } from "./index";
const original=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
const roots:string[]=[];
test("failure census distinguishes user markers outside, inside and on keyed groups without reading content", () => {
  const keyed = { matches(selector: string) { return selector === '[data-message-author-role="user"]'; } };
  const node = (inside: boolean) => ({ closest() { return inside ? keyed : null; }, get textContent(): never { throw Error('Prose must not be read'); } });
  const selectors: Record<string, unknown[]> = {
    '[data-turn-key]': [keyed],
    '[data-user-message-bubble]': [],
    '[data-message-author-role="user"]': [node(true)],
    '[data-conversation-role="user"]': [node(false)],
    '[data-markdown-text-style="user-message"]': [node(true), node(false)],
  };
  const result = runInNewContext(`(${DIAGNOSTIC_DOM_CAPTURE})(false)`, {
    document: { forms: [], querySelectorAll(selector: string) { return selectors[selector] ?? []; }, get documentElement(): never { throw Error('Raw capture must not run'); } },
    location: { pathname: '/c/fixture' }, performance: { getEntriesByType() { return []; } },
  });
  expect(result).toMatchObject({ keyed_turn_count: 1, user_bubble_count: 0, user_author_count: 1,
    user_author_keyed_count: 1, user_author_group_self_count: 1, user_conversation_keyed_count: 0,
    user_markdown_count: 2, user_markdown_keyed_count: 1 });
  expect(result.html).toBeUndefined();
});
afterEach(()=>{ if(original)process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=original;else delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true}); });
test("failure viewport evidence reads bounded geometry without scrolling or raw content", () => {
  const viewport={parentElement:null,scrollHeight:2000,clientHeight:600,get scrollTop(){return 1300;},set scrollTop(_value:number){throw Error('Capture must not scroll');}};
  const group={parentElement:viewport,matches(){return false;}};
  const result=runInNewContext(`(${DIAGNOSTIC_DOM_CAPTURE})(false)`,{
    document:{forms:[],querySelectorAll(selector:string){return selector==='[data-turn-key]'?[group]:[];},get documentElement(){throw Error('Raw DOM disabled');}},
    location:{pathname:'/c/fixture'},performance:{getEntriesByType(){return [];}},
    getComputedStyle(){return {overflowY:'auto'};},
  });
  expect(result).toMatchObject({turn_viewport_observed:true,turn_scroll_above_px:1300,turn_scroll_below_px:100,turn_viewport_height_px:600});
  expect(result.html).toBeUndefined();
});
test.each(["approval_anomaly", "approval_preparation_failed"] as const)("%s DOM/screenshot require opt-in and auth-safe surface; duplicate failure is coalesced",async reason=>{
  const root=mkdtempSync(join(tmpdir(),"tela-browser-diagnostics-"));roots.push(root);process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=join(root,"events.jsonl");
  let evaluations=0, previews=0;const privateFlags:unknown[]=[];let safe=true;
  const surface={taskId:"task",epochId:"epoch",leaseId:"lease",async navigate(){},async reveal(){},async hide(){},capability(cap:unknown){
    if(cap===BROWSER_PAGE_AUTOMATION)return {async evaluate(_source:string,privateCapture:unknown){evaluations++;privateFlags.push(privateCapture);return{element_count:10,capture_safe:safe,html:"<div>private conversation</div>"};}};
    if(cap===BROWSER_READ_ONLY_PREVIEW)return{async captureJpeg(){previews++;return new Uint8Array([1,2]);}};
  }} as BrowserSurfaceLease;
  const capture=(id:string)=>withDiagnosticContext({operation_fingerprint:diagnosticFingerprint(id)},()=>captureBrowserDiagnosticEvidence(surface,reason));
  await capture("off");expect(privateFlags).toEqual([false]);expect(previews).toBe(0);
  setPrivateDiagnosticCapture(join(root,"diagnostics"),1);safe=false;await capture("auth");expect(previews).toBe(0);expect(readdirSync(join(root,"diagnostics","private"))).toHaveLength(0);
  safe=true;await capture("enabled");await capture("enabled");expect(previews).toBe(1);expect(evaluations).toBe(3);expect(readdirSync(join(root,"diagnostics","private"))).toHaveLength(4);
});
test("broken diagnostic capability cannot replace the primary outcome",async()=>{
  const surface={capability(){throw new Error("broken");},taskId:"diagnostic",epochId:"epoch"} as unknown as BrowserSurfaceLease;
  await expect(captureBrowserDiagnosticEvidence(surface,"turn_failure")).resolves.toBeUndefined();
});


test("approval checkpoints stay opt-in and pending/resolution each capture at most once per operation window", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-approval-capture-")); roots.push(root);
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = join(root, "events.jsonl");
  let evaluations = 0;
  const surface = { taskId: "approval-checkpoint-test", epochId: "epoch", capability(cap: unknown) {
    if (cap === BROWSER_PAGE_AUTOMATION) return { async evaluate() { evaluations++; return { capture_safe: true, html: "<div>synthetic approval</div>" }; } };
  } } as unknown as BrowserSurfaceLease;
  await captureBrowserDiagnosticCheckpoint(surface, "approval_pending");
  expect(evaluations).toBe(0);
  setPrivateDiagnosticCapture(join(root, "diagnostics"), 1);
  await withDiagnosticContext({ operation_fingerprint: diagnosticFingerprint("approval-capture-bounds") }, async () => {
    await captureBrowserDiagnosticCheckpoint(surface, "approval_pending");
    await captureBrowserDiagnosticCheckpoint(surface, "approval_pending");
    await captureBrowserDiagnosticCheckpoint(surface, "approval_resolution");
    await captureBrowserDiagnosticCheckpoint(surface, "approval_resolution");
  });
  expect(evaluations).toBe(2);
});


test("private DOM evidence keeps the latest renderer shell beyond a large document prefix", () => {
  const clone = (html: string) => ({ attributes: [], tagName: "DIV", outerHTML: html, querySelectorAll: () => [] });
  const latest = { matches: () => false, parentElement: { parentElement: null, cloneNode: () => clone("LATEST_PRIVATE_RENDERER") } };
  const result = runInNewContext(`(${DIAGNOSTIC_DOM_CAPTURE})(true)`, {
    document: { forms: [], querySelectorAll: (selector: string) => selector === "[data-turn-key]" ? [latest] : [],
      documentElement: { cloneNode: () => clone("x".repeat(1000001)) } },
    location: { pathname: "/c/fixture" }, performance: { getEntriesByType: () => [] },
    getComputedStyle: () => ({ overflowY: "visible" }),
  });
  expect(result.html).toHaveLength(1000000);
  expect(result.html_truncated).toBe(true);
  expect(result.focus_html).toBe("LATEST_PRIVATE_RENDERER");
  expect(result.focus_html_truncated).toBe(false);
});
