import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { diagnosticFingerprint, structuralDiagnosticEvent } from "@chatgpt-tela/core";
import { runInNewContext } from "node:vm";
import {
  ChatGptWebModelPickerControlUnavailableError,
  chatGptWebFamilyKey,
  chatGptWebModelId,
  parseChatGptWebModelId,
  selectChatGptWebModel,
} from "./model-picker";
import { BROWSER_PAGE_AUTOMATION, type BrowserPageAutomation, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";

function pickerSurface(page: BrowserPageAutomation): BrowserSurfaceLease {
  return { leaseId: "fixture-picker-lease", taskId: "fixture-picker-task", epochId: "fixture-picker-epoch",
    capability: (key: unknown) => key === BROWSER_PAGE_AUTOMATION ? page : undefined } as BrowserSurfaceLease;
}

describe("ChatGPT Web model route identity", () => {
  test("a dismissed menu that reopens simple does not falsely prove advanced preference", async () => {
    let opened = true, advanced = false, pointerActivations = 0;
    const page: BrowserPageAutomation = {
      async evaluate(source, argument) {
        if (source.includes("chatgpt-tela-model-picker-activate-v1")) {
          const action = argument as { target: string; method: string };
          if (action.target === "advanced") opened = false; // dismissed, preference NOT committed
          return { ok: true } as never;
        }
        return { controlCount: 1, controlOpen: opened, menuCount: opened ? 1 : 0,
          view: opened ? advanced ? "advanced" : "simple" : undefined,
          advancedPoint: opened && !advanced ? { x: 10, y: 20 } : undefined,
          families: opened && advanced ? [{ label: "Fixture", checked: true, disabled: false }] : [],
          slider: opened ? { min: 0, max: 0, value: 0, power: false, ticks: [{ locked: false, selected: true }] } : undefined,
        } as never;
      },
      async pressKey(key) { opened = key === "Enter"; },
      async pointerClick() { pointerActivations++; advanced = true; opened = false; },
      async typeFocusedEditable() {}, async clearFocusedEditable() {},
      async mutationRevision() { return 0; }, async waitForDomMutation() { return 1; },
    };
    const surface = pickerSurface(page);
    await selectChatGptWebModel(surface, { familyKey: chatGptWebFamilyKey("Fixture"), effort: "low" });
    expect(pointerActivations).toBe(1);
    expect(opened).toBe(false);
    const row = readFileSync(process.env.CHATGPT_TELA_DIAGNOSTIC_FILE!, "utf8").trim().split("\n")
      .map(line => structuralDiagnosticEvent(JSON.parse(line))).filter(event => event?.stage === "web_model_selected").at(-1);
    expect(row).toMatchObject({provider_kind:"web",effort:"low",family_fingerprint:diagnosticFingerprint(chatGptWebFamilyKey("Fixture")),family_readback_proven:true,effort_readback_proven:true});
  });
  test("only one visible composer with a missing model control qualifies for a bounded preparation recovery", () => {
    const candidate = new ChatGptWebModelPickerControlUnavailableError();
    expect(candidate.code).toBe("tela_web_model_picker_control_unavailable");
    expect(candidate.message).not.toMatch(/login|account|sign.in/i);
  });
  test("missing family produces a semantic catalog fault without selecting a replacement", async () => {
    let activations = 0;
    const page: BrowserPageAutomation = {
      async evaluate(source) {
        if (source.includes("chatgpt-tela-model-picker-activate-v1")) activations++;
        return { controlCount: 1, controlOpen: true, menuCount: 1, view: "advanced",
          families: [{ label: "New fixture family", checked: true, disabled: false }],
          slider: { min: 0, max: 0, value: 0, power: false,
            ticks: [{ locked: false, selected: true }] } } as never;
      },
      async pressKey() {}, async pointerClick() { throw new Error("unexpected selection"); },
      async typeFocusedEditable() {}, async clearFocusedEditable() {},
      async mutationRevision() { return 0; }, async waitForDomMutation() { return 1; },
    };
    const surface = pickerSurface(page);
    await expect(selectChatGptWebModel(surface, { familyKey: chatGptWebFamilyKey("Old fixture family"), effort: "low" }))
      .rejects.toMatchObject({ code: "tela_web_model_unavailable" });
    expect(activations).toBe(0);
  });
  test("reads back a committed advanced view after the picker dismisses during transition", async () => {
    let opened = true;
    let advanced = false;
    let advancedActivations = 0;
    const page: BrowserPageAutomation = {
      async evaluate(source, argument) {
        if (source.includes("chatgpt-tela-model-picker-activate-v1")) {
          const action = argument as { target: string; method: string };
          if (action.target === "advanced") {
            advancedActivations++;
            advanced = true;
            opened = false;
          }
          return { ok: true } as never;
        }
        return {
          controlCount: 1, controlOpen: opened, menuCount: opened ? 1 : 0,
          view: opened ? (advanced ? "advanced" : "simple") : undefined,
          families: opened && advanced ? [{ label: "Fixture", checked: true, disabled: false }] : [],
          slider: opened ? { min: 0, max: 0, value: 0, power: false,
            ticks: [{ locked: false, selected: true }] } : undefined,
        } as never;
      },
      async pressKey(key) { opened = key === "Enter"; },
      async pointerClick() { throw new Error("unexpected pointer fallback"); },
      async typeFocusedEditable() {}, async clearFocusedEditable() {},
      async mutationRevision() { return 0; }, async waitForDomMutation() { return 1; },
    };
    const surface = pickerSurface(page);
    await selectChatGptWebModel(surface, { familyKey: chatGptWebFamilyKey("Fixture"), effort: "low" });
    expect(advancedActivations).toBe(1);
    expect(opened).toBe(false);
  });
  test("requires native activation and advanced readback when a DOM toggle click has no effect", async () => {
    let opened = true;
    let advanced = false;
    let advancedActivations = 0;
    let pointerActivations = 0;
    const page: BrowserPageAutomation = {
      async evaluate(source, argument) {
        if (source.includes("chatgpt-tela-model-picker-activate-v1")) {
          const action = argument as { target: string; method: string };
          if (action.target === "advanced") {
            advancedActivations++;
            // DOM dispatch succeeds but the application ignores it.
          }
          return { ok: true } as never;
        }
        return {
          controlCount: 1, controlOpen: opened, menuCount: opened ? 1 : 0,
          view: opened ? (advanced ? "advanced" : "simple") : undefined,
          advancedPoint: opened && !advanced ? { x: 10, y: 20 } : undefined,
          families: opened && advanced ? [{ label: "Fixture", checked: true, disabled: false }] : [],
          slider: opened ? { min: 0, max: 0, value: 0, power: false,
            ticks: [{ locked: false, selected: true }] } : undefined,
        } as never;
      },
      async pressKey(key) { opened = key === "Enter"; },
      async pointerClick(point) {
        expect(point).toEqual({ x: 10, y: 20 });
        pointerActivations++; advanced = true; opened = false;
      },
      async typeFocusedEditable() {}, async clearFocusedEditable() {},
      async mutationRevision() { return 0; }, async waitForDomMutation() { return 1; },
    };
    const surface = pickerSurface(page);
    await selectChatGptWebModel(surface, { familyKey: chatGptWebFamilyKey("Fixture"), effort: "low" });
    expect(advancedActivations).toBe(1);
    expect(pointerActivations).toBe(1);
    expect(opened).toBe(false);
  });
  test("derives one stable opaque family identity from the visible label", () => {
    const first = chatGptWebFamilyKey("  GPT 5.6   Sol ");
    const second = chatGptWebFamilyKey("GPT 5.6 Sol");
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{20}$/);
    expect(chatGptWebModelId(first)).toBe(`chatgpt-tela-web/family/${first}`);
    expect(parseChatGptWebModelId(chatGptWebModelId(first))).toEqual({ familyKey: first });
  });

  test("native model ids remain outside the Web route namespace and malformed Web ids fail closed", () => {
    expect(parseChatGptWebModelId("gpt-native-model")).toBeUndefined();
    expect(() => parseChatGptWebModelId("chatgpt-tela-web/family/not-a-key")).toThrow("malformed");
  });
});


test("Power effort without geometry still requires exact semantic activation and readback", async () => {
  let opened = true;
  let value = 0;
  let effortClicks = 0;
  const page: BrowserPageAutomation = {
    async evaluate(source, argument) {
      if (source.includes("chatgpt-tela-model-picker-activate-v1")) {
        const action = argument as { target: string; index?: number };
        if (action.target === "effort") { effortClicks++; value = action.index!; }
        return { ok: true } as never;
      }
      return { controlCount: 1, controlOpen: opened, menuCount: opened ? 1 : 0,
        view: opened ? "advanced" : undefined,
        families: opened ? [{ label: "Fixture", checked: true, disabled: false }] : [],
        slider: opened ? { min: 0, max: 1, value, power: true,
          ticks: [{ locked: false, selected: value === 0 }, { locked: false, selected: value === 1 }] } : undefined,
      } as never;
    },
    async pressKey(key) { if (key === "Escape") opened = false; if (key === "Enter") opened = true; },
    async pointerClick() { throw new Error("no geometry must not cause a pointer click"); },
    async typeFocusedEditable() {}, async clearFocusedEditable() {},
    async mutationRevision() { return 0; }, async waitForDomMutation() { return 1; },
  };
  const surface = pickerSurface(page);
  await selectChatGptWebModel(surface, { familyKey: chatGptWebFamilyKey("Fixture"), effort: "medium" });
  expect(value).toBe(1);
  expect(effortClicks).toBe(1);
});


test("duplicate visible composers cannot select even a unique model control", async () => {
  const controller = new AbortController();
  let activations = 0;
  let observedComposerCount = 0;
  class Element {
    getClientRects() { return [{}]; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; }
    getAttribute() { return null; }
    closest() { return form; }
    querySelectorAll() { return [control]; }
  }
  const control = new Element(); const form = new Element();
  const composers = [new Element(), new Element()];
  const page: BrowserPageAutomation = {
    async evaluate(source) {
      if (source.includes("chatgpt-tela-model-picker-activate-v1")) {
        activations++; throw new Error("unexpected ambiguous activation");
      }
      const result = runInNewContext(`(${source})()`, {
        HTMLElement: Element,
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
        document: {
          querySelectorAll: (selector: string) => selector.includes("prompt-textarea") ? composers
            : selector.includes("button[") ? [control] : [],
          getElementById: () => null,
        },
      });
      observedComposerCount = result.structure.composerCount;
      controller.abort(new Error("composer-observation-stopped"));
      return result;
    },
    async pressKey() { throw new Error("unexpected ambiguous keypress"); },
    async pointerClick() { throw new Error("unexpected ambiguous pointer"); },
    async typeFocusedEditable() {}, async clearFocusedEditable() {},
    async mutationRevision() { return 0; }, async waitForDomMutation() { return 1; },
  };
  const surface = pickerSurface(page);
  await expect(selectChatGptWebModel(surface, { familyKey: chatGptWebFamilyKey("Fixture"), effort: "low" }, controller.signal))
    .rejects.toThrow("composer-observation-stopped");
  expect(observedComposerCount).toBe(2);
  expect(activations).toBe(0);
});

for (const scenario of [
  { name: "opacity exclusion", selectorMatches: true },
  { name: "selector mismatch", selectorMatches: false },
]) test(`missing picker diagnostics distinguish ${scenario.name} from absent menu candidates`, async () => {
  const observed: Record<string, number | boolean> [] = [];
  class Element {
    constructor(readonly kind: string) {}
    getClientRects() { return [{}]; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; }
    getAttribute() { return null; }
    closest() { return form; }
    querySelectorAll(selector: string) {
      if (this.kind !== "form") return [];
      if (selector.includes('data-tone')) return scenario.selectorMatches ? [control] : [];
      if (selector.includes('aria-haspopup')) return [control];
      return [];
    }
  }
  const form = new Element("form"), composer = new Element("composer"), control = new Element("control");
  const page: BrowserPageAutomation = {
    async evaluate(source) {
      const result = runInNewContext(`(${source})()`, {
        HTMLElement: Element,
        getComputedStyle: (element: Element) => ({ display: "block", visibility: "visible",
          opacity: element === control && scenario.selectorMatches ? "0" : "1" }),
        document: {
          querySelectorAll: (selector: string) => selector.includes("prompt-textarea") ? [composer]
            : selector.includes('data-tone') && scenario.selectorMatches ? [control] : [],
          getElementById: () => null, elementFromPoint: () => null,
          hidden: true, readyState: "complete", hasFocus: () => false, activeElement: null,
        },
      }) as { diagnostic: Record<string, number | boolean> };
      observed.push(result.diagnostic);
      throw Error("fixture observation captured");
    },
    async pressKey() {}, async pointerClick() {}, async typeFocusedEditable() {}, async clearFocusedEditable() {},
    async mutationRevision() { return 0; }, async waitForDomMutation() { return 1; },
  };
  await expect(selectChatGptWebModel(pickerSurface(page), { familyKey: chatGptWebFamilyKey("Fixture"), effort: "low" }))
    .rejects.toThrow("fixture observation captured");
  expect(observed[0]).toMatchObject({ probe_available: true,
    raw_global_control_count: scenario.selectorMatches ? 1 : 0,
    raw_form_control_count: scenario.selectorMatches ? 1 : 0,
    global_excluded_opacity: scenario.selectorMatches ? 1 : 0,
    form_excluded_opacity: scenario.selectorMatches ? 1 : 0,
    generic_form_menu_candidate_count: 1 });
});

for (const scenario of [
  { name: "omitted aria-hidden", hidden: null, visible: true, count: 1, expected: true },
  { name: "explicit exposed", hidden: "false", visible: true, count: 1, expected: true },
  { name: "explicit hidden", hidden: "true", visible: true, count: 1, expected: false },
  { name: "not rendered", hidden: null, visible: false, count: 1, expected: false },
  { name: "ambiguous exposed", hidden: null, visible: true, count: 2, expected: false },
]) {
  test(`advanced toggle uses actual visibility: ${scenario.name}`, async () => {
    let clicks = 0; let activationOk = false;
    class Element {
      constructor(readonly kind: string) {}
      getClientRects() { return this.kind === "toggle" && !scenario.visible ? [] : [{}]; }
      getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; }
      getAttribute(name: string) { return this.kind === "control" && name === "aria-controls" ? "owned-menu"
        : this.kind === "toggle" && name === "aria-hidden" ? scenario.hidden : null; }
      closest() { return form; }
      querySelectorAll(selector: string) { return selector.includes("data-model-picker-view-toggle")
        ? Array.from({ length: scenario.count }, () => toggle) : this.kind === "form" ? [control] : []; }
      click() { clicks++; }
    }
    const form = new Element("form"), control = new Element("control"), toggle = new Element("toggle"), menu = new Element("menu");
    const page: BrowserPageAutomation = {
      async evaluate(source, argument) {
        if (!source.includes("chatgpt-tela-model-picker-activate-v1")) return {
          controlCount: 1, controlOpen: true, menuCount: 1, view: "simple", families: [],
        } as never;
        const result = runInNewContext(`(${source})(input)`, {
          input: argument, HTMLElement: Element,
          getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
          document: { querySelectorAll: () => [new Element("composer")], getElementById: () => menu },
        });
        activationOk = result.ok;
        throw new Error("fixture stopped after real activation predicate");
      },
      async pressKey() {}, async pointerClick() { throw Error("unexpected fallback"); },
      async typeFocusedEditable() {}, async clearFocusedEditable() {},
      async mutationRevision() { return 0; }, async waitForDomMutation() { return 1; },
    };
    const surface = pickerSurface(page);
    await expect(selectChatGptWebModel(surface, { familyKey: chatGptWebFamilyKey("Fixture"), effort: "low" })).rejects.toThrow();
    expect(activationOk).toBe(scenario.expected); expect(clicks).toBe(scenario.expected ? 1 : 0);
  });
}

// Exercise the actual renderer observation, rather than returning a fabricated snapshot.
for (const scenario of [
  { name: "open menu with transparent presentation", open: true, rendered: true, expected: 1 },
  { name: "closed retained menu", open: false, rendered: true, expected: 0 },
  { name: "open control without rendered menu", open: true, rendered: false, expected: 0 },
]) {
  test(`picker uses owned open state: ${scenario.name}`, async () => {
    let observation: { menuCount: number; controlOpen: boolean } | undefined;
    let activations = 0;
    class Element {
      isConnected = true;
      constructor(readonly kind: string) {}
      getClientRects() { return this.kind === "menu" && !scenario.rendered ? [] : [{}]; }
      getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; }
      getAttribute(name: string) {
        if (this.kind !== "control") return null;
        if (name === "aria-controls") return "fixture-menu";
        if (name === "aria-expanded") return String(scenario.open);
        return null;
      }
      closest() { return form; }
      querySelector() { return null; }
      querySelectorAll() { return this.kind === "form" ? [control] : []; }
      contains(element: unknown) { return element === this; }
    }
    const composer = new Element("composer"), form = new Element("form");
    const control = new Element("control"), menu = new Element("menu");
    const page: BrowserPageAutomation = {
      async evaluate(source) {
        if (source.includes("chatgpt-tela-model-picker-activate-v1")) { activations++; throw Error("unexpected activation"); }
        observation = runInNewContext(`(${source})()`, {
          HTMLElement: Element,
          getComputedStyle: (element: Element) => ({
            display: element.kind === "menu" && !scenario.rendered ? "none" : "block",
            visibility: "visible", opacity: element.kind === "menu" ? "0" : "1",
          }),
          document: {
            querySelectorAll: (selector: string) => selector.includes("prompt-textarea") ? [composer]
              : selector.includes("button[") ? [control] : [],
            getElementById: () => menu, elementFromPoint: () => control,
            hasFocus: () => false, hidden: true, readyState: "complete", activeElement: control,
          },
        });
        throw Error("fixture observation complete");
      },
      async pressKey() { activations++; }, async pointerClick() { activations++; },
      async typeFocusedEditable() {}, async clearFocusedEditable() {},
      async mutationRevision() { return 0; }, async waitForDomMutation() { return 1; },
    };
    const surface = pickerSurface(page);
    await expect(selectChatGptWebModel(surface, { familyKey: chatGptWebFamilyKey("Fixture"), effort: "low" }))
      .rejects.toThrow("fixture observation complete");
    expect(observation).toMatchObject({ menuCount: scenario.expected, controlOpen: scenario.open });
    expect(activations).toBe(0);
  });
}
