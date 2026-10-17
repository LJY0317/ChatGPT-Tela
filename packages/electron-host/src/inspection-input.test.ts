import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InspectionInput } from "./inspection-input";
import { runInNewContext } from "node:vm";
function fixture() {
  const listeners = new Map<string, (...args: any[]) => void>();
  const sent: unknown[] = []; let copied = 0; let allowed = false;
  const contents = {
    on(name: string, fn: (...args: any[]) => void) { listeners.set(name, fn); },
    removeListener(name: string) { listeners.delete(name); },
    async executeJavaScript() { return allowed; },
    sendInputEvent(input: any) {
      let blocked = false;
      listeners.get(input.type.startsWith("mouse") ? "before-mouse-event" : "before-input-event")?.({ preventDefault() { blocked = true; } }, input);
      if (!blocked) sent.push(input);
    },
    copy() { copied++; }, isDestroyed() { return false; },
  };
  const gate = new InspectionInput(contents);
  return { gate, contents, listeners, sent, allow() { allowed = true; }, get copied() { return copied; } };
}
const down = { type: "mouseDown" as const, x: 20, y: 20, button: "left" as const };
const up = { ...down, type: "mouseUp" as const };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
test("viewing proof is pending until classified, survives selection and copy, and never survives unknown or editing input", async () => {
  const f = fixture(); f.gate.setInteractive(true); f.allow();
  const observation = f.gate.observationCurrent(), strict = f.gate.current();
  f.contents.sendInputEvent(down); f.contents.sendInputEvent(up);
  expect(strict.signal.aborted).toBe(true);
  expect(f.gate.observationCurrent().pending).toBe(true);
  await flush();
  expect(f.gate.observationCurrent()).toEqual(observation);
  expect(f.sent).toEqual([down, up]);
  f.contents.sendInputEvent({type: 'keyDown', key: 'c', meta: true});
  expect(f.gate.observationCurrent()).toEqual(observation);
  f.contents.sendInputEvent({type: 'keyDown', key: 'x'});
  expect(f.gate.observationCurrent().revision).toBe(observation.revision + 1);
  f.gate.dispose(); expect(f.gate.observationCurrent().available).toBe(false);
});
test("unknown interactive clicks revoke observation before their input is released", async () => {
  const f = fixture(); f.gate.setInteractive(true);
  const before=f.gate.observationCurrent(); f.contents.sendInputEvent(down); f.contents.sendInputEvent(up);
  expect(f.sent).toHaveLength(0); await flush();
  expect(f.gate.observationCurrent().revision).toBe(before.revision+1);
  expect(f.sent).toEqual([down,up]); f.gate.dispose();
});
test.each(['disclosure','popup','missing-region','duplicate-region','editable-region'])("actual hit-test only preserves a locally linked viewing control: %s", async mode => {
  const f=fixture(); f.gate.setInteractive(true);
  const region={id:'region',querySelector:()=>mode==='editable-region'?{}:null};
  const parent={querySelectorAll:()=>[],contains:(value:unknown)=>value===region};
  const button={parentElement:parent, textContent:'public disclosure',
    closest:(selector:string)=>selector.startsWith('button')?button:null,
    hasAttribute:()=>mode==='popup', matches:()=>true,
    getAttribute:(name:string)=>name==='aria-controls'?'region':name==='aria-expanded'?'false':null};
  f.contents.executeJavaScript=async (code?:string)=>runInNewContext(code!,{
    document:{elementFromPoint:()=>button,querySelectorAll:()=>mode==='missing-region'?[]:mode==='duplicate-region'?[region,region]:[region],dispatchEvent(){}},
    Event:class {},getComputedStyle:()=>({userSelect:'text'}),
  });
  const before=f.gate.observationCurrent();
  f.contents.sendInputEvent(down); f.contents.sendInputEvent(up); await flush();
  expect(f.sent).toEqual([down,up]);
  expect(f.gate.observationCurrent().revision).toBe(before.revision+(mode==='disclosure'?0:1));
  expect(f.gate.observationCurrent().pending).toBe(false); f.gate.dispose();
});
test("viewing keyboard scrolls the main overflow pane when body has no scroll range", async () => {
  const f=fixture(); f.gate.setInteractive(false);
  class Pane { scrollHeight=800;clientHeight=800;scrollTop=0;parentElement:Pane|null=null; children:Pane[]=[];
    querySelectorAll(){return this.children;} }
  const body=new Pane(),main=new Pane(),pane=new Pane();
  pane.scrollHeight=3000; main.children=[pane];
  f.contents.executeJavaScript=async (code?:string)=>runInNewContext(code!,{
    document:{activeElement:body,body,scrollingElement:body,querySelectorAll:()=>[main]},
    HTMLElement:Pane,getComputedStyle:(node:Pane)=>({overflowY:node===pane?'auto':'visible'}),
  });
  f.contents.sendInputEvent({type:'keyDown',key:'PageDown'});await flush();
  expect(pane.scrollTop).toBe(600);expect(body.scrollTop).toBe(0); f.gate.dispose();
});
test("viewing blocks controls and keys while owned automation still passes", async () => {
  const f = fixture(); f.gate.setInteractive(false);
  f.contents.sendInputEvent(down); f.contents.sendInputEvent(up); await flush();
  expect(f.sent).toHaveLength(0);
  f.contents.sendInputEvent({ type: "keyDown", key: "Enter" }); expect(f.sent).toHaveLength(0);
  f.gate.send(down); f.gate.send(up); f.gate.send({ type: "keyDown", keyCode: "Enter" });
  expect(f.sent).toHaveLength(3);
  f.listeners.get("before-input-event")!({ preventDefault() {} }, { type: "keyDown", key: "c", meta: true });
  expect(f.copied).toBe(1);
  f.gate.dispose(); expect(f.listeners.size).toBe(0);
});
test("selection replays only one allowed gesture and mode changes invalidate pending input", async () => {
  const f = fixture(); f.allow(); f.gate.setInteractive(false);
  f.contents.sendInputEvent(down); f.contents.sendInputEvent(up); await flush();
  expect(f.sent).toEqual([down, up]);
  f.contents.sendInputEvent(down); f.gate.setInteractive(false); await flush();
  expect(f.sent).toHaveLength(2);
  f.gate.setInteractive(true); f.contents.sendInputEvent(down); await flush(); expect(f.sent).toHaveLength(3);
  f.gate.dispose();
});
test("unavailable host cannot silently claim observation mode", () => {
  const gate = new InspectionInput({ async executeJavaScript() { return false; }, isDestroyed() { return false; } });
  expect(() => gate.setInteractive(false)).toThrow("unavailable"); gate.dispose();
});

test("host input evidence survives owned input and viewing but fences external interaction and disposal", async () => {
  const f = fixture(), original = f.gate.current();
  expect(original.available).toBe(true);
  f.gate.send(down); f.gate.send(up); f.gate.send({ type: "keyDown", keyCode: "Enter" });
  expect(f.gate.current()).toEqual(original);
  f.gate.setInteractive(false); f.contents.sendInputEvent(down); await flush();
  expect(f.gate.current()).toEqual(original);
  f.gate.setInteractive(true); f.contents.sendInputEvent(down);
  expect(f.gate.current().revision).toBe(original.revision + 1);
  expect(original.signal.aborted).toBe(true);
  const second = f.gate.current();
  f.contents.sendInputEvent({ type: "keyDown", key: "Enter" });
  expect(f.gate.current().revision).toBe(original.revision + 2);
  expect(second.signal.aborted).toBe(true);
  const last=f.gate.current();
  f.gate.dispose(); expect(f.gate.current().available).toBe(false);
  expect(last.signal.aborted).toBe(true);
});

test("external input diagnostics classify keys without changing authority or recording private input", () => {
  const scratch = mkdtempSync(join(tmpdir(), "tela-input-kind-")), file = join(scratch, "events.jsonl");
  const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  try {
    const f = fixture(), original = f.gate.current();
    f.gate.setInteractive(true);
    expect(original.signal.aborted).toBe(false); // Reveal/interact alone does not revoke ownership.
    for (const key of ["Shift", "ArrowDown", "Enter", "PRIVATE_KEY", "x"]) {
      const before = f.gate.current();
      f.contents.sendInputEvent({ type: "keyDown", key });
      expect(before.signal.aborted).toBe(true);
    }
    f.contents.sendInputEvent(down);
    f.gate.dispose(); f.gate.dispose();
    const raw = readFileSync(file, "utf8"), events = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(row => row.stage === "inspection_ownership_revoked").map(row => row.kind))
      .toEqual(["modifier", "navigation", "activation", "other", "editing", "pointer"]);
    expect(events.filter(row => row.stage === "inspection_owner_disposed")).toHaveLength(1);
    expect(events.find(row => row.stage === "inspection_owner_disposed"))
      .toMatchObject({ reason_class: "surface_release", external_input_observed: true, input_revision: 6 });
    expect(raw).not.toMatch(/PRIVATE_KEY|ArrowDown|Shift|Enter/);
  } finally {
    if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
    rmSync(scratch, { recursive: true, force: true });
  }
});
