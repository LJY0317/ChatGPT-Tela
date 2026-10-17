import type { ElectronWebContentsLike } from "./page-automation";
import { diagnosticContext, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";

type Input = Parameters<NonNullable<ElectronWebContentsLike["sendInputEvent"]>>[0];
// Closed semantic categories only; actual keys and shortcut combinations are never logged.
function keyKind(input: any): "modifier" | "navigation" | "editing" | "activation" | "other" {
  if (["Shift", "Control", "Alt", "Meta", "OS", "Super"].includes(input.key)) return "modifier";
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(input.key)) return "navigation";
  if (["Enter", " ", "Space", "Tab", "Escape"].includes(input.key)) return "activation";
  if (["Backspace", "Delete"].includes(input.key) || (typeof input.key === "string" && [...input.key].length === 1)) return "editing";
  return "other";
}
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
  #unownedRevision = 0;
  #observationRevision = 0;
  #scrollCount = 0;
  #classificationCount = 0;
  #inputAbort = new AbortController();
  #invalidateInput(kind: "pointer" | "modifier" | "navigation" | "editing" | "activation" | "other"): void {
    this.#unownedRevision++;
    if (this.#unownedRevision <= 16) withDiagnosticContext(this.#origin, () =>
      emitDiagnosticEvent("chatgpt_tela_browser", "inspection_ownership_revoked", { input_revision: this.#unownedRevision, kind, interactive: !this.#observing }));
    this.#inputAbort.abort(new Error("browser input ownership changed"));
    this.#inputAbort = new AbortController();
  }
  current(): { readonly revision: number; readonly available: boolean; readonly signal: AbortSignal } {
    return { revision: this.#unownedRevision, signal: this.#inputAbort.signal, available: !this.#disposed
      && !!this.contents.on && !!this.contents.removeListener && !!this.contents.sendInputEvent };
  }
  observationCurrent() {
    return { revision: this.#observationRevision, available: this.current().available, pending: !!this.#pending };
  }
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
  #notifyObservationSettled(): void {
    if (!this.#disposed) void this.contents.executeJavaScript(
      `document.dispatchEvent(new Event('chatgpt-tela-inspection-settled'))`).catch(() => {});
  }
  reset(): void {
    const pending = !!this.#pending;
    this.#revision++; this.#pending = undefined; this.#selecting = false;
    if (pending) this.#notifyObservationSettled();
  }
  send = (input: Input): void => {
    if (this.#disposed || !this.contents.sendInputEvent) throw new Error("owned browser input is unavailable");
    const previous = this.#owned;
    this.#owned = true;
    try { this.contents.sendInputEvent(input); } finally { this.#owned = previous; }
  };
  mouse = (event: { preventDefault(): void }, input: any): void => {
    // A click cannot be declared foreign before its current card-local
    // target is classified. In particular, a verified manual one-shot
    // consent must preserve the original accepted request's causal fence.
    // While the hit test is pending, observationCurrent().pending prevents
    // any Web answer or tool continuation from crossing that boundary.
    if (!this.#owned && !this.#observing && input.type === "mouseDown"
      && (input.button !== "left" || !Number.isFinite(input.x) || !Number.isFinite(input.y))) {
      this.#invalidateInput("pointer");
    }
    if (input.type === "mouseDown") this.#recordInput("pointer_activation");
    if (this.#owned) return;
    if (input.type === "mouseWheel") return;
    if (input.type === "mouseMove" && !this.#pending) return;
    if (input.type === "mouseUp" && this.#selecting) { this.#selecting = false; return; }
    if (this.#pending) {
      event.preventDefault();
      if (input.type === "mouseUp") this.#pending.up = input;
      if (input.type === "mouseMove") this.#pending.move = input;
      return;
    }
    if (!this.#observing && input.type !== "mouseDown") return;
    event.preventDefault();
    if (input.type !== "mouseDown" || input.button !== "left"
      || !Number.isFinite(input.x) || !Number.isFinite(input.y)) {
      if (!this.#observing) { this.#observationRevision++; this.send(input); }
      return;
    }
    const observing = this.#observing;
    const pending = { revision: this.#revision, down: input } as Pending;
    this.#pending = pending;
    // One hit test per selection gesture, no pointer-move queries or idle polling.
    const code = `(() => {
      let node = document.elementFromPoint(${input.x}, ${input.y});
      if (!node) return false;
      const approval = globalThis[Symbol.for('chatgpt-tela.approval-observations.v1')];
      if (approval?.manualInputTarget?.(node) === true) return 'manual-consent';
      const button = node.closest('button[aria-expanded]');
      if (button && !button.hasAttribute('aria-haspopup')
        && !button.closest('form,[contenteditable]:not([contenteditable="false"])')) {
        const id = button.getAttribute('aria-controls');
        const local = button.parentElement;
        const localIds = [...(local?.querySelectorAll('[id]') || [])];
        if (localIds.length > 256) return false;
        const labels = localIds
          .filter(item => item.id === button.getAttribute('aria-labelledby'));
        const ids = id ? [...document.querySelectorAll('[id]')] : [];
        if (ids.length > 2048) return false;
        const regions = ids.filter(item => item.id === id);
        const region = id ? (regions.length === 1 ? regions[0] : undefined)
          : labels.length === 1 && local?.querySelectorAll('button[aria-expanded]').length === 1 ? local : undefined;
        const expanded = button.getAttribute('aria-expanded');
        if (region && button.parentElement?.contains(region) && ['true','false'].includes(expanded)
          && !region.querySelector('form,input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return true;
      }
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.matches('a,button,input,textarea,select,summary,label,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="tab"],[role="menuitem"],[tabindex]') || ancestor.onclick || ancestor.onmousedown) return false;
      }
      return !!node.textContent?.trim() && getComputedStyle(node).userSelect !== 'none';
    })()`;
    void this.contents.executeJavaScript(code).then(allowed => {
      if (this.#pending !== pending || pending.revision !== this.#revision || observing !== this.#observing) return;
      // Unknown/editing interactions still revoke before their first
      // replayed input. 'manual-consent' is recognized by the current
      // renderer and checked against the exact still-visible card on
      // every gesture; it is not general permission to edit the request.
      if (!observing && allowed !== 'manual-consent') this.#invalidateInput("pointer");
      if (++this.#classificationCount <= 16) withDiagnosticContext(this.#origin, () =>
        emitDiagnosticEvent('chatgpt_tela_browser', 'inspection_input_classified', {
          viewing_proven: allowed === true, manual_consent: allowed === 'manual-consent', interactive: !observing,
          observation_revision: this.#observationRevision + (allowed === true || allowed === 'manual-consent' || observing ? 0 : 1),
        }));
      if (allowed !== true && allowed !== 'manual-consent') {
        if (observing) return;
        this.#observationRevision++;
      }
      this.send(pending.down);
      if (pending.move) this.send(pending.move);
      if (pending.up) this.send(pending.up);
      else this.#selecting = true;
    }).catch(() => { if (!observing) this.#observationRevision++; })
      .finally(() => {
        if (this.#pending !== pending) return;
        this.#pending = undefined;
        // Wake the existing renderer clock even when selection causes no DOM mutation.
        this.#notifyObservationSettled();
      });
  };
  key = (event: { preventDefault(): void }, input: any): void => {
    if (!this.#owned && !this.#observing && input.type === "keyDown") {
      const copy = (input.meta || input.control) && !input.alt && !input.shift && input.key?.toLowerCase() === 'c';
      const kind = keyKind(input);
      // Pure navigation, modifiers and copy do not edit the accepted
      // request. Any activating/editing/unknown key still revokes.
      if (!copy && !['modifier', 'navigation'].includes(kind)) {
        this.#invalidateInput(kind);
        this.#observationRevision++;
      }
    }
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
      const scrollable = node => node instanceof HTMLElement && node.clientHeight > 0 && node.scrollHeight > node.clientHeight
        && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY);
      let node = document.activeElement;
      while (node && node !== document.body && !scrollable(node)) node = node.parentElement;
      const stack = [...document.querySelectorAll('main,[role="main"]')].slice(0,8), panes = [];
      let inspected = 0;
      while (stack.length && inspected++ < 2048) {
        const candidate = stack.shift();
        if (scrollable(candidate)) panes.push(candidate);
        for (const child of [...candidate.children].slice(0,2048-stack.length)) stack.push(child);
      }
      const target = scrollable(node) ? node : panes.sort((a,b) => b.clientHeight-a.clientHeight)[0] || document.scrollingElement;
      if (target) ${distance === "top" ? "target.scrollTop = 0" : distance === "bottom" ? "target.scrollTop = target.scrollHeight" : `target.scrollTop += ${distance}`};
      return { available: !!target, above: Math.max(0,Math.round(target?.scrollTop || 0)),
        below: Math.max(0,Math.round((target?.scrollHeight || 0)-(target?.clientHeight || 0)-(target?.scrollTop || 0))) };
    })()`).then(value => {
      if (++this.#scrollCount > 16 || !value || typeof value !== 'object') return;
      const result = value as {available?: boolean; above?: number; below?: number};
      withDiagnosticContext(this.#origin, () => emitDiagnosticEvent('chatgpt_tela_browser', 'inspection_scroll_observed', {
        target_available: result.available === true, above_px: result.above ?? 0, below_px: result.below ?? 0,
      }));
    }).catch(() => {});
  };
  documentChanged = (): void => { this.reset(); };
  dispose(): void {
    if (this.#disposed) return;
    withDiagnosticContext(this.#origin, () => emitDiagnosticEvent("chatgpt_tela_browser", "inspection_owner_disposed", {
      reason_class: "surface_release", input_revision: this.#unownedRevision, interactive: !this.#observing,
      external_input_observed: this.#unownedRevision > 0,
    }));
    this.#inputAbort.abort(new Error("browser input owner disposed"));
    this.#disposed = true; this.reset();
    this.contents.removeListener?.("before-mouse-event", this.mouse);
    this.contents.removeListener?.("before-input-event", this.key);
    this.contents.removeListener?.("did-start-navigation", this.documentChanged);
    this.contents.removeListener?.("render-process-gone", this.documentChanged);
  }
}
