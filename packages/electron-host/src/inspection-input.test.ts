import { expect, test } from "bun:test";
import { InspectionInput } from "./inspection-input";
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
  f.gate.setInteractive(true); f.contents.sendInputEvent(down); expect(f.sent).toHaveLength(3);
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
