import { describe, expect, test } from "bun:test";
import { ElectronWebContentsPageAutomation, type ElectronWebContentsLike } from "./page-automation";

class FakeWebContents implements ElectronWebContentsLike {
  destroyed = false;
  revision = 3;
  readonly calls: string[] = [];
  readonly inputEvents: Array<
    | {
        type: "mouseMove" | "mouseDown" | "mouseUp";
        x: number;
        y: number;
        button?: "left";
        clickCount?: number;
      }
    | {
        type: "keyDown" | "keyUp" | "char";
        keyCode: string;
        modifiers?: readonly string[];
      }
  > = [];
  pendingWait: { resolve: (value: number) => void } | undefined;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  executeJavaScript(code: string): Promise<unknown> {
    this.calls.push(code);
    if (code.includes("return state.revision")) return Promise.resolve(this.revision);
    if (code.includes("return state.wait(")) {
      const match = code.match(/state\.wait\((\d+),/);
      const after = Number(match?.[1] ?? "0");
      if (this.revision > after) return Promise.resolve(this.revision);
      return new Promise<number>(resolve => {
        this.pendingWait = { resolve };
      });
    }
    if (code.includes("state.cancel(")) {
      this.pendingWait?.resolve(this.revision);
      this.pendingWait = undefined;
      return Promise.resolve(true);
    }
    if (code.startsWith("Promise.resolve")) return Promise.resolve("evaluated");
    return Promise.resolve(undefined);
  }

  sendInputEvent(event:
    | {
        type: "mouseMove" | "mouseDown" | "mouseUp";
        x: number;
        y: number;
        button?: "left";
        clickCount?: number;
      }
    | {
        type: "keyDown" | "keyUp" | "char";
        keyCode: string;
        modifiers?: readonly string[];
      }): void {
    this.inputEvents.push(event);
  }

  mutate(): void {
    this.revision += 1;
    this.pendingWait?.resolve(this.revision);
    this.pendingWait = undefined;
  }
}

describe("Electron WebContents page automation", () => {
  test("evaluate serializes caller data instead of interpolating executable input", async () => {
    const webContents = new FakeWebContents();
    const automation = new ElectronWebContentsPageAutomation(webContents);
    const hostile = `\"); globalThis.__chatgpt_tela_pwned = true; //`;

    expect(await automation.evaluate<string, string>("function (value) { return value; }", hostile)).toBe("evaluated");
    const code = webContents.calls[0]!;
    expect(code).toContain("JSON.parse");
    expect(code).toContain("globalThis.__chatgpt_tela_pwned");
    expect(code).toContain("\\\"");
  });

  test("mutation clock returns immediately when a newer renderer revision already exists", async () => {
    const webContents = new FakeWebContents();
    const automation = new ElectronWebContentsPageAutomation(webContents);

    expect(await automation.mutationRevision()).toBe(3);
    expect(await automation.waitForDomMutation(2)).toBe(3);
  });

  test("pointer click emits one Electron mouse sequence without retry", async () => {
    const webContents = new FakeWebContents();
    const automation = new ElectronWebContentsPageAutomation(webContents);

    await automation.pointerClick({ x: 12.4, y: 45.6 });
    expect(webContents.inputEvents).toEqual([
      { type: "mouseMove", x: 12, y: 46 },
      { type: "mouseDown", x: 12, y: 46, button: "left", clickCount: 1 },
      { type: "mouseUp", x: 12, y: 46, button: "left", clickCount: 1 },
    ]);
    await expect(automation.pointerClick({ x: -1, y: 0 })).rejects.toThrow("finite non-negative");
  });

  test("focused editable cleanup uses one trusted primary-select-all and Backspace sequence", async () => {
    const webContents = new FakeWebContents();
    const automation = new ElectronWebContentsPageAutomation(webContents);
    const primary = process.platform === "darwin" ? "meta" : "control";

    await automation.clearFocusedEditable();

    expect(webContents.inputEvents).toEqual([
      { type: "keyDown", keyCode: "A", modifiers: [primary] },
      { type: "keyUp", keyCode: "A", modifiers: [primary] },
      { type: "keyDown", keyCode: "Backspace" },
      { type: "keyUp", keyCode: "Backspace" },
    ]);
  });

  test("focused editable typing emits trusted char input in order", async () => {
    const webContents = new FakeWebContents();
    const automation = new ElectronWebContentsPageAutomation(webContents);

    await automation.typeFocusedEditable("@Tela");

    expect(webContents.inputEvents).toEqual([
      { type: "keyDown", keyCode: "@" },
      { type: "char", keyCode: "@" },
      { type: "keyUp", keyCode: "@" },
      { type: "keyDown", keyCode: "T" },
      { type: "char", keyCode: "T" },
      { type: "keyUp", keyCode: "T" },
      { type: "keyDown", keyCode: "e" },
      { type: "char", keyCode: "e" },
      { type: "keyUp", keyCode: "e" },
      { type: "keyDown", keyCode: "l" },
      { type: "char", keyCode: "l" },
      { type: "keyUp", keyCode: "l" },
      { type: "keyDown", keyCode: "a" },
      { type: "char", keyCode: "a" },
      { type: "keyUp", keyCode: "a" },
    ]);
  });

  test("trusted key press emits one keyDown/keyUp pair", async () => {
    const webContents = new FakeWebContents();
    const automation = new ElectronWebContentsPageAutomation(webContents);

    await automation.pressKey("ArrowDown");

    expect(webContents.inputEvents).toEqual([
      { type: "keyDown", keyCode: "ArrowDown" },
      { type: "keyUp", keyCode: "ArrowDown" },
    ]);

    await automation.pressKey("ArrowRight");
    expect(webContents.inputEvents.slice(-2)).toEqual([
      { type: "keyDown", keyCode: "ArrowRight" },
      { type: "keyUp", keyCode: "ArrowRight" },
    ]);
  });

  test("mutation wait is event-driven and abort cleans the renderer waiter", async () => {
    const webContents = new FakeWebContents();
    const automation = new ElectronWebContentsPageAutomation(webContents);
    const controller = new AbortController();
    const waiting = automation.waitForDomMutation(3, controller.signal);
    while (!webContents.pendingWait) await Promise.resolve();

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(webContents.calls.some(code => code.includes("state.cancel("))).toBe(true);
  });

  test("a real mutation revision resolves one pending wait without polling", async () => {
    const webContents = new FakeWebContents();
    const automation = new ElectronWebContentsPageAutomation(webContents);
    const waiting = automation.waitForDomMutation(3);
    while (!webContents.pendingWait) await Promise.resolve();
    webContents.mutate();
    expect(await waiting).toBe(4);
  });

  test("destroyed WebContents fail before renderer execution", async () => {
    const webContents = new FakeWebContents();
    webContents.destroyed = true;
    const automation = new ElectronWebContentsPageAutomation(webContents);
    await expect(automation.mutationRevision()).rejects.toThrow("WebContents is destroyed");
    expect(webContents.calls).toEqual([]);
  });
});
