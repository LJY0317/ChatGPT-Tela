import { inspectionTargetProbe } from "./inspection-diagnostics";
import type { ElectronWebContentsLike } from "./page-automation";
import { diagnosticContext, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";

type Input = Parameters<NonNullable<ElectronWebContentsLike["sendInputEvent"]>>[0];
// Closed semantic categories only; actual keys and shortcut combinations are never logged.
function keyKind(input: any): "modifier" | "navigation" | "editing" | "activation" | "other" {
  if (["Shift", "Control", "Alt", "Meta", "OS", "Super"].includes(input.key)) return "modifier";
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Tab"].includes(input.key)) return "navigation";
  if (["Enter", " ", "Space", "Escape"].includes(input.key)) return "activation";
  if (["Backspace", "Delete"].includes(input.key) || (typeof input.key === "string" && [...input.key].length === 1)) return "editing";
  return "other";
}
type Pending = { sequence: number; revision: number; down: Input; up?: Input; move?: Input };
// A frozen renderer must not keep a human's intercepted input pending forever.
// The event is discarded, not replayed or granted new request authority.
const DEFAULT_INPUT_CLASSIFICATION_DEADLINE_MS = 5_000;
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
  #pendingDeadline: ReturnType<typeof setTimeout> | undefined;
  #rendererUnresponsive = false;
  #stalledInputCount = 0;
  #interactive: boolean | undefined;
  readonly #origin = diagnosticContext();
  #inputCount = 0;
  #unownedRevision = 0;
  #observationRevision = 0;
  #scrollCount = 0;
  #classificationCount = 0;
  #pointerSequence = 0;
  #inputAbort = new AbortController();
  #invalidateInput(kind: "pointer" | "modifier" | "navigation" | "editing" | "activation" | "other", sequence = 0): void {
    this.#unownedRevision++;
    if (this.#unownedRevision <= 16) withDiagnosticContext(this.#origin, () =>
      emitDiagnosticEvent("chatgpt_tela_browser", "inspection_ownership_revoked", { input_revision: this.#unownedRevision, kind, interactive: !this.#observing, input_sequence: sequence,
        observation_revision: this.#observationRevision }));
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
  constructor(readonly contents: Emitter, readonly classificationDeadlineMs = DEFAULT_INPUT_CLASSIFICATION_DEADLINE_MS) {
    if (!Number.isSafeInteger(classificationDeadlineMs) || classificationDeadlineMs < 1
      || classificationDeadlineMs > 30_000) throw new Error("invalid input classification deadline");
    contents.on?.("before-mouse-event", this.mouse);
    contents.on?.("before-input-event", this.key);
    contents.on?.("did-start-navigation", this.documentChanged);
    contents.on?.("render-process-gone", this.documentChanged);
    contents.on?.("unresponsive", this.rendererUnresponsive);
    contents.on?.("responsive", this.rendererResponsive);
  }
  setInteractive(interactive: boolean): void {
    if (this.#disposed || !this.contents.on || !this.contents.removeListener) {
      throw new Error("browser inspection input controls are unavailable");
    }
    this.#observing = !interactive;
    if (this.#interactive !== interactive) {
      const previous = this.#interactive;
      this.#interactive = interactive;
      withDiagnosticContext(this.#origin, () => emitDiagnosticEvent("chatgpt_tela_browser", "inspection_mode_changed", {
        interactive, previous_mode_known: previous !== undefined, previous_interactive: previous === true,
        input_revision: this.#revision + 1, pending_input: !!this.#pending,
        ownership_revision: this.#unownedRevision, observation_revision: this.#observationRevision,
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
    this.#clearPendingDeadline();
    this.#revision++; this.#pending = undefined; this.#selecting = false;
    if (pending) this.#notifyObservationSettled();
  }
  #clearPendingDeadline(): void {
    if (this.#pendingDeadline !== undefined) {
      clearTimeout(this.#pendingDeadline);
      this.#pendingDeadline = undefined;
    }
  }
  rendererUnresponsive = (): void => {
    this.#rendererUnresponsive = true;
    if (!this.#pending) return;
    // The event was prevented before any renderer delivery. An unresponsive
    // renderer cannot safely classify/replay it, now or after recovery.
    this.#clearPendingDeadline();
    this.#pending = undefined;
    this.#selecting = false;
    withDiagnosticContext(this.#origin, () => emitDiagnosticEvent("chatgpt_tela_browser",
      "inspection_input_classification_unavailable", {
        reason_class: "renderer_unresponsive", input_replayed: false, ownership_revoked: false,
      }));
  };
  rendererResponsive = (): void => {
    if (!this.#rendererUnresponsive) return;
    this.#rendererUnresponsive = false;
    this.#notifyObservationSettled();
  };
  send = (input: Input): void => {
    if (this.#disposed || !this.contents.sendInputEvent) throw new Error("owned browser input is unavailable");
    const previous = this.#owned;
    this.#owned = true;
    try { this.contents.sendInputEvent(input); } finally { this.#owned = previous; }
  };
  mouse = (event: { preventDefault(): void }, input: any): void => {
    if (!this.#owned && this.#rendererUnresponsive) {
      event.preventDefault();
      if (input.type === "mouseDown" && ++this.#stalledInputCount <= 16) {
        withDiagnosticContext(this.#origin, () => emitDiagnosticEvent("chatgpt_tela_browser",
          "inspection_input_classification_unavailable", {
            reason_class: "renderer_unresponsive", input_replayed: false, ownership_revoked: false,
          }));
      }
      return;
    }
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
    const pending = { sequence: ++this.#pointerSequence, revision: this.#revision, down: input } as Pending;
    this.#pending = pending;
    this.#pendingDeadline = setTimeout(() => {
      if (this.#pending !== pending) return;
      this.#pendingDeadline = undefined;
      this.#pending = undefined;
      this.#selecting = false;
      // The intercepted click was never delivered. Preserve the accepted
      // request witness; on renderer recovery the person may click afresh.
      withDiagnosticContext(this.#origin, () => emitDiagnosticEvent("chatgpt_tela_browser",
        "inspection_input_classification_unavailable", {
          reason_class: "renderer_timeout", input_replayed: false,
          ownership_revoked: false, input_sequence: pending.sequence, deadline_ms: this.classificationDeadlineMs,
        }));
      this.#notifyObservationSettled();
    }, this.classificationDeadlineMs);
    this.#pendingDeadline.unref?.();
    // One hit test per selection gesture, no pointer-move queries or idle polling.
    const code = `(() => {
      const hit = document.elementFromPoint(${input.x}, ${input.y});
      let reason = 'unclassified';
      const decide = (value, category) => { reason = category; return value; };
      const classify = () => {
        let node = hit;
        if (!node) return decide(false, 'missing_hit');
        const approval = globalThis[Symbol.for('chatgpt-tela.approval-observations.v1')];
        if (approval?.manualInputTarget?.(node) === true) return decide('manual-consent', 'manual_consent');
        const button = node.closest('button[aria-expanded]');
        if (button && !button.hasAttribute('aria-haspopup')
          && !button.closest('form,[contenteditable]:not([contenteditable="false"])')) {
          const id = button.getAttribute('aria-controls');
          const local = button.parentElement;
          const localIds = [...(local?.querySelectorAll('[id]') || [])];
          if (localIds.length > 256) return decide(false, 'local_region_budget');
          const labels = localIds
            .filter(item => item.id === button.getAttribute('aria-labelledby'));
          const ids = id ? [...document.querySelectorAll('[id]')] : [];
          if (ids.length > 2048) return decide(false, 'region_budget');
          const regions = ids.filter(item => item.id === id);
          // Authored-message disclosures may have no aria-controls/labelledby.
          // Their copy-excluded control only reveals the local, non-editable author root.
          const authorRoots = button.getAttribute('data-markdown-copy') === 'exclude'
            && button.closest('[data-user-message-bubble]')
            ? [...(local?.querySelectorAll('[data-search-result-target]') || [])] : [];
          const region = id ? (regions.length === 1 ? regions[0] : undefined)
            : labels.length === 1 && local?.querySelectorAll('button[aria-expanded]').length === 1 ? local
              : authorRoots.length === 1 ? authorRoots[0] : undefined;
          const expanded = button.getAttribute('aria-expanded');
          if (region && button.parentElement?.contains(region) && ['true','false'].includes(expanded)
            && !region.querySelector('form,input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return decide(true, 'linked_disclosure');
        }
        for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor.matches('a,button,input,textarea,select,summary,label,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="tab"],[role="menuitem"],[tabindex]') || ancestor.onclick || ancestor.onmousedown) return decide(false, 'interactive_control');
        }
        const selectable = !!node.textContent?.trim() && getComputedStyle(node).userSelect !== 'none';
        return decide(selectable, selectable ? 'text_selection' : 'nonselectable');
      };
      const allowed = classify();
      let nodes = [], probeAvailable = true;
      try { nodes = (${inspectionTargetProbe.toString()})(hit); } catch { probeAvailable = false; }
      return { allowed, reason, nodes, probeAvailable };
    })()`;
    let dispatchStarted = false, dispatchedCount = 0;
    const ownershipRevision = this.#unownedRevision;
    void this.contents.executeJavaScript(code).then(value => {
      const result = value as { allowed: boolean | "manual-consent"; reason?: string;
        nodes?: Record<string, string | number | boolean>[]; probeAvailable?: boolean };
      const allowed = result.allowed;
      if (this.#pending !== pending || pending.revision !== this.#revision || observing !== this.#observing) return;
      // Unknown/editing interactions still revoke before their first
      // replayed input. 'manual-consent' is recognized by the current
      // renderer and checked against the exact still-visible card on
      // every gesture; it is not general permission to edit the request.
      if (!observing && allowed !== 'manual-consent') this.#invalidateInput("pointer", pending.sequence);
      if (++this.#classificationCount <= 16) withDiagnosticContext(this.#origin, () => {
        emitDiagnosticEvent('chatgpt_tela_browser', 'inspection_input_classified', {
          input_sequence: pending.sequence, input_revision: pending.revision,
          reason_class: ["missing_hit", "manual_consent", "local_region_budget", "region_budget", "linked_disclosure", "interactive_control", "text_selection", "nonselectable"].includes(result.reason ?? "") ? result.reason! : "unclassified",
          probe_available: result.probeAvailable === true,
          viewing_proven: allowed === true, manual_consent: allowed === 'manual-consent', interactive: !observing,
          observation_revision: this.#observationRevision + (allowed === true || allowed === 'manual-consent' || observing ? 0 : 1),
        });
        for (const node of result.nodes ?? []) emitDiagnosticEvent('chatgpt_tela_browser', 'inspection_target_observed', {
          input_sequence: pending.sequence, ...node,
        });
      });
      if (allowed !== true && allowed !== 'manual-consent') {
        if (observing) return;
        this.#observationRevision++;
      }
      dispatchStarted = true;
      this.send(pending.down); dispatchedCount++;
      if (pending.move) { this.send(pending.move); dispatchedCount++; }
      if (pending.up) { this.send(pending.up); dispatchedCount++; }
      else this.#selecting = true;
      if (this.#classificationCount <= 16) withDiagnosticContext(this.#origin, () =>
        emitDiagnosticEvent('chatgpt_tela_browser', 'inspection_input_dispatched', {
          input_sequence: pending.sequence, event_count: dispatchedCount,
          viewing_proven: allowed === true, manual_consent: allowed === 'manual-consent',
          observation_revision: this.#observationRevision, ownership_revision: this.#unownedRevision,
        }));
    }).catch(() => {
      if (this.#pending !== pending) return;
      // A failed *read-only* hit test did not send the intercepted gesture.
      // Unknown input is not an edit if it was never delivered.
      withDiagnosticContext(this.#origin, () => emitDiagnosticEvent("chatgpt_tela_browser",
        "inspection_input_classification_unavailable", {
          reason_class: dispatchStarted ? "input_dispatch_failed" : "renderer_rejected",
          input_sequence: pending.sequence, dispatch_started: dispatchStarted,
          input_replayed: dispatchedCount > 0, dispatch_uncertain: dispatchStarted,
          ownership_revoked: this.#unownedRevision !== ownershipRevision,
        }));
    })
      .finally(() => {
        if (this.#pending !== pending) return;
        this.#clearPendingDeadline();
        this.#pending = undefined;
        // Wake the existing renderer clock even when selection causes no DOM mutation.
        this.#notifyObservationSettled();
      });
  };
  key = (event: { preventDefault(): void }, input: any): void => {
    if (!this.#owned && this.#rendererUnresponsive) {
      event.preventDefault();
      return;
    }
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
  documentChanged = (): void => { this.#rendererUnresponsive = false; this.reset(); };
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
    this.contents.removeListener?.("unresponsive", this.rendererUnresponsive);
    this.contents.removeListener?.("responsive", this.rendererResponsive);
  }
}
