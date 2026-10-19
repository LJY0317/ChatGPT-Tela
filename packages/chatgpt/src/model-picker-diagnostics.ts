import { BROWSER_DOCUMENT_LIFETIME, BROWSER_INPUT_OWNERSHIP, BROWSER_PAGE_AUTOMATION, captureBrowserDiagnosticEvidence, type BrowserPageAutomation, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { capturePrivateDiagnosticValue, diagnosticFailureFields, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";

/** Match only Tela-owned error vocabulary; exception prose stays in opt-in private evidence. */
export function modelPickerFailureReason(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "unknown";
    const message = error.message;
    const exact: Readonly<Record<string, string>> = {
      "ChatGPT model picker returned invalid control counts": "invalid_control_counts",
      "ChatGPT model picker returned an invalid effort slider": "invalid_effort_range",
      "ChatGPT model picker has no unique advanced-family trigger": "advanced_trigger_ambiguous",
      "ChatGPT model picker advanced transition was not confirmed": "advanced_transition_unconfirmed",
      "ChatGPT model picker exposes no model family rows": "family_rows_missing",
      "ChatGPT model picker exposes duplicate model families": "family_rows_duplicated",
      "ChatGPT model picker does not expose exactly one selected family": "selected_family_ambiguous",
      "ChatGPT model picker exposes no effort slider": "effort_slider_missing",
      "ChatGPT model picker effort tick count is ambiguous": "effort_ticks_ambiguous",
      "ChatGPT model picker did not commit the selected family row after bounded activation fallbacks": "family_selection_uncommitted",
      "ChatGPT model effort selection did not commit": "effort_selection_uncommitted",
      "ChatGPT model discovery could not restore the original effort": "original_effort_unrestored",
      "ChatGPT model discovery original effort is unsupported": "original_effort_unsupported",
      "ChatGPT model family label must be non-empty": "family_label_empty",
      "selected ChatGPT Web model family disappeared before trusted-pointer fallback": "family_disappeared",
      "Web model discovery is incomplete": "catalog_empty",
      "ChatGPT model picker has no current family/effort selection": "current_selection_missing",
      "ChatGPT model picker current effort is outside the supported semantic range": "current_effort_unsupported",
      "ChatGPT model family/effort readback did not converge on the requested Web route": "selection_readback_mismatch",
      "ChatGPT model selection canary restoration readback did not match the original mode": "canary_restoration_mismatch",
      "ChatGPT model selection canary could not prove the original family/effort in the live catalog": "canary_original_unproven",
      "ChatGPT model picker effort tick is missing": "effort_tick_missing",
      "browser surface does not expose page automation for ChatGPT model selection": "page_automation_missing",
    };
    if (Object.hasOwn(exact, message)) return exact[message]!;
    if (/^ChatGPT model picker activation failed \([a-z-]+(?::\d+)?\)$/.test(message)) return "activation_rejected";
    if (/^ChatGPT model picker timed out waiting for [a-z-]+$/.test(message)) return "picker_wait_timeout";
    if (/^ChatGPT model family does not (?:expose|allow) effort (?:low|medium|high|xhigh|max)$/.test(message)) return "effort_unavailable";
    if (/^ChatGPT effort slider did not move exactly one step toward (?:low|medium|high|xhigh|max)$/.test(message)) return "effort_step_uncommitted";
    const code = (error as Error & { code?: unknown }).code;
    if (code === "tela_web_model_unavailable") return "family_unavailable";
    if (code === "tela_web_model_picker_control_unavailable") return "model_picker_control_unavailable";
    return diagnosticFailureFields(error).reason_class;
  } catch { return "unknown"; }
}

type Fields = Record<string, number | boolean | string>;
interface Snapshot {
  readonly controlCount: number; readonly controlOpen: boolean; readonly menuCount: number;
  readonly controlPoint?: unknown; readonly advancedPoint?: unknown; readonly view?: string;
  readonly structure?: { composerCount: number; composerFormPresent: boolean; globalControlCount: number; formButtonCount: number };
  readonly families: readonly { label: string; checked: boolean; disabled: boolean; point?: unknown }[];
  readonly slider?: { min: number; max: number; value: number; power: boolean; ticks: readonly { locked: boolean | null; selected: boolean }[] };
  readonly diagnostic?: Readonly<Record<string, number | boolean>>;
}

/** One operation owns its trace; no shared page state, polling, retries or extra UI activation. */
export class ModelPickerDiagnostics {
  phase = "initial";
  restoration = false;
  #lastFields?: Fields;
  #lastShape?: string;
  #observations = 0;
  #actions = 0;
  #captured = false;
  #reported = new Set<unknown>();
  constructor(readonly page: BrowserPageAutomation, readonly surface: BrowserSurfaceLease) {}
  step(phase: string): void {
    if (phase === this.phase) return;
    this.phase = phase;
    emitDiagnosticEvent("chatgpt_tela_work", "web_model_picker_step", { phase, restoration: this.restoration });
  }
  snapshot(snapshot: Snapshot): void {
    this.#observations++;
    const fields = this.#shape(snapshot);
    this.#lastFields = fields;
    const shape = JSON.stringify(fields);
    if (shape === this.#lastShape) return;
    this.#lastShape = shape;
    emitDiagnosticEvent("chatgpt_tela_work", "web_model_picker_observed", { phase: this.phase, restoration: this.restoration, ...fields });
  }
  #shape(snapshot: Snapshot): Fields {
    const slider = snapshot.slider, structure = snapshot.structure;
    const labels = snapshot.families.map(row => row.label.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US"));
    return {
      control_count: snapshot.controlCount, control_open: snapshot.controlOpen,
      control_point_present: Boolean(snapshot.controlPoint), menu_count: snapshot.menuCount,
      mode: snapshot.view ?? "none", advanced_point_present: Boolean(snapshot.advancedPoint),
      family_count: snapshot.families.length, checked_family_count: snapshot.families.filter(row => row.checked).length,
      disabled_family_count: snapshot.families.filter(row => row.disabled).length,
      duplicate_family_count: labels.length - new Set(labels).size,
      slider_present: Boolean(slider),
      ...(slider ? { slider_min: slider.min, slider_max: slider.max, slider_value: slider.value, slider_power: slider.power,
        tick_count: slider.ticks.length, selected_tick_count: slider.ticks.filter(tick => tick.selected).length,
        locked_tick_count: slider.ticks.filter(tick => tick.locked === true).length,
        unknown_tick_count: slider.ticks.filter(tick => tick.locked === null).length } : {}),
      ...(structure ? { composer_count: structure.composerCount, composer_form_present: structure.composerFormPresent,
        global_control_count: structure.globalControlCount, form_button_count: structure.formButtonCount } : {}),
      // This optional probe is Tela-authored, numeric/boolean only; no renderer attributes or prose.
      ...snapshot.diagnostic,
    };
  }
  async action<T>(kind: string, invoke: () => Promise<T>): Promise<T> {
    const sequence = ++this.#actions, started = performance.now();
    emitDiagnosticEvent("chatgpt_tela_work", "web_model_picker_action", { phase: this.phase, kind, sequence, outcome: "started" });
    try {
      const result = await invoke();
      emitDiagnosticEvent("chatgpt_tela_work", "web_model_picker_action", { phase: this.phase, kind, sequence,
        outcome: "returned", duration_ms: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      emitDiagnosticEvent("chatgpt_tela_work", "web_model_picker_action_failed", { phase: this.phase, kind, sequence,
        reason_class: modelPickerFailureReason(error), duration_ms: Math.round(performance.now() - started) });
      throw error;
    }
  }
  async failure(error: unknown, restoration = this.restoration): Promise<void> {
    if (this.#reported.has(error)) return;
    this.#reported.add(error);
    const ownership: Fields = {};
    try {
      const document = this.surface.capability(BROWSER_DOCUMENT_LIFETIME)?.current();
      const input = this.surface.capability(BROWSER_INPUT_OWNERSHIP);
      const current = input?.current();
      const observation = input?.observationCurrent?.();
      Object.assign(ownership, { document_observed: Boolean(document), document_generation: document?.generation ?? -1,
        document_revoked: document?.signal.aborted ?? false,
        input_observed: Boolean(current), input_available: current?.available ?? false,
        input_revision: current?.revision ?? -1, input_revoked: current?.signal.aborted ?? false,
        observation_pending: observation?.pending ?? false, observation_revision: observation?.revision ?? -1 });
    } catch { ownership.owner_probe_available = false; }
    emitDiagnosticEvent("chatgpt_tela_work", "web_model_picker_failed", { phase: this.phase, restoration,
      reason_class: modelPickerFailureReason(error), failure_class: diagnosticFailureFields(error).reason_class,
      observation_count: this.#observations, action_count: this.#actions, snapshot_available: Boolean(this.#lastFields),
      ...this.#lastFields });
    emitDiagnosticEvent("chatgpt_tela_work", "web_model_picker_owner_observed", { phase: this.phase, ...ownership });
    if (this.#captured) return;
    this.#captured = true;
    capturePrivateDiagnosticValue("web_preparation_failure", { phase: this.phase, restoration,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: "unknown" } });
    await captureBrowserDiagnosticEvidence(this.surface, "model_picker_failed");
  }
}

export async function runModelPickerOperation<T>(surface: BrowserSurfaceLease, kind: "discovery" | "selection" | "canary",
  invoke: (trace: ModelPickerDiagnostics) => Promise<T>): Promise<T> {
  const operation = diagnosticFingerprint([surface.taskId, surface.epochId, kind].join("\n"));
  return withDiagnosticContext({ operation_fingerprint: operation, surface_fingerprint: diagnosticFingerprint(surface.leaseId) }, async () => {
    const started = performance.now();
    emitDiagnosticEvent("chatgpt_tela_work", "web_model_picker_started", { kind });
    const page = surface.capability(BROWSER_PAGE_AUTOMATION);
    if (!page) {
      emitDiagnosticEvent("chatgpt_tela_work", "web_model_picker_failed", { kind, reason_class: "page_automation_missing" });
      throw new Error("browser surface does not expose page automation for ChatGPT model selection");
    }
    const trace = new ModelPickerDiagnostics(page, surface);
    try {
      const result = await invoke(trace);
      emitDiagnosticEvent("chatgpt_tela_work", "web_model_picker_completed", { kind, duration_ms: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      // Evidence failures cannot replace the primary picker result.
      try { await trace.failure(error); } catch { /* Best effort. */ }
      throw error;
    }
  });
}
