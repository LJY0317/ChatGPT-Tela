import { createHash } from "node:crypto";
import {
  BROWSER_PAGE_AUTOMATION,
  type BrowserPageAutomation,
  type BrowserSurfaceLease,
} from "@chatgpt-tela/browser-host";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { CHATGPT_CURRENT_COMPOSER_SELECTOR } from "./dom-driver";

export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-tela-web/family/";
export const CHATGPT_WEB_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ChatGptWebEffort = typeof CHATGPT_WEB_EFFORTS[number];

export interface ChatGptWebModelFamily {
  readonly key: string;
  readonly label: string;
  readonly availableEfforts: readonly ChatGptWebEffort[];
}

export interface ChatGptWebModelSelectionCanary {
  readonly familyCount: number;
  readonly exercised: boolean;
  readonly testedEffort?: ChatGptWebEffort;
  readonly restoredEffort: ChatGptWebEffort;
}

export function chatGptWebFamilyKey(label: string): string {
  const normalized = label.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
  if (!normalized) throw new Error("ChatGPT model family label must be non-empty");
  return createHash("sha256").update("chatgpt-tela-web-family-v1\0").update(normalized).digest("hex").slice(0, 20);
}

export function chatGptWebModelId(familyKey: string): string {
  if (!/^[a-f0-9]{20}$/.test(familyKey)) throw new Error("ChatGPT Web family key is invalid");
  return `${CHATGPT_WEB_MODEL_PREFIX}${familyKey}`;
}

export function parseChatGptWebModelId(value: string): { readonly familyKey: string } | undefined {
  if (!value.startsWith(CHATGPT_WEB_MODEL_PREFIX)) return undefined;
  const familyKey = value.slice(CHATGPT_WEB_MODEL_PREFIX.length);
  if (!/^[a-f0-9]{20}$/.test(familyKey)) throw new Error("ChatGPT Web model id is malformed");
  return Object.freeze({ familyKey });
}

export const CHATGPT_MODEL_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"]',
  'button[aria-haspopup="menu"][data-selected-reasoning-effort]',
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  'button[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"][aria-haspopup="menu"]',
].join(", ");

interface PickerPoint { readonly x: number; readonly y: number }
interface PickerFamilyRow {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly point?: PickerPoint;
}
interface PickerSlider {
  readonly min: number;
  readonly max: number;
  readonly value: number;
  readonly power: boolean;
  readonly ticks: readonly {
    readonly locked: boolean | null;
    readonly selected: boolean;
    readonly point?: PickerPoint;
  }[];
}
interface PickerSnapshot {
  readonly controlCount: number;
  readonly controlOpen: boolean;
  readonly controlPoint?: PickerPoint;
  readonly menuCount: number;
  readonly view?: "simple" | "advanced" | "legacy";
  readonly advancedPoint?: PickerPoint;
  readonly families: readonly PickerFamilyRow[];
  readonly slider?: PickerSlider;
}

const OBSERVE_MODEL_PICKER = String.raw`function () {
  const marker = "chatgpt-tela-model-picker-observe-v1"; void marker;
  const visible = element => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
      && element.getClientRects().length > 0;
  };
  const point = element => {
    if (!(element instanceof HTMLElement) || !visible(element)) return undefined;
    const rect = element.getBoundingClientRect();
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return undefined;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const composers = [...document.querySelectorAll(${JSON.stringify(CHATGPT_CURRENT_COMPOSER_SELECTOR)})].filter(visible);
  const composer = composers.at(-1);
  const form = composer?.closest("form[data-chatgpt-composer], form");
  const controls = form ? [...form.querySelectorAll(${JSON.stringify(CHATGPT_MODEL_CONTROL_SELECTOR)})].filter(visible) : [];
  const control = controls.length === 1 ? controls[0] : undefined;
  let menu;
  if (control) {
    const ownedId = control.getAttribute("aria-controls");
    if (ownedId) menu = document.getElementById(ownedId) || undefined;
  }
  if (!menu) {
    const candidates = [...document.querySelectorAll(
      '[data-testid="composer-intelligence-picker-content"], [role="menu"], [role="group"]'
    )].filter(element => visible(element) && (
      element.querySelector('[role="menuitemradio"]') || element.querySelector('[role="slider"][aria-valuemin][aria-valuemax][aria-valuenow]')
    ));
    if (candidates.length === 1) menu = candidates[0];
  }
  const menuCount = menu && visible(menu) ? 1 : 0;
  const powerView = menu?.querySelector('[data-model-picker-view]');
  const rawView = powerView?.getAttribute('data-model-picker-view');
  const view = rawView === "simple" || rawView === "advanced" ? rawView : (menu ? "legacy" : undefined);
  const advancedTrigger = powerView?.querySelector('[data-model-picker-view-toggle="true"][aria-hidden="false"]');
  const rows = menu ? [...menu.querySelectorAll('[role="menuitemradio"]')] : [];
  const families = rows.map(row => {
    const structured = row.querySelector('[data-menu-row-content="true"]');
    const primary = structured?.querySelector("span");
    const label = normalize(primary?.textContent || row.querySelector("span")?.textContent || row.textContent);
    return {
      label,
      checked: row.getAttribute("aria-checked") === "true",
      disabled: row.getAttribute("aria-disabled") === "true",
      point: point(row),
    };
  }).filter(row => row.label);
  const sliders = menu ? [...menu.querySelectorAll('[role="slider"][aria-valuemin][aria-valuemax][aria-valuenow]')] : [];
  const slider = sliders.at(-1);
  let sliderState;
  if (slider) {
    const min = Number(slider.getAttribute("aria-valuemin"));
    const max = Number(slider.getAttribute("aria-valuemax"));
    const value = Number(slider.getAttribute("aria-valuenow"));
    const owner = slider.closest('[data-model-reasoning-effort-slider], [data-model-picker-power-slider], [role="menuitem"]');
    const power = Boolean(owner?.hasAttribute('data-model-picker-power-slider')
      && owner.querySelector('[data-orientation="horizontal"][aria-disabled="false"]'));
    const ticks = owner ? [...owner.querySelectorAll('[data-selected]')].map(tick => ({
      locked: tick.getAttribute("data-locked") === "true" ? true
        : tick.getAttribute("data-locked") === "false" ? false : null,
      selected: tick.getAttribute("data-selected") === "true",
      point: point(tick),
    })) : [];
    sliderState = { min, max, value, power, ticks };
  }
  return {
    controlCount: controls.length,
    controlOpen: Boolean(control && (control.getAttribute("aria-expanded") === "true" || control.getAttribute("data-state") === "open")),
    controlPoint: point(control),
    menuCount,
    view,
    advancedPoint: point(advancedTrigger),
    families,
    slider: sliderState,
  };
}`;

const ACTIVATE_MODEL_PICKER_TARGET = String.raw`function (input) {
  const marker = "chatgpt-tela-model-picker-activate-v1"; void marker;
  const visible = element => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
      && element.getClientRects().length > 0;
  };
  const normalize = value => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
  const composers = [...document.querySelectorAll(${JSON.stringify(CHATGPT_CURRENT_COMPOSER_SELECTOR)})].filter(visible);
  const composer = composers.at(-1);
  const form = composer?.closest("form[data-chatgpt-composer], form");
  const controls = form ? [...form.querySelectorAll(${JSON.stringify(CHATGPT_MODEL_CONTROL_SELECTOR)})].filter(visible) : [];
  if (controls.length !== 1) return { ok: false, reason: "control-count", count: controls.length };
  const control = controls[0];
  let target = control;
  if (input.target !== "control") {
    const ownedId = control.getAttribute("aria-controls");
    let menu = ownedId ? document.getElementById(ownedId) : undefined;
    if (!menu) {
      const candidates = [...document.querySelectorAll(
        '[data-testid="composer-intelligence-picker-content"], [role="menu"], [role="group"]'
      )].filter(element => visible(element) && (
        element.querySelector('[role="menuitemradio"]') || element.querySelector('[role="slider"][aria-valuemin][aria-valuemax][aria-valuenow]')
      ));
      if (candidates.length !== 1) return { ok: false, reason: "menu-count", count: candidates.length };
      menu = candidates[0];
    }
    if (!menu) return { ok: false, reason: "menu-missing" };
    if (input.target === "advanced") {
      const matches = [...menu.querySelectorAll('[data-model-picker-view-toggle="true"][aria-hidden="false"]')];
      if (matches.length !== 1) return { ok: false, reason: "advanced-count", count: matches.length };
      target = matches[0];
    } else if (input.target === "family") {
      const expected = normalize(input.label);
      const matches = [...menu.querySelectorAll('[role="menuitemradio"]')].filter(row => {
        if (row.getAttribute("aria-disabled") === "true") return false;
        const structured = row.querySelector('[data-menu-row-content="true"]');
        const primary = structured?.querySelector("span");
        const label = primary?.textContent || row.querySelector("span")?.textContent || row.textContent;
        return normalize(label) === expected;
      });
      if (matches.length !== 1) return { ok: false, reason: "family-count", count: matches.length };
      target = matches[0];
    } else if (input.target === "effort" || input.target === "effort-owner") {
      const sliders = [...menu.querySelectorAll('[role="slider"][aria-valuemin][aria-valuemax][aria-valuenow]')];
      const slider = sliders.at(-1);
      const owner = slider?.closest('[data-model-reasoning-effort-slider], [data-model-picker-power-slider], [role="menuitem"]');
      if (input.target === "effort-owner") {
        if (!(owner instanceof HTMLElement)) return { ok: false, reason: "effort-owner-missing" };
        target = owner;
      } else {
        const ticks = owner ? [...owner.querySelectorAll('[data-selected]')] : [];
        if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= ticks.length) {
          return { ok: false, reason: "effort-index", count: ticks.length };
        }
        target = ticks[input.index];
      }
    }
  }
  if (!(target instanceof HTMLElement)) return { ok: false, reason: "target-missing" };
  if (input.method === "focus") {
    target.focus({ preventScroll: true });
  } else if (input.method === "pointerdown") {
    target.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      pointerType: "mouse",
      isPrimary: true,
    }));
  } else if (input.method === "pointer-sequence") {
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const pointer = (type, buttons) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX,
      clientY,
    }));
    const mouse = (type, buttons) => target.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons,
      clientX,
      clientY,
    }));
    pointer("pointerdown", 1);
    mouse("mousedown", 1);
    pointer("pointerup", 0);
    mouse("mouseup", 0);
    mouse("click", 0);
  } else {
    target.click();
  }
  return { ok: true };
}`;

function pageFor(surface: BrowserSurfaceLease): BrowserPageAutomation {
  const page = surface.capability(BROWSER_PAGE_AUTOMATION);
  if (!page) throw new Error("browser surface does not expose page automation for ChatGPT model selection");
  return page;
}

function validSnapshot(raw: PickerSnapshot): PickerSnapshot {
  if (!Number.isSafeInteger(raw.controlCount) || raw.controlCount < 0 || !Number.isSafeInteger(raw.menuCount) || raw.menuCount < 0) {
    throw new Error("ChatGPT model picker returned invalid control counts");
  }
  if (raw.slider) {
    const { min, max, value } = raw.slider;
    if (![min, max, value].every(Number.isSafeInteger) || max < min || value < min || value > max || max - min + 1 > CHATGPT_WEB_EFFORTS.length) {
      throw new Error("ChatGPT model picker returned an invalid effort slider");
    }
  }
  return raw;
}

async function observe(page: BrowserPageAutomation, signal?: AbortSignal): Promise<PickerSnapshot> {
  return validSnapshot(await page.evaluate<undefined, PickerSnapshot>(OBSERVE_MODEL_PICKER, undefined, signal));
}

async function activateTarget(
  page: BrowserPageAutomation,
  input: {
    readonly target: "control" | "advanced" | "family" | "effort" | "effort-owner";
    readonly method: "focus" | "click" | "pointerdown" | "pointer-sequence";
    readonly label?: string;
    readonly index?: number;
  },
  signal?: AbortSignal,
): Promise<void> {
  const result = await page.evaluate<typeof input, { readonly ok: boolean; readonly reason?: string; readonly count?: number }>(
    ACTIVATE_MODEL_PICKER_TARGET,
    input,
    signal,
  );
  if (!result.ok) {
    throw new Error(`ChatGPT model picker activation failed (${result.reason ?? "unknown"}${result.count === undefined ? "" : `:${result.count}`})`);
  }
}

async function waitForOptional(
  page: BrowserPageAutomation,
  predicate: (snapshot: PickerSnapshot) => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PickerSnapshot | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("operation aborted", "AbortError");
    const snapshot = await observe(page, signal);
    if (predicate(snapshot)) return snapshot;
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
}

async function waitFor(
  page: BrowserPageAutomation,
  predicate: (snapshot: PickerSnapshot) => boolean,
  timeoutMs: number,
  stage: string,
  signal?: AbortSignal,
): Promise<PickerSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: PickerSnapshot | undefined;
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("operation aborted", "AbortError");
    const snapshot = await observe(page, signal);
    last = snapshot;
    if (predicate(snapshot)) return snapshot;
    if (Date.now() >= deadline) {
      emitDiagnosticEvent("chatgpt_tela_work", "web_model_picker_timeout", {
        picker_stage: stage,
        control_count: last.controlCount,
        menu_count: last.menuCount,
        family_count: last.families.length,
        view: last.view ?? "none",
        slider_present: Boolean(last.slider),
      });
      throw new Error(`ChatGPT model picker timed out waiting for ${stage}`);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
}

async function openPicker(page: BrowserPageAutomation, signal?: AbortSignal): Promise<PickerSnapshot> {
  let snapshot = await waitFor(page, value => value.controlCount === 1, 15_000, "control", signal);
  if (snapshot.menuCount === 1) return snapshot;
  // Hidden/offscreen Electron surfaces do not always accept pointer hit-testing even though the
  // semantic control is mounted. Match the proven downstream activation strategy: keyboard first,
  // then exact DOM click, then primary pointerdown. Every path is non-consequential and requires
  // structural menu readback before it is accepted.
  await activateTarget(page, { target: "control", method: "focus" }, signal);
  await page.pressKey("Enter", signal);
  const keyboard = await waitForOptional(page, value => value.menuCount === 1, 1_000, signal);
  if (keyboard) return keyboard;

  await activateTarget(page, { target: "control", method: "click" }, signal);
  const clicked = await waitForOptional(page, value => value.menuCount === 1, 1_500, signal);
  if (clicked) return clicked;

  await activateTarget(page, { target: "control", method: "pointerdown" }, signal);
  snapshot = await waitFor(page, value => value.menuCount === 1, 2_000, "menu-open", signal);
  return snapshot;
}

async function advancedPicker(page: BrowserPageAutomation, signal?: AbortSignal): Promise<PickerSnapshot> {
  let snapshot = await openPicker(page, signal);
  if (snapshot.view === "simple") {
    try {
      await activateTarget(page, { target: "advanced", method: "click" }, signal);
    } catch {
      if (!snapshot.advancedPoint) throw new Error("ChatGPT model picker has no unique advanced-family trigger");
      await page.pointerClick(snapshot.advancedPoint, signal);
    }
    snapshot = await waitFor(page, value => value.view === "advanced" && value.families.length > 0, 3_000, "advanced-families", signal);
  }
  if (snapshot.families.length === 0) throw new Error("ChatGPT model picker exposes no model family rows");
  return snapshot;
}

function families(snapshot: PickerSnapshot): readonly { key: string; label: string; checked: boolean; point?: PickerPoint }[] {
  const seen = new Set<string>();
  const result = snapshot.families.filter(row => !row.disabled).map(row => {
    const key = chatGptWebFamilyKey(row.label);
    if (seen.has(key)) throw new Error("ChatGPT model picker exposes duplicate model families");
    seen.add(key);
    return Object.freeze({ key, label: row.label, checked: row.checked, ...(row.point ? { point: row.point } : {}) });
  });
  if (result.length > 0 && result.filter(row => row.checked).length !== 1) {
    throw new Error("ChatGPT model picker does not expose exactly one selected family");
  }
  return Object.freeze(result);
}

function effortAvailability(snapshot: PickerSnapshot): readonly ChatGptWebEffort[] {
  const slider = snapshot.slider;
  if (!slider) throw new Error("ChatGPT model picker exposes no effort slider");
  const count = slider.max - slider.min + 1;
  if (slider.ticks.length !== count) throw new Error("ChatGPT model picker effort tick count is ambiguous");
  return Object.freeze(slider.ticks.flatMap((tick, index) => {
    const available = tick.locked === false || (tick.locked === null && slider.power);
    return available && CHATGPT_WEB_EFFORTS[index] ? [CHATGPT_WEB_EFFORTS[index]!] : [];
  }));
}

async function selectFamily(
  page: BrowserPageAutomation,
  familyKey: string,
  signal?: AbortSignal,
): Promise<PickerSnapshot> {
  let snapshot = await advancedPicker(page, signal);
  const current = families(snapshot);
  const target = current.find(row => row.key === familyKey);
  if (!target) throw new Error("selected ChatGPT Web model family is no longer present");
  if (!target.checked) {
    // Power-family rows intentionally use an exact DOM activation. This is non-consequential and
    // avoids offscreen hit-testing; the selected row is accepted only after semantic checked
    // readback. A current Power picker may return to its simple view as part of this commit.
    await activateTarget(page, { target: "family", method: "click", label: target.label }, signal);
    const committed = await waitForOptional(page, value => {
      try {
        const rows = families(value);
        return rows.some(row => row.key === familyKey && row.checked);
      } catch {
        return false;
      }
    }, 1_500, signal);
    if (committed) return committed;

    // Some Power renders unmount their advanced rows immediately after a family commit. Re-open
    // that exact family view and verify the checked row instead of treating the view transition as
    // proof of selection.
    snapshot = await advancedPicker(page, signal);
    const verified = families(snapshot).find(row => row.key === familyKey);
    if (!verified?.checked) {
      throw new Error("ChatGPT model picker did not commit the selected family row");
    }
  }
  return snapshot;
}

async function setEffort(
  page: BrowserPageAutomation,
  effort: ChatGptWebEffort,
  signal?: AbortSignal,
): Promise<void> {
  let snapshot = await openPicker(page, signal);
  const slider = snapshot.slider;
  if (!slider) throw new Error("ChatGPT model picker exposes no effort slider");
  const targetIndex = CHATGPT_WEB_EFFORTS.indexOf(effort);
  const count = slider.max - slider.min + 1;
  if (targetIndex < 0 || targetIndex >= count) throw new Error(`ChatGPT model family does not expose effort ${effort}`);
  const tick = slider.ticks[targetIndex];
  if (!tick) throw new Error("ChatGPT model picker effort tick is missing");
  if (tick.locked === true || (tick.locked === null && !slider.power)) {
    throw new Error(`ChatGPT model family does not allow effort ${effort}`);
  }
  const targetValue = slider.min + targetIndex;
  if (slider.value !== targetValue) {
    emitDiagnosticEvent("chatgpt_tela_work", "web_model_effort_selection_start", {
      effort,
      before_value: slider.value,
      target_value: targetValue,
      slider_min: slider.min,
      slider_max: slider.max,
      power_control_enabled: slider.power,
      tick_lock_state: tick.locked === null ? "unspecified" : tick.locked ? "locked" : "available",
    });
    if (slider.power) {
      if (!tick.point) throw new Error("ChatGPT Power effort has no trusted pointer target");
      await page.pointerClick(tick.point, signal);
      const pointerCommitted = await waitForOptional(page, value => value.slider?.value === targetValue, 1_500, signal);
      if (pointerCommitted) {
        emitDiagnosticEvent("chatgpt_tela_work", "web_model_effort_selection_complete", {
          effort,
          method: "trusted-pointer",
          value: targetValue,
        });
        return;
      }

      await activateTarget(page, { target: "effort", method: "click", index: targetIndex }, signal);
      const domCommitted = await waitForOptional(page, value => value.slider?.value === targetValue, 1_000, signal);
      if (domCommitted) {
        emitDiagnosticEvent("chatgpt_tela_work", "web_model_effort_selection_complete", {
          effort,
          method: "dom-click",
          value: targetValue,
        });
        return;
      }

      await activateTarget(page, { target: "effort", method: "pointer-sequence", index: targetIndex }, signal);
      const sequenceCommitted = await waitForOptional(page, value => value.slider?.value === targetValue, 1_500, signal);
      if (sequenceCommitted) {
        emitDiagnosticEvent("chatgpt_tela_work", "web_model_effort_selection_complete", {
          effort,
          method: "dom-pointer-sequence",
          value: targetValue,
        });
        return;
      }
    } else {
      await activateTarget(page, { target: "effort-owner", method: "focus" }, signal);
      let current = slider.value;
      for (let attempts = 0; attempts < CHATGPT_WEB_EFFORTS.length && current !== targetValue; attempts += 1) {
        const increasing = current < targetValue;
        const expected = current + (increasing ? 1 : -1);
        await page.pressKey(increasing ? "ArrowRight" : "ArrowLeft", signal);
        const stepped = await waitForOptional(page, value => value.slider?.value !== current, 1_500, signal);
        if (!stepped?.slider || stepped.slider.value !== expected) {
          throw new Error(`ChatGPT effort slider did not move exactly one step toward ${effort}`);
        }
        current = stepped.slider.value;
      }
      if (current === targetValue) {
        emitDiagnosticEvent("chatgpt_tela_work", "web_model_effort_selection_complete", {
          effort,
          method: "keyboard-step",
          value: targetValue,
        });
        return;
      }
    }
    snapshot = await waitFor(page, value => value.slider?.value === targetValue, 3_000, "effort-selection", signal);
    if (snapshot.slider?.value !== targetValue) throw new Error("ChatGPT model effort selection did not commit");
  }
}

export async function discoverChatGptWebModelFamilies(
  surface: BrowserSurfaceLease,
  signal?: AbortSignal,
): Promise<readonly ChatGptWebModelFamily[]> {
  const page = pageFor(surface);
  let snapshot = await advancedPicker(page, signal);
  const candidates = families(snapshot);
  if (candidates.length === 0) return Object.freeze([]);
  const original = candidates.find(row => row.checked)!;
  const originalSlider = snapshot.slider;
  const originalEffortIndex = originalSlider ? originalSlider.value - originalSlider.min : undefined;
  const discovered: ChatGptWebModelFamily[] = [];
  let primaryError: unknown;
  try {
    for (const candidate of candidates) {
      snapshot = await selectFamily(page, candidate.key, signal);
      const availableEfforts = effortAvailability(snapshot);
      if (availableEfforts.length > 0) {
        discovered.push(Object.freeze({ key: candidate.key, label: candidate.label, availableEfforts }));
      }
    }
    emitDiagnosticEvent("chatgpt_tela_work", "web_model_catalog_discovered", { family_count: discovered.length });
    return Object.freeze(discovered);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await selectFamily(page, original.key, signal);
      if (originalEffortIndex !== undefined) {
        const restored = await openPicker(page, signal);
        const slider = restored.slider;
        if (!slider || originalEffortIndex < 0 || originalEffortIndex >= slider.ticks.length) {
          throw new Error("ChatGPT model discovery could not restore the original effort");
        }
        const effort = CHATGPT_WEB_EFFORTS[originalEffortIndex];
        if (!effort) throw new Error("ChatGPT model discovery original effort is unsupported");
        await setEffort(page, effort, signal);
      }
      await page.pressKey("Escape", signal);
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
  }
}

export async function selectChatGptWebModel(
  surface: BrowserSurfaceLease,
  input: { readonly familyKey: string; readonly effort: ChatGptWebEffort },
  signal?: AbortSignal,
): Promise<void> {
  const page = pageFor(surface);
  await selectFamily(page, input.familyKey, signal);
  await setEffort(page, input.effort, signal);
  await page.pressKey("Escape", signal);

  const effortIndex = CHATGPT_WEB_EFFORTS.indexOf(input.effort);
  // A hidden Electron Power picker can occasionally commit a rendered effort tick while the
  // family row drifts during the synthetic pointer fallback. Converge the two independent controls
  // under exact readback, with a small fixed bound and no submit/resend side effect. Re-selecting a
  // family or effort is allowed only after the mismatch itself has been structurally observed.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const verified = await advancedPicker(page, signal);
    const verifiedFamilies = families(verified);
    const family = verifiedFamilies.find(row => row.key === input.familyKey);
    const slider = verified.slider;
    const familyReady = family?.checked === true;
    const effortReady = Boolean(slider && slider.value === slider.min + effortIndex);
    if (familyReady && effortReady) {
      await page.pressKey("Escape", signal);
      emitDiagnosticEvent("chatgpt_tela_work", "web_model_selected", {
        effort: input.effort,
        convergence_attempts: attempt,
      });
      return;
    }
    emitDiagnosticEvent("chatgpt_tela_work", "web_model_selection_readback_mismatch", {
      attempt,
      requested_family_present: Boolean(family),
      requested_family_checked: family?.checked ?? false,
      checked_family_count: verifiedFamilies.filter(row => row.checked).length,
      slider_present: Boolean(slider),
      slider_min: slider?.min ?? -1,
      slider_value: slider?.value ?? -1,
      expected_slider_value: slider ? slider.min + effortIndex : -1,
      view: verified.view ?? "none",
    });
    if (!familyReady) await selectFamily(page, input.familyKey, signal);
    if (!effortReady) await setEffort(page, input.effort, signal);
    await page.pressKey("Escape", signal);
  }
  throw new Error("ChatGPT model family/effort readback did not converge on the requested Web route");
}

async function currentChatGptWebModelSelection(
  page: BrowserPageAutomation,
  signal?: AbortSignal,
): Promise<{ readonly familyKey: string; readonly effort: ChatGptWebEffort }> {
  try {
    const snapshot = await advancedPicker(page, signal);
    const family = families(snapshot).find(row => row.checked);
    const slider = snapshot.slider;
    if (!family || !slider) throw new Error("ChatGPT model picker has no current family/effort selection");
    const effortIndex = slider.value - slider.min;
    const effort = CHATGPT_WEB_EFFORTS[effortIndex];
    if (!effort) throw new Error("ChatGPT model picker current effort is outside the supported semantic range");
    return Object.freeze({ familyKey: family.key, effort });
  } finally {
    await page.pressKey("Escape", signal).catch(() => {});
  }
}

/**
 * Non-submit live canary for the browser model picker.
 *
 * The canary changes only the model/effort UI, proves exact semantic readback, and then restores the
 * original family/effort before returning. A restoration failure is never hidden behind a primary
 * selection failure because leaving the persistent ChatGPT profile in an unknown mode is itself a
 * failed canary.
 */
export async function probeChatGptWebModelSelection(
  surface: BrowserSurfaceLease,
  signal?: AbortSignal,
): Promise<ChatGptWebModelSelectionCanary> {
  const page = pageFor(surface);
  const catalog = await discoverChatGptWebModelFamilies(surface, signal);
  const original = await currentChatGptWebModelSelection(page, signal);
  const originalFamily = catalog.find(family => family.key === original.familyKey);
  if (!originalFamily || !originalFamily.availableEfforts.includes(original.effort)) {
    throw new Error("ChatGPT model selection canary could not prove the original family/effort in the live catalog");
  }

  let target: { readonly familyKey: string; readonly effort: ChatGptWebEffort } | undefined;
  const alternateEffort = originalFamily.availableEfforts.find(effort => effort !== original.effort);
  if (alternateEffort) {
    target = Object.freeze({ familyKey: original.familyKey, effort: alternateEffort });
  } else {
    const alternateFamily = catalog.find(family => family.key !== original.familyKey && family.availableEfforts.length > 0);
    const effort = alternateFamily?.availableEfforts[0];
    if (alternateFamily && effort) target = Object.freeze({ familyKey: alternateFamily.key, effort });
  }

  if (!target) {
    emitDiagnosticEvent("chatgpt_tela_work", "web_model_selection_canary_complete", {
      family_count: catalog.length,
      exercised: false,
      restored: true,
    });
    return Object.freeze({
      familyCount: catalog.length,
      exercised: false,
      restoredEffort: original.effort,
    });
  }

  let primaryError: unknown;
  try {
    await selectChatGptWebModel(surface, target, signal);
  } catch (error) {
    primaryError = error;
  }

  let restoreError: unknown;
  try {
    await selectChatGptWebModel(surface, original, signal);
    const restored = await currentChatGptWebModelSelection(page, signal);
    if (restored.familyKey !== original.familyKey || restored.effort !== original.effort) {
      throw new Error("ChatGPT model selection canary restoration readback did not match the original mode");
    }
  } catch (error) {
    restoreError = error;
  }

  if (primaryError && restoreError) {
    throw new AggregateError([primaryError, restoreError], "ChatGPT model selection canary failed and could not restore the original mode");
  }
  if (restoreError) throw restoreError;
  if (primaryError) throw primaryError;

  emitDiagnosticEvent("chatgpt_tela_work", "web_model_selection_canary_complete", {
    family_count: catalog.length,
    exercised: true,
    tested_effort: target.effort,
    restored: true,
  });
  return Object.freeze({
    familyCount: catalog.length,
    exercised: true,
    testedEffort: target.effort,
    restoredEffort: original.effort,
  });
}
