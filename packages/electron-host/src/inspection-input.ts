import type { ElectronWebContentsLike } from "./page-automation";
import { diagnosticContext, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";

type Input = Parameters<NonNullable<ElectronWebContentsLike["sendInputEvent"]>>[0];
type Pending = { revision: number; down: Input; up?: Input; move?: Input };
type Emitter = ElectronWebContentsLike & {
  on?: (name: string, listener: (...args: any[]) => void) => void;
  removeListener?: (name: string, listener: (...args: any[]) => void) => void;
  copy?: () => void;
};

/** Visibility controls are convenience protection, never request/conversation authority. */
export class InspectionInput {
  #observing = false;
  #owned = false;
  #disposed = false;
  #revision = 0;
  #selecting = false;
  #pending: Pending | undefined;
  #interactive: boolean | undefined;
  readonly #origin = diagnosticContext();
  #inputCount = 0;
  #recordInput(kind: "pointer_activation" | "key_activation"): void {
    if (++this.#inputCount > 64) return;
    withDiagnosticContext(this.#origin, () => emitDiagnosticEvent("chatgpt_tela_browser", "inspection_input_observed", {
      kind, owned_input: this.#owned, interactive: !this.#observing,
      input_revision: this.#revision, input_count: this.#inputCount,
    }));
  }
  constructor(readonly contents: Emitter) {
    contents.on?.("before-mouse-event", this.mouse);
    contents.on?.("before-input-event", this.key);
    contents.on?.("did-start-navigation", this.documentChanged);
    contents.on?.("render-process-gone", this.documentChanged);
  }
  setInteractive(interactive: boolean): void {
    if (this.#disposed || !this.contents.on || !this.contents.removeListener) {
      throw new Error("browser inspection input controls are unavailable");
    }
    this.#observing = !interactive;
    if (this.#interactive !== interactive) {
      this.#interactive = interactive;
      withDiagnosticContext(this.#origin, () => emitDiagnosticEvent("chatgpt_tela_browser", "inspection_mode_changed", {
        interactive, input_revision: this.#revision + 1,
      }));
    }
    this.reset();
  }
  reset(): void { this.#revision++; this.#pending = undefined; this.#selecting = false; }
  send = (input: Input): void => {
    if (this.#disposed || !this.contents.sendInputEvent) throw new Error("owned browser input is unavailable");
    const previous = this.#owned;
    this.#owned = true;
    try { this.contents.sendInputEvent(input); } finally { this.#owned = previous; }
  };
  mouse = (event: { preventDefault(): void }, input: any): void => {
    if (input.type === "mouseDown") this.#recordInput("pointer_activation");
    if (!this.#observing || this.#owned) return;
    if (input.type === "mouseWheel") return;
    if (input.type === "mouseMove" && !this.#pending) return;
    if (input.type === "mouseUp" && this.#selecting) { this.#selecting = false; return; }
    event.preventDefault();
    if (this.#pending) {
      if (input.type === "mouseUp") this.#pending.up = input;
      if (input.type === "mouseMove") this.#pending.move = input;
      return;
    }
    if (input.type !== "mouseDown" || input.button !== "left"
      || !Number.isFinite(input.x) || !Number.isFinite(input.y)) return;
    const pending = { revision: this.#revision, down: input } as Pending;
    this.#pending = pending;
    // One hit test per selection gesture, no pointer-move queries or idle polling.
    const code = `(() => {
      let node = document.elementFromPoint(${input.x}, ${input.y});
      if (!node) return false;
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.matches('a,button,input,textarea,select,summary,label,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="tab"],[role="menuitem"],[tabindex]') || ancestor.onclick || ancestor.onmousedown) return false;
      }
      return !!node.textContent?.trim() && getComputedStyle(node).userSelect !== 'none';
    })()`;
    void this.contents.executeJavaScript(code).then(allowed => {
      if (this.#pending !== pending || pending.revision !== this.#revision || !this.#observing || allowed !== true) return;
      this.send(pending.down);
      if (pending.move) this.send(pending.move);
      if (pending.up) this.send(pending.up);
      else this.#selecting = true;
    }).catch(() => {}).finally(() => { if (this.#pending === pending) this.#pending = undefined; });
  };
  key = (event: { preventDefault(): void }, input: any): void => {
    if (input.type === "keyDown") this.#recordInput("key_activation");
    if (!this.#observing || this.#owned) return;
    event.preventDefault();
    if (input.type !== "keyDown") return;
    if ((input.meta || input.control) && !input.alt && !input.shift && input.key?.toLowerCase() === "c") {
      this.contents.copy?.(); return;
    }
    if (input.meta || input.control || input.alt) return;
    const distances: Record<string, number | "top" | "bottom"> = {
      ArrowDown: 40, ArrowUp: -40, PageDown: 600, PageUp: -600, Home: "top", End: "bottom",
    };
    const distance = distances[input.key];
    if (distance === undefined) return;
    // Scroll the focused pane/element without activating focused links or controls.
    void this.contents.executeJavaScript(`(() => {
      let node = document.activeElement;
      while (node && node !== document.body && node.scrollHeight <= node.clientHeight) node = node.parentElement;
      const target = node && node !== document.body ? node : document.scrollingElement;
      if (target) ${distance === "top" ? "target.scrollTop = 0" : distance === "bottom" ? "target.scrollTop = target.scrollHeight" : `target.scrollTop += ${distance}`};
    })()`).catch(() => {});
  };
  documentChanged = (): void => { this.reset(); };
  dispose(): void {
    this.#disposed = true; this.reset();
    this.contents.removeListener?.("before-mouse-event", this.mouse);
    this.contents.removeListener?.("before-input-event", this.key);
    this.contents.removeListener?.("did-start-navigation", this.documentChanged);
    this.contents.removeListener?.("render-process-gone", this.documentChanged);
  }
}
