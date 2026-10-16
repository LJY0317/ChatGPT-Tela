import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "bun:test";
import {
  BROWSER_PAGE_AUTOMATION,
  ControlledBrowserHost,
  type BrowserPageAutomation,
} from "@chatgpt-tela/browser-host";
import {
  CHATGPT_CURRENT_COMPOSER_SELECTOR,
  ChatGptDomSurfaceDriver,
} from "./dom-driver";
import { authorFingerprint } from "./turn-ownership";
import { ChatGptSemanticProvider } from "./semantic-provider";

type RawSnapshot = {
  url: string;
  composers: Array<{
    key: string;
    visible: boolean;
    editable: boolean;
    ownedByChatGptForm: boolean;
    text: string;
    connectorNames: string[];
  }>;
  sendControls: Array<{
    key: string;
    composerKey: string;
    visible: boolean;
    enabled: boolean;
    semantic: "send";
  }>;
  turns: Array<Record<string, unknown>>;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

class FakePage implements BrowserPageAutomation {
  raw: RawSnapshot = {
    url: "https://chatgpt.com/",
    composers: [{
      key: "composer:primary",
      visible: true,
      editable: true,
      ownedByChatGptForm: true,
      text: "draft secret",
      connectorNames: [],
    }],
    sendControls: [{
      key: "send:composer:primary",
      composerKey: "composer:primary",
      visible: true,
      enabled: true,
      semantic: "send",
    }],
    turns: [{
      key: "user:t1",
      role: "user",
      contentText: "private user content",
    }],
  };
  approval = {cardCount:0,denyCount:0,allowCount:0,allowOnceCount:0,alwaysAllowCount:0,unknownCount:0,cardKey:null as string|null,proofKey:null as string|null};
  readonly mutations: Array<() => void> = [];
  readonly actions: string[] = [];
  lastObserveSource = "";
  pendingConnectorName: string | undefined;
  forceMentionFailure = false;
  addContextMenuOpen = false;
  addContextHighlightedIndex = 0;
  addContextTargetIndex = 2;
  addContextConnectorName: string | undefined;
  #mutationRevision = 0;

  async evaluate<Argument, Result>(source: string, argument: Argument): Promise<Result> {
    if (source.includes('const cards =') && source.includes('tool-approval-card')) return structuredClone(this.approval) as Result;
    if (source.includes("return { url: location.href, composers, sendControls, turns }")) {
      this.lastObserveSource = source;
      return structuredClone(this.raw) as Result;
    }
    if (source.includes("ChatGPT composer rejected plain-text insertion")) {
      const input = argument as { composerKey: string; text: string };
      this.actions.push(`fill:${input.composerKey}`);
      this.raw = {
        ...this.raw,
        composers: this.raw.composers.map(composer => composer.key === input.composerKey
          ? { ...composer, text: input.text }
          : composer),
      };
      return undefined as Result;
    }
    if (source.includes("ChatGPT composer rejected appended plain text")) {
      const input = argument as { composerKey: string; text: string };
      this.actions.push(`append:${input.composerKey}`);
      const normalized = input.text.trimStart();
      this.raw = {
        ...this.raw,
        composers: this.raw.composers.map(composer => composer.key === input.composerKey
          ? { ...composer, text: normalized }
          : composer),
      };
      return undefined as Result;
    }
    if (source.includes("ChatGPT connector selection refuses a non-empty composer")) {
      const input = argument as { composerKey: string; connectorName: string };
      const composer = this.raw.composers.find(item => item.key === input.composerKey);
      if (composer?.connectorNames[0] === input.connectorName) return "selected" as Result;
      if (composer?.text) throw new Error("fixture connector preparation requires an empty composer");
      this.actions.push(`connector-focus:${input.connectorName}`);
      return "ready" as Result;
    }
    if (source.includes("ChatGPT connector target lookup timed out")) {
      const input = argument as { connectorName: string };
      if (this.pendingConnectorName !== input.connectorName) {
        throw new Error("fixture connector query was not typed before lookup");
      }
      if (this.forceMentionFailure) throw new Error("fixture mention lookup unavailable");
      return { x: 25, y: 40 } as Result;
    }
    if (source.includes("ChatGPT add-context control is not unique")) {
      return { x: 10, y: 20 } as Result;
    }
    if (source.includes("ChatGPT add-context menu exposed no recognized connector path")) {
      const input = argument as { connectorName: string };
      if (!this.addContextMenuOpen) throw new Error("fixture add-context menu is closed");
      this.addContextConnectorName = input.connectorName;
      return {
        kind: "connector",
        x: 75,
        y: 80,
        rowCount: 3,
        targetIndex: this.addContextTargetIndex,
        highlighted: this.addContextHighlightedIndex === this.addContextTargetIndex,
        highlightedIndex: this.addContextHighlightedIndex,
        categoryShapes: [],
        genericAttributeShapes: [],
      } as Result;
    }
    if (source.includes("ChatGPT connector activation timed out")) {
      const input = argument as { composerKey: string; connectorName: string };
      const composer = this.raw.composers.find(item => item.key === input.composerKey);
      if (composer?.connectorNames[0] !== input.connectorName) {
        throw new Error("fixture connector was not activated");
      }
      return undefined as Result;
    }
    if (source.includes("send.click()")) {
      const input = argument as { controlKey: string };
      this.actions.push(`send:${input.controlKey}`);
      return undefined as Result;
    }
    if (source.includes("composers[0].focus();")) {
      if ((argument as { composerKey?: string }).composerKey !== "composer:primary") {
        throw new Error("ChatGPT current composer is not uniquely addressable");
      }
      return undefined as Result;
    }
    throw new Error("unexpected fixture page operation");
  }

  async pointerClick(point: { readonly x: number; readonly y: number }): Promise<void> {
    this.actions.push(`pointer:${point.x},${point.y}`);
    if (point.x === 10 && point.y === 20) {
      this.addContextMenuOpen = true;
      return;
    }
    const connectorName = this.pendingConnectorName;
    if (!connectorName) throw new Error("fixture has no pending connector target");
    this.raw = {
      ...this.raw,
      composers: this.raw.composers.map(composer => composer.key === "composer:primary"
        ? { ...composer, text: "", connectorNames: [connectorName] }
        : composer),
    };
    this.pendingConnectorName = undefined;
  }

  async typeFocusedEditable(text: string): Promise<void> {
    this.actions.push(`type:${text}`);
    if (!text.startsWith("@") || text.length < 2) throw new Error("fixture expected one connector mention query");
    const connectorName = text.slice(1);
    this.pendingConnectorName = connectorName;
    this.raw = {
      ...this.raw,
      composers: this.raw.composers.map(composer => composer.key === "composer:primary"
        ? { ...composer, text }
        : composer),
    };
  }

  async pressKey(keyCode: string): Promise<void> {
    this.actions.push(`key:${keyCode}`);
    if (keyCode === "Escape") {
      this.addContextMenuOpen = false;
      return;
    }
    if (this.addContextMenuOpen && keyCode === "ArrowDown") {
      this.addContextHighlightedIndex = (this.addContextHighlightedIndex + 1) % 3;
      return;
    }
    if (this.addContextMenuOpen && keyCode === "Enter"
      && this.addContextHighlightedIndex === this.addContextTargetIndex
      && this.addContextConnectorName) {
      const connectorName = this.addContextConnectorName;
      this.raw = {
        ...this.raw,
        composers: this.raw.composers.map(composer => composer.key === "composer:primary"
          ? { ...composer, text: "", connectorNames: [connectorName] }
          : composer),
      };
      this.pendingConnectorName = undefined;
      this.addContextMenuOpen = false;
    }
  }

  async clearFocusedEditable(): Promise<void> {
    this.actions.push("clear-focused");
    this.raw = {
      ...this.raw,
      composers: this.raw.composers.map(composer => ({ ...composer, text: "", connectorNames: [] })),
    };
  }

  async mutationRevision(): Promise<number> {
    return this.#mutationRevision;
  }

  async waitForDomMutation(afterRevision: number): Promise<number> {
    if (this.#mutationRevision > afterRevision) return this.#mutationRevision;
    const mutation = this.mutations.shift();
    if (!mutation) throw new Error("fixture has no queued DOM mutation");
    mutation();
    this.#mutationRevision += 1;
    return this.#mutationRevision;
  }
}

// Execute the actual renderer script against a synthetic DOM capability fixture.
// No captured conversation text or real DOM is a test input.
class FixtureElement {
  readonly nodeType = 1;
  get tagName() { return this.attributes["data-fixture-tag"] ?? "DIV"; }
  textContent = "";
  innerText = "";
  get children() { return this.childNodes.filter((node): node is FixtureElement => node instanceof FixtureElement); }
  childNodes: Array<FixtureElement | { nodeType?: number; textContent: string }> = [];
  disabled = false;
  isConnected = true;
  scrollIntoView() {}
  contains(element: unknown) { return element === this; }
  constructor(readonly attributes: Record<string, string> = {}, readonly selectors: Record<string, FixtureElement[]> = {}) {}
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  querySelectorAll(selector: string): FixtureElement[] {
    return [...new Set(selector.split(/,\s*/).flatMap(part => this.selectors[part] ?? []))];
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 20, height: 20 }; }
  closest() { return this.selectors.form?.[0] ?? null; }
  cloneNode() { return this; }
}

class RendererFixturePage extends FakePage {
  readonly rendererState: Record<string | symbol, unknown> = {};
  animationFrame: (callback: () => void) => void = callback => callback();
  hitTest = () => this.document.querySelectorAll('[data-codex-approval-surface="true"]')[0]
    ?.querySelectorAll("button").find(b => b.textContent.startsWith("Allow once"));
  constructor(readonly document: FixtureElement) { super(); }
  override async evaluate<Argument, Result>(source: string, argument: Argument): Promise<Result> {
    if (source.includes("return { url: location.href, composers, sendControls, turns }") || source.includes("const cards =")) {
      return runInNewContext(`(${source})(argument)`, Object.assign(this.rendererState, {
        argument, innerWidth: 800, innerHeight: 600, requestAnimationFrame: (callback: () => void) => this.animationFrame(callback),
        document: Object.assign(this.document, { documentElement: this.document, elementFromPoint: this.hitTest }), HTMLElement: FixtureElement, HTMLButtonElement: FixtureElement,
        getComputedStyle: (element: FixtureElement) => ({ display: element.getAttribute("data-fixture-display") ?? "block", visibility: element.getAttribute("data-fixture-visibility") ?? "visible", opacity: element.getAttribute("data-fixture-opacity") ?? "1" }),
        location: { href: "https://chatgpt.com/" }, crypto: { randomUUID: () => "synthetic-card" },
      })) as Result;
    }
    return super.evaluate(source, argument);
  }
}

describe("current ChatGPT DOM surface driver", () => {
  test("exact composer focus for trusted synthetic typing never changes or submits a draft", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);
    const original = structuredClone(page.raw);
    await driver.focusComposer("composer:primary");
    expect(page.raw).toEqual(original);
    expect(page.actions).toEqual([]);
    await expect(driver.focusComposer("not-a-composer")).rejects.toThrow("not uniquely addressable");
    expect(page.raw).toEqual(original);
  });
  test("question identity survives fold, visibility and action-label changes; author edits still change proof", async () => {
    const author = new FixtureElement(); author.textContent = "First line\nSecond line";
    const user = new FixtureElement({}, { '[data-search-result-target]': [author] });
    user.innerText = "First line Show more";
    const group = new FixtureElement({ 'data-turn-key': 'owned' }, { '[data-user-message-bubble]': [user] });
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] })));
    const initial = (await driver.observe()).turns[0]!;
    user.innerText = "First line\nSecond line Show less Copy Edit";
    author.attributes['data-fixture-display'] = 'none';
    expect((await driver.observe()).turns[0]!.contentFingerprint).toBe(initial.contentFingerprint);
    author.textContent = "Different question";
    expect((await driver.observe()).turns[0]!.contentFingerprint).not.toBe(initial.contentFingerprint);
    user.selectors['[data-search-result-target]'] = [];
    expect((await driver.observe()).turns[0]!).toMatchObject({ userPayloadReason: 'author_root_missing' });
    expect((await driver.observe()).turns[0]!.contentFingerprint).toBeUndefined();
    user.selectors['[data-search-result-target]'] = [author, new FixtureElement()];
    expect((await driver.observe()).turns[0]!.contentFingerprint).toBeUndefined();
    expect((await driver.observe()).turns[0]!.userPayloadStructure).toEqual({ rootCount: 2, nestedRoots: false });
  });
  test("serialized renderer separates unequal nested alternatives from proven author identity", async () => {
    const outer = new FixtureElement(), inner = new FixtureElement();
    outer.textContent = inner.textContent = "Full author text\n한글 😀";
    outer.contains = node => node === outer || node === inner;
    const user = new FixtureElement({}, { '[data-search-result-target]': [inner] });
    const anchor = new FixtureElement({ 'data-content-search-turn-key': 'logical-owned' });
    const group = new FixtureElement({ 'data-turn-key': 'owned' }, { '[data-user-message-bubble]': [user], '[data-content-search-turn-key]': [anchor] });
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({ 'data-page-load-id': 'document-owned' }, { '[data-turn-key]': [group] })));
    const original = (await driver.observe()).turns[0]!.contentFingerprint;
    expect(original).toBeDefined();
    user.selectors['[data-search-result-target]'] = [inner, outer];
    user.innerText = "folded preview Show more Copy Edit";
    expect((await driver.observe()).turns[0]!).toMatchObject({ contentFingerprint: original,
      userPayloadStructure: { rootCount: 2, nestedRoots: true, equivalentRoots: true } });
    outer.textContent += " Edit";
    const divergent = (await driver.observe()).turns[0]!;
    expect(divergent.contentFingerprint).toBeUndefined();
    expect(divergent.userPayloadStructure).toMatchObject({ rootCount: 2, nestedRoots: true, equivalentRoots: false });
    expect(divergent.candidateFingerprints).toContain(original!);
    expect(divergent.candidateFingerprints).toHaveLength(2);
    expect(authorFingerprint(divergent, original!)).toBe(original!);
    expect(authorFingerprint(divergent, "foreign-expected")).toBeUndefined();
    outer.textContent = inner.textContent = "Edited author text";
    expect((await driver.observe()).turns[0]!.contentFingerprint).not.toBe(original);
  });
  test("actual renderer separates exact plain-body receipt proof from Markdown escaping", async () => {
    const receipt = "TELA_CONTEXT_ACK ctxr_" + "a".repeat(32);
    const body = new FixtureElement({ 'data-markdown-text-style': 'assistant-message' });
    body.innerText = receipt; body.textContent = receipt;
    body.childNodes = [{ nodeType: 3, textContent: receipt }];
    const copy = new FixtureElement();
    const group = new FixtureElement({ 'data-turn-key': 'synthetic-receipt' }, {
      '[data-markdown-text-style="assistant-message"]': [body],
      'button[data-testid="copy-turn-action-button"]': [copy],
    });
    const page = new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] }));
    const observation = (await new ChatGptDomSurfaceDriver(page).observe()).turns[0]!;
    expect(observation.phase).toBe("complete");
    expect(observation.text).toBe(receipt.replaceAll("_", "\\_"));
    expect(observation.plainBodyText).toBe(receipt);
    expect(observation.plainBodyFingerprint).toBe(digest(receipt));
    expect(observation.bodyProof?.digest).toBeDefined();
    expect(observation.contentFingerprint).toBeUndefined();
  });

  test("logical document/turn identity survives optimistic-key replacement and an unrendered user", async () => {
    const anchor = new FixtureElement({ 'data-content-search-turn-key': 'synthetic-logical-turn' });
    const user = new FixtureElement(); user.innerText = 'synthetic request';
    const group = new FixtureElement({ 'data-turn-key': 'optimistic-renderer-key' }, {
      '[data-content-search-turn-key]': [anchor], '[data-user-message-bubble]': [user],
    });
    const document = new FixtureElement({ 'data-page-load-id': 'synthetic-document' }, { '[data-turn-key]': [group] });
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(document));
    const accepted = (await driver.observe()).turns[0]!;
    expect(accepted.lineageAnchor).toBeDefined();
    group.attributes['data-turn-key'] = 'synthetic-logical-turn';
    group.selectors['[data-user-message-bubble]'] = [];
    const body = new FixtureElement(); body.innerText = 'synthetic answer';
    group.selectors['[data-markdown-text-style="assistant-message"]'] = [body];
    group.selectors['button[data-testid="copy-turn-action-button"]'] = [new FixtureElement()];
    const final = (await driver.observe()).turns[0]!;
    expect(final).toMatchObject({ role: 'assistant', phase: 'complete', parentUserTurnKey: accepted.key,
      lineageAnchor: accepted.lineageAnchor, text: 'synthetic answer' });
    document.attributes['data-page-load-id'] = 'replacement-document';
    const replacement = (await driver.observe()).turns[0]!;
    expect(replacement.lineageAnchor).not.toBe(accepted.lineageAnchor);
    expect(replacement.parentUserTurnKey).not.toBe(accepted.key);
  });

  test.each(['duplicate', 'nested', 'multiple-anchors', 'no-document'] as const)(
    "unproven logical anchor is not promoted: %s", async mode => {
      const anchor = new FixtureElement({ 'data-content-search-turn-key': 'synthetic-logical-turn' });
      const group = new FixtureElement({ 'data-turn-key': 'renderer-key' }, {
        '[data-content-search-turn-key]': [anchor], '[data-user-message-bubble]': [new FixtureElement()],
      });
      const other = new FixtureElement({ 'data-turn-key': 'other-renderer-key' }, {
        '[data-content-search-turn-key]': [anchor], '[data-user-message-bubble]': [new FixtureElement()],
      });
      if (mode === 'nested') group.selectors['[data-turn-key]'] = [other];
      if (mode === 'multiple-anchors') group.selectors['[data-content-search-turn-key]'] = [anchor,
        new FixtureElement({ 'data-content-search-turn-key': 'other-logical-turn' })];
      const document = new FixtureElement(mode === 'no-document' ? {} : { 'data-page-load-id': 'synthetic-document' }, {
        '[data-turn-key]': mode === 'duplicate' ? [group, other] : [group],
      });
      const turns = (await new ChatGptDomSurfaceDriver(new RendererFixturePage(document)).observe()).turns;
      expect(turns.every(turn => turn.lineageAnchor === undefined)).toBe(true);
      expect(turns[0]?.key).toBe('user:renderer-key');
    },
  );
  test.each(["valid", "duplicate-marker", "answer-in-shell", "foreign-label"])("agent status shell requires unique owned accessible title (%s)", async variant => {
    const label = new FixtureElement({ id: 'public-label' }); label.innerText = "Checking the source";
    const button = new FixtureElement({ 'aria-expanded': 'false', 'aria-labelledby': variant === "foreign-label" ? 'outside' : 'public-label' });
    const description = new FixtureElement(); description.childNodes = [{ nodeType: 3, textContent: 'Reading the submitted context.' }];
    const shell = new FixtureElement({}, { 'button[aria-expanded][aria-labelledby]': [button], '[id]': [label],
      ...(variant === 'answer-in-shell' ? { '[data-markdown-text-style="assistant-message"]': [new FixtureElement()] } : {}) });
    shell.childNodes = [button, label, description];
    const marker = Object.assign(new FixtureElement(), { parentElement: shell });
    const group = new FixtureElement({ 'data-turn-key': 'synthetic-agent' }, {
      '[data-chatgpt-agent-turn-start]': variant === 'duplicate-marker' ? [marker, new FixtureElement()] : [marker],
    });
    group.contains = node => node === shell;
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] })));
    const result = await driver.observe();
    expect(result.turns[0]?.publicProgress ?? []).toEqual(variant === 'valid'
      ? ['Checking the source\n\nReading the submitted context.'] : []);
  });
  test("actual renderer reads only visible description inside the owned public progress row", async () => {
    const title = new FixtureElement({ 'data-fixture-tag': 'BUTTON' });
    title.innerText = "Checking records";
    const description = new FixtureElement();
    description.childNodes = [{ nodeType: 3, textContent: "Reading the current execution record." }];
    const hidden = new FixtureElement({ 'hidden': '' });
    hidden.childNodes = [{ nodeType: 3, textContent: "HIDDEN_CONTENT" }];
    const control = new FixtureElement({ 'data-fixture-tag': 'BUTTON' });
    control.childNodes = [{ nodeType: 3, textContent: "CONTROL_CONTENT" }];
    const row = new FixtureElement({}, { 'button[aria-expanded]': [title] });
    row.childNodes = [title, description, hidden, control];
    const progress = new FixtureElement({}, { '[data-item-anchor]': [row] });
    const body = new FixtureElement(); body.innerText = "FINAL_CONTENT";
    const group = new FixtureElement({ 'data-turn-key': 'synthetic-public-progress' }, {
      '[data-markdown-text-style="assistant-message"]': [body],
      '[data-streaming-response-status]': [progress],
    });
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] })));
    const result = await driver.observe();
    expect(result.turns[0]?.publicProgress).toEqual(["Checking records\n\nReading the current execution record."]);
    expect(result.turns[0]?.publicProgress?.join()).not.toMatch(/HIDDEN_CONTENT|CONTROL_CONTENT|FINAL_CONTENT/);
  });
  test.each(["control-hidden", "label-hidden", "foreign-label", "valid"])("progress probe distinguishes the rejected boundary without exposing prose (%s)", async mode => {
    const scratch = mkdtempSync(join(tmpdir(), "tela-progress-boundary-"));
    const file = join(scratch, "events.jsonl");
    const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
    try {
      const label = new FixtureElement({ id: "private-label" }); label.innerText = "PRIVATE_PROGRESS";
      const button = new FixtureElement({ "aria-expanded": "false", "aria-labelledby": mode === "foreign-label" ? "foreign" : "private-label" });
      if (mode === "control-hidden") button.getClientRects = () => [];
      if (mode === "label-hidden") label.getClientRects = () => [];
      const shell = new FixtureElement({}, { "button[aria-expanded][aria-labelledby]": [button], "[id]": [label] });
      shell.childNodes = [button, label];
      const marker = Object.assign(new FixtureElement(), { parentElement: shell });
      const group = new FixtureElement({ "data-turn-key": "private-response" }, { "[data-chatgpt-agent-turn-start]": [marker] });
      group.contains = node => node === shell;
      const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, { "[data-turn-key]": [group] })));
      const first = await driver.observe();
      await driver.observe();
      label.innerText = "PRIVATE_CHANGED_TEXT";
      await driver.observe();
      const log = readFileSync(file, "utf8");
      const rows = log.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.stage === "web_public_progress_extraction");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ assistant_phase: "thinking", progress_container_visible: true,
        progress_control_count: 1, progress_visible_control_count: mode === "control-hidden" ? 0 : 1,
        progress_local_label_count: mode === "control-hidden" || mode === "foreign-label" ? 0 : 1,
        progress_visible_label_count: mode === "valid" ? 1 : 0,
        progress_title_count: mode === "valid" ? 1 : 0 });
      expect(first.turns[0]?.publicProgress?.length ?? 0).toBe(mode === "valid" ? 1 : 0);
      expect(log).not.toMatch(/PRIVATE_|private-label|private-response|foreign/);
    } finally {
      if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  test.each(["contents", "none", "opacity-zero", "no-box"])("container layout distinguishes rendered contents from hidden and boxless blocks (%s)", async mode => {
    const scratch = mkdtempSync(join(tmpdir(), "tela-layout-probe-"));
    const file = join(scratch, "events.jsonl"), prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
    try {
      const label = new FixtureElement({ id: "private-layout-label" }); label.innerText = "PRIVATE_TITLE";
      const control = new FixtureElement({ "aria-expanded": "false", "aria-labelledby": "private-layout-label" });
      const shell = new FixtureElement({ "data-fixture-display": mode === "contents" || mode === "none" ? mode : "block",
        "data-fixture-opacity": mode === "opacity-zero" ? "0" : "1" }, {
        'button[aria-expanded][aria-labelledby]': [control], '[id]': [label],
      });
      shell.getClientRects = () => [];
      shell.childNodes = [control, label];
      const marker = Object.assign(new FixtureElement(), { parentElement: shell });
      const group = new FixtureElement({ 'data-turn-key': 'private-layout-turn' }, { '[data-chatgpt-agent-turn-start]': [marker] });
      group.contains = node => node === shell;
      const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] })));
      const snapshot = await driver.observe(); await driver.observe();
      expect(snapshot.turns[0]?.publicProgress ?? []).toEqual(mode === "contents" ? ["PRIVATE_TITLE"] : []);
      const log = readFileSync(file, "utf8");
      const rows = log.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.stage === "web_public_progress_extraction");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ progress_container_visible: false, progress_container_has_rects: false,
        progress_container_display: mode === "contents" || mode === "none" ? mode : "other",
        progress_container_opacity_zero: mode === "opacity-zero", progress_owned_control_count: 1,
        progress_owned_visible_control_count: 1, progress_owned_local_label_count: 1, progress_owned_visible_label_count: 1 });
      expect(log).not.toMatch(/PRIVATE_TITLE|private-layout/);
    } finally {
      if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  test.each(["visible", "hidden", "aria-hidden", "none", "opacity-zero", "visibility-hidden"])("contents progress preserves descriptions but excludes hidden ancestors (%s)", async mode => {
    const outer = new FixtureElement({ ...(mode === "hidden" ? { hidden: "" } : {}),
      ...(mode === "aria-hidden" ? { "aria-hidden": "true" } : {}),
      ...(mode === "none" ? { "data-fixture-display": "none" } : {}),
      ...(mode === "opacity-zero" ? { "data-fixture-opacity": "0" } : {}),
      ...(mode === "visibility-hidden" ? { "data-fixture-visibility": "hidden" } : {}) });
    const title = new FixtureElement({ id: "label" }); title.innerText = "Public title"; title.childNodes = [{ nodeType: 3, textContent: "Public title" }];
    const control = new FixtureElement({ "aria-expanded": "false", "aria-labelledby": "label" });
    const body = new FixtureElement({ "data-fixture-display": "contents" }); body.getClientRects = () => [];
    const paragraph = new FixtureElement(); paragraph.childNodes = [{ nodeType: 3, textContent: "Public description" }];
    const secret = new FixtureElement({ "aria-hidden": "true" }); secret.childNodes = [{ nodeType: 3, textContent: "HIDDEN_DESCRIPTION" }];
    body.childNodes = [paragraph, secret];
    const shell = new FixtureElement({ "data-fixture-display": "contents" }, { 'button[aria-expanded][aria-labelledby]': [control], '[id]': [title] });
    shell.getClientRects = () => []; shell.childNodes = [control, title, body];
    Object.assign(shell, { parentElement: outer });
    for (const child of shell.children) Object.assign(child, { parentElement: shell });
    for (const child of body.children) Object.assign(child, { parentElement: body });
    const marker = Object.assign(new FixtureElement({ hidden: "" }), { parentElement: shell });
    const group = new FixtureElement({ 'data-turn-key': 'fixture' }, { '[data-chatgpt-agent-turn-start]': [marker] });
    group.contains = node => node === shell;
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] })));
    const result = await driver.observe();
    expect(result.turns[0]?.publicProgress ?? []).toEqual(mode === "visible" ? ["Public title\n\nPublic description"] : []);
    expect(JSON.stringify(result.turns)).not.toContain("HIDDEN_DESCRIPTION");
  });
  test.each([false, true])("settled progress extraction reports title coverage=%s once without prose", async titlePresent => {
    const scratch = mkdtempSync(join(tmpdir(), "tela-progress-extraction-"));
    const file = join(scratch, "events.jsonl");
    const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
    try {
      const title = new FixtureElement(); title.innerText = "PRIVATE_VISIBLE_PROGRESS";
      const anchor = new FixtureElement({}, titlePresent ? { 'button[aria-expanded]': [title] } : {});
      anchor.innerText = "PRIVATE_VISIBLE_EXPLANATION";
      const progress = new FixtureElement({}, { '[data-item-anchor]': [anchor] });
      const body = new FixtureElement(); body.innerText = "PRIVATE_FINAL";
      const group = new FixtureElement({ 'data-turn-key': 'synthetic-response' }, {
        '[data-markdown-text-style="assistant-message"]': [body],
        '[data-streaming-response-status]': [progress],
        'button[data-testid="copy-turn-action-button"]': [new FixtureElement()],
      });
      const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] })));
      const first = await driver.observe();
      const second = await driver.observe();
      expect(second.revision).toBe(first.revision);
      expect(first.turns[0]?.publicProgress?.length ?? 0).toBe(titlePresent ? 1 : 0);
      const log = readFileSync(file, "utf8");
      const rows = log.trim().split("\n").map(line => JSON.parse(line))
        .filter(row => row.stage === "web_public_progress_extraction");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ progress_container_present: true, progress_anchor_count: 1,
        progress_title_count: titlePresent ? 1 : 0, public_progress_part_count: titlePresent ? 1 : 0 });
      expect(log).not.toMatch(/PRIVATE_|synthetic-response/);
    } finally {
      if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  test.each(["surface_read", "approval_read", "snapshot_projection"] as const)(
    "observation failure records only the fixed %s boundary", async phase => {
      const scratch = mkdtempSync(join(tmpdir(), "tela-observation-diagnostic-"));
      const file = join(scratch, "events.jsonl");
      const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
      const page = new FakePage();
      const original = page.evaluate.bind(page);
      const injected = new TypeError("SYNTHETIC_PRIVATE_EVIDENCE");
      page.evaluate = async <Argument, Result>(source: string, argument: Argument): Promise<Result> => {
        const surfaceRead = source.includes("return { url: location.href, composers, sendControls, turns }");
        if ((phase === "surface_read" && surfaceRead)
          || (phase === "approval_read" && source.includes("const cards ="))) throw injected;
        if (phase === "snapshot_projection" && surfaceRead) return { ...page.raw, turns: null } as Result;
        return original<Argument, Result>(source, argument);
      };
      try {
        const pending = new ChatGptDomSurfaceDriver(page).observe();
        if (phase === "snapshot_projection") await expect(pending).rejects.toBeInstanceOf(TypeError);
        else await expect(pending).rejects.toBe(injected);
        const raw = readFileSync(file, "utf8");
        expect(raw).not.toContain("SYNTHETIC_PRIVATE_EVIDENCE");
        expect(JSON.parse(raw.trim())).toMatchObject({ stage: "web_dom_observation_failed", phase, reason_class: "type_error" });
      } finally {
        if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
        else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
  test("recognizes a body-only assistant in its keyed turn and does not complete progress text", async () => {
    const body = new FixtureElement(); body.innerText = "synthetic progress";
    const user = new FixtureElement(); user.innerText = "synthetic request";
    const group = new FixtureElement({ "data-turn-key": "t1" }, {
      '[data-user-message-bubble]': [user],
      '[data-markdown-text-style="assistant-message"]': [body],
    });
    const page = new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] }));
    const driver = new ChatGptDomSurfaceDriver(page);
    const progress = await driver.observe();
    expect(progress.turns.map(row => row.role)).toEqual(["user", "assistant"]);
    expect(progress.turns[1]).toMatchObject({ key: "assistant:t1", parentUserTurnKey: "user:t1", phase: "thinking" });
    expect(progress.turns[1]?.text).toBe("synthetic progress");
    group.selectors['button[data-testid="copy-turn-action-button"]'] = [new FixtureElement()];
    const completed = await driver.observe();
    expect(completed.turns[1]).toMatchObject({ phase: "complete", text: "synthetic progress" });
    expect(completed.revision).not.toBe(progress.revision);
  });

  test("generic user markdown cannot become an assistant", async () => {
    const group = new FixtureElement({ "data-turn-key": "t1" }, {
      '[data-user-message-bubble]': [new FixtureElement()], '.markdown': [new FixtureElement()],
    });
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] })));
    expect((await driver.observe()).turns.map(row => row.role)).toEqual(["user"]);
  });

  test("retained assistant body survives hidden action controls during a follow-up", async () => {
    const body = new FixtureElement(); body.innerText = "synthetic committed answer";
    const copy = new FixtureElement();
    const group = new FixtureElement({ "data-turn-key": "prior" }, {
      '[data-markdown-text-style="assistant-message"]': [body],
      'button[data-testid="copy-turn-action-button"]': [copy],
    });
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, {
      '[data-turn-key]': [group],
    })));
    const before = await driver.observe();
    expect(before.turns[0]).toMatchObject({ phase: "complete", text: "synthetic committed answer" });
    copy.attributes['data-fixture-opacity'] = '0';
    const after = await driver.observe();
    expect(after.turns[0]?.phase).not.toBe("complete");
    expect(after.turns[0]?.text).toBe(before.turns[0]?.text);
  });

  test("owned answer identity survives CSS visibility but rejects changed author content", async () => {
    const paragraph = new FixtureElement();
    const author = { nodeType: 3, textContent: "Exact retained author content" };
    paragraph.childNodes = [author];
    const body = new FixtureElement(); body.childNodes = [paragraph];
    const group = new FixtureElement({ "data-turn-key": "prior" }, {
      '[data-markdown-text-style="assistant-message"]': [body],
      'button[data-testid="copy-turn-action-button"]': [new FixtureElement()],
    });
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] })));
    const before = (await driver.observe()).turns[0]!;
    paragraph.attributes["data-fixture-display"] = "none";
    const hidden = (await driver.observe()).turns[0]!;
    expect(hidden.text).not.toBe(before.text);
    expect(hidden.bodyProof?.digest).toBe(before.bodyProof?.digest);
    author.textContent = "Changed author content";
    expect((await driver.observe()).turns[0]!.bodyProof?.digest).not.toBe(before.bodyProof?.digest);
  });

  test("current approval surface is observed but an unknown options button stays manual", async () => {
    const buttons = ["Deny", "Allow", "Approval options"].map(label => {
      const button = new FixtureElement(); button.innerText = label; return button;
    });
    const card = new FixtureElement({}, { button: buttons });
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, {
      '[data-codex-approval-surface="true"]': [card],
    })));
    const observed = await driver.observe();
    expect(observed.approval).toMatchObject({ cardCount: 1, denyCount: 1, allowCount: 1, allowOnceCount: 0, unknownCount: 1 });
    expect(await driver.processApprovalCard("recognized_once")).toEqual({ status: "none", reason: "ambiguous" });
  });
  test("accessible one-shot approval excludes hidden keyboard hints and explicit disclosures", async () => {
    const control = (label: string, hint: string) => {
      const button = new FixtureElement();
      const text = new FixtureElement(); text.textContent = label;
      const shortcut = new FixtureElement({ "aria-hidden": "true" }); shortcut.textContent = hint;
      button.childNodes = [text, shortcut];
      button.textContent = label + hint;
      return button;
    };
    const details = new FixtureElement({ "aria-haspopup": "dialog" }); details.textContent = "See details";
    const options = new FixtureElement({ "aria-label": "Approval options", "aria-haspopup": "menu" });
    const card = new FixtureElement({}, { button: [details, control("Deny", "Esc"), control("Allow once", "⏎"), options] });
    const page = new RendererFixturePage(new FixtureElement({}, {
      '[data-codex-approval-surface="true"]': [card],
    }));
    let clicks = 0;
    page.pointerClick = async () => { clicks++; };
    const driver = new ChatGptDomSurfaceDriver(page);
    expect((await driver.observe()).approval).toMatchObject({ denyCount: 1, allowOnceCount: 1, unknownCount: 0 });
    expect((await driver.processApprovalCard("recognized_once")).status).toBe("dispatched");
    const unknown = new FixtureElement(); unknown.textContent = "Synthetic new decision";
    card.selectors.button!.push(unknown);
    expect((await driver.observe()).approval?.unknownCount).toBe(1);
    expect((await driver.processApprovalCard("recognized_once")).status).toBe("none");
    expect(clicks).toBe(1);
  });
  test("trusted receipt survives immediate removal in actual renderer script; synthetic clicks do not count", async () => {
    const deny = new FixtureElement(); deny.textContent = "Deny";
    const allow = new FixtureElement(); allow.textContent = "Allow once";
    let receive: ((event: { isTrusted: boolean }) => void) | undefined;
    Object.assign(allow, {
      addEventListener: (_name: string, callback: typeof receive, options: { capture: boolean }) => {
        expect(options.capture).toBe(true); receive = callback;
      },
      removeEventListener: () => {},
    });
    const card = new FixtureElement({}, { button: [deny, allow] });
    const document = new FixtureElement({}, { '[data-codex-approval-surface="true"]': [card] });
    const page = new RendererFixturePage(document);
    const driver = new ChatGptDomSurfaceDriver(page);
    const before = await driver.observe();
    let clicks = 0;
    page.pointerClick = async () => {
      clicks++;
      receive?.({ isTrusted: false });
      expect((await driver.observe()).approvalInputReceipt).toBeUndefined();
      receive?.({ isTrusted: true });
      document.selectors['[data-codex-approval-surface="true"]'] = [];
    };
    expect((await driver.processApprovalCard("recognized_once")).status).toBe("dispatched");
    const after = await driver.observe();
    expect(after.approval).toBeUndefined();
    expect(after.approvalInputReceipt).toEqual({ cardFingerprint: before.approval!.cardFingerprint!,
      revisionFingerprint: before.approval!.revisionFingerprint });
    expect((await driver.observe()).approvalInputReceipt).toEqual(after.approvalInputReceipt);
    expect(clicks).toBe(1);
  });
  test("hidden approval makes progress without requesting an animation frame or revealing a window", async () => {
    const deny = new FixtureElement(); deny.textContent = "Deny";
    const allow = new FixtureElement(); allow.textContent = "Allow once";
    let scrolled = false, frames = 0;
    allow.scrollIntoView = () => { scrolled = true; };
    allow.getBoundingClientRect = () => ({ left: 10, top: scrolled ? 20 : 1200, width: 20, height: 20 });
    const card = new FixtureElement({}, { button: [deny, allow] });
    const page = new RendererFixturePage(new FixtureElement({}, { '[data-codex-approval-surface="true"]': [card] }));
    page.animationFrame = () => { frames++; }; // Hidden renderer never delivers a frame callback.
    const clicks: { x: number; y: number }[] = [];
    page.pointerClick = async point => { clicks.push(point); };
    const owner = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        new ChatGptDomSurfaceDriver(page).processApprovalCard("recognized_once", owner.signal),
        new Promise<"frame_wait_stalled"> (resolve => { timer = setTimeout(() => resolve("frame_wait_stalled"), 100); }),
      ]);
      expect(outcome).toMatchObject({ status: "dispatched" });
      expect(scrolled).toBe(true); expect(frames).toBe(0);
      expect(clicks).toEqual([{ x: 20, y: 30 }]);
    } finally { clearTimeout(timer); owner.abort(); }
  });
  test.each(["replaced", "proof_changed", "disabled", "occluded", "outside", "ambiguous"])(
    "frame-independent approval still rejects a changed or unproven target (%s)", async mutation => {
      const deny = new FixtureElement(); deny.textContent = "Deny";
      const allow = new FixtureElement(); allow.textContent = "Allow once";
      const card = new FixtureElement({}, { button: [deny, allow] });
      const document = new FixtureElement({}, { '[data-codex-approval-surface="true"]': [card] });
      const page = new RendererFixturePage(document);
      page.animationFrame = () => { throw Error("must not wait for paint"); };
      allow.scrollIntoView = () => {
        if (mutation === "replaced") { document.selectors['[data-codex-approval-surface="true"]'] = []; allow.isConnected = false; }
        if (mutation === "proof_changed") card.textContent = "Synthetic changed approval arguments";
        if (mutation === "disabled") allow.disabled = true;
        if (mutation === "occluded") page.hitTest = () => new FixtureElement();
        if (mutation === "outside") allow.getBoundingClientRect = () => ({ left: 900, top: 0, width: 20, height: 20 });
        if (mutation === "ambiguous") { const other = new FixtureElement(); other.textContent = "Allow once"; card.selectors.button!.push(other); }
      };
      // The renderer holds one hit-test function for this evaluation; resolve the latest fixture state.
      page.hitTest = () => mutation === "occluded" ? new FixtureElement() : allow;
      let clicks = 0; page.pointerClick = async () => { clicks++; };
      expect((await new ChatGptDomSurfaceDriver(page).processApprovalCard("recognized_once")).status).toBe("none");
      expect(clicks).toBe(0);
    },
  );
  const approvalCard = {
    cardCount: 1, denyCount: 1, allowCount: 0, allowOnceCount: 1,
    alwaysAllowCount: 1, unknownCount: 0, allowPoint: null,
    allowOncePoint: { x: 10, y: 20 }, cardKey: "card-1", proofKey: "proof-1",
  };
  class ApprovalPage extends FakePage {
    inspections = 0;
    observations: Array<Record<string, unknown>> = [];
    lastObservation: Record<string, unknown> = {};
    preparedTarget: { x: number; y: number } | null | undefined;
    override async pointerClick(point: { readonly x: number; readonly y: number }): Promise<void> {
      this.actions.push(`pointer:${point.x},${point.y}`);
    }
    override async evaluate<Argument, Result>(source: string, argument: Argument): Promise<Result> {
      if (source.includes('[data-testid="tool-approval-card"]')) {
        if (argument) return { ...this.lastObservation,
          allowOncePoint: this.preparedTarget === undefined ? this.lastObservation.allowOncePoint : this.preparedTarget,
        } as Result;
        this.inspections += 1;
        this.lastObservation = this.observations.shift()!;
        return this.lastObservation as Result;
      }
      return super.evaluate<Argument, Result>(source, argument);
    }
  }

  test("approval delay does not wait on an absent or unrecognized card", async () => {
    for (const card of [
      { ...approvalCard, cardCount: 0, cardKey: null },
      { ...approvalCard, unknownCount: 1 },
    ]) {
      const page = new ApprovalPage();
      page.observations = [card];
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 50);
      try {
        const result = await new ChatGptDomSurfaceDriver(page).processApprovalCard("recognized_once", abort.signal, 15_000);
        expect(result.status).toBe("none");
        expect(page.inspections).toBe(1);
        expect(page.actions).toEqual([]);
      } finally { clearTimeout(timer); }
    }
  });

  test("the semantic snapshot's exact approval proof must still match before trusted dispatch", async () => {
    const deny = new FixtureElement(); deny.textContent = "Deny";
    const allow = new FixtureElement(); allow.textContent = "Allow once";
    const card = new FixtureElement({}, { button: [deny, allow] });
    const document = new FixtureElement({}, { '[data-codex-approval-surface="true"]': [card] });
    const page = new RendererFixturePage(document);
    let clicks = 0; page.pointerClick = async () => { clicks++; };
    const driver = new ChatGptDomSurfaceDriver(page);
    const before = (await driver.observe()).approval!;
    const expected = { cardFingerprint: before.cardFingerprint!, revisionFingerprint: before.revisionFingerprint };
    // Same element, changed request proof: no pointer dispatch and no budget consumption.
    card.textContent = "Changed synthetic request";
    expect(await driver.processApprovalCard("recognized_once", undefined, 0, expected))
      .toEqual({ status: "none", reason: "card_changed" });
    expect(clicks).toBe(0);
    const current = (await driver.observe()).approval!;
    expect(current.cardFingerprint).toBe(before.cardFingerprint);
    expect(current.revisionFingerprint).not.toBe(before.revisionFingerprint);
    expect((await driver.processApprovalCard("recognized_once", undefined, 0,
      { cardFingerprint: current.cardFingerprint!, revisionFingerprint: current.revisionFingerprint })).status).toBe("dispatched");
    expect(clicks).toBe(1);
  });

  test("delayed approval rechecks the same card and uses its current target", async () => {
    const page = new ApprovalPage();
    page.observations = [approvalCard, { ...approvalCard, allowOncePoint: { x: 30, y: 40 } }];
    const result = await new ChatGptDomSurfaceDriver(page).processApprovalCard("recognized_once", undefined, 1);
    expect(result.status).toBe("dispatched");
    expect(page.inspections).toBe(2);
    expect(page.actions).toEqual(["pointer:30,40"]);
  });

  test("delayed approval never activates a replaced, ambiguous, or disabled card", async () => {
    for (const changed of [
      { ...approvalCard, cardKey: "card-2" },
      { ...approvalCard, proofKey: "proof-2" },
      { ...approvalCard, cardCount: 2 },
      { ...approvalCard, unknownCount: 1 },
      { ...approvalCard, allowOncePoint: null },
    ]) {
      const page = new ApprovalPage();
      page.observations = [approvalCard, changed];
      const result = await new ChatGptDomSurfaceDriver(page).processApprovalCard("recognized_once", undefined, 1);
      expect(result.status).toBe("none");
      expect(page.actions).toEqual([]);
    }
  });

  test("an occluded target does not consume the card activation budget", async () => {
    const page = new ApprovalPage();
    page.observations = [approvalCard, approvalCard];
    page.preparedTarget = null;
    const driver = new ChatGptDomSurfaceDriver(page);
    expect((await driver.processApprovalCard("recognized_once")).reason).toBe("target_missing");
    expect(page.actions).toEqual([]);
    page.preparedTarget = { x: 30, y: 40 };
    expect((await driver.processApprovalCard("recognized_once")).status).toBe("dispatched");
    expect(page.actions).toEqual(["pointer:30,40"]);
  });

  test("hung renderer preparation times out; its late completion cannot dispatch input", async () => {
    let release!: (value: Record<string, unknown>) => void;
    class HungTargetPage extends ApprovalPage {
      override async evaluate<Argument, Result>(source: string, argument: Argument): Promise<Result> {
        if (argument && source.includes('[data-testid="tool-approval-card"]')) {
          return new Promise(resolve => { release = value => resolve(value as Result); });
        }
        return super.evaluate(source, argument);
      }
    }
    const page = new HungTargetPage(); page.observations = [approvalCard];
    const scratch = mkdtempSync(join(tmpdir(), "tela-approval-timeout-"));
    const file = join(scratch, "events.jsonl"), prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
    try {
      await expect(new ChatGptDomSurfaceDriver(page).processApprovalCard("recognized_once"))
        .rejects.toMatchObject({ name: "TimeoutError" });
      release(approvalCard); await Promise.resolve(); await Promise.resolve();
      expect(page.actions).toEqual([]);
      const log = readFileSync(file, "utf8");
      const rows = log.trim().split("\n").map(line => JSON.parse(line));
      expect(rows.find(row => row.stage === "approval_preparation_failed")).toMatchObject({
        reason_class: "preparation_timeout", dispatch_started: false,
      });
      expect(rows.some(row => row.stage === "approval_dispatch_started")).toBe(false);
      expect(log).not.toMatch(/card-1|proof-1|Allow once/);
    } finally {
      if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 7000);
  test("owner cancellation escapes a renderer ignoring AbortSignal without a late click", async () => {
    let entered!: () => void, release!: (value: Record<string, unknown>) => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    class CancelledTargetPage extends ApprovalPage {
      override async evaluate<Argument, Result>(source: string, argument: Argument): Promise<Result> {
        if (argument && source.includes('[data-testid="tool-approval-card"]')) {
          return new Promise(resolve => { release = value => resolve(value as Result); entered(); });
        }
        return super.evaluate(source, argument);
      }
    }
    const page = new CancelledTargetPage(); page.observations = [approvalCard];
    const owner = new AbortController();
    const pending = new ChatGptDomSurfaceDriver(page).processApprovalCard("recognized_once", owner.signal);
    await preparing; owner.abort(new DOMException("Owner ended", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    release(approvalCard); await Promise.resolve(); await Promise.resolve();
    expect(page.actions).toEqual([]);
  });
  test("cancelled approval delay cannot click the card", async () => {
    const page = new ApprovalPage();
    page.observations = [approvalCard];
    const abort = new AbortController();
    const operation = new ChatGptDomSurfaceDriver(page).processApprovalCard("recognized_once", abort.signal, 15_000);
    await Promise.resolve();
    abort.abort();
    await expect(operation).rejects.toThrow();
    expect(page.actions).toEqual([]);
  });

  test("one approval card is activated at most once even if it stays visible", async () => {
    const page = new ApprovalPage();
    page.observations = [approvalCard, { ...approvalCard, proofKey: "proof-2" }, { ...approvalCard, cardKey: "card-2" }];
    const driver = new ChatGptDomSurfaceDriver(page);
    expect((await driver.processApprovalCard("recognized_once")).status).toBe("dispatched");
    expect((await driver.processApprovalCard("recognized_once")).reason).toBe("already_activated");
    expect((await driver.processApprovalCard("recognized_once")).status).toBe("dispatched");
    expect(page.actions).toHaveLength(2);
  });

  test("an ambiguous activation is not retried for the same approval card", async () => {
    class FailedActivationPage extends ApprovalPage {
      override async pointerClick(): Promise<void> { throw new Error("activation indeterminate"); }
    }
    const page = new FailedActivationPage();
    page.observations = [approvalCard, approvalCard];
    const driver = new ChatGptDomSurfaceDriver(page);
    await expect(driver.processApprovalCard("recognized_once")).rejects.toThrow("indeterminate");
    expect((await driver.processApprovalCard("recognized_once")).reason).toBe("already_activated");
  });

  test("recognizes current ChatGPT composer renderer variants without broad page-wide textbox matching", () => {
    expect(CHATGPT_CURRENT_COMPOSER_SELECTOR).toContain('[data-testid="prompt-textarea"]');
    expect(CHATGPT_CURRENT_COMPOSER_SELECTOR).toContain('#prompt-textarea');
    expect(CHATGPT_CURRENT_COMPOSER_SELECTOR).toContain('[data-lexical-editor="true"]');
    expect(CHATGPT_CURRENT_COMPOSER_SELECTOR).toContain('[data-composer-body]');
    expect(CHATGPT_CURRENT_COMPOSER_SELECTOR).not.toContain('[role="textbox"]:not');
  });

  test("projects user/composer text to fingerprints before exposing semantic snapshots", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);
    const snapshot = await driver.observe();

    // ChatGPT Work also renders a non-attachment role=group utility bar inside the form.
    expect(page.lastObserveSource).toContain('[data-composer-attachments] [role="group"]');
    expect(page.lastObserveSource).not.toContain("querySelectorAll('[role=\"group\"], .composer-attachment-surface')");

    expect(snapshot.composers[0]).toEqual({
      key: "composer:primary",
      visible: true,
      editable: true,
      ownedByChatGptForm: true,
      textLength: "draft secret".length,
      textFingerprint: digest("draft secret"),
      connectorFingerprints: [],
      attachmentNames: [],
    });
    expect(snapshot.turns[0]).toEqual({
      key: "user:t1",
      role: "user",
      contentFingerprint: digest("private user content"),
    });
    expect(JSON.stringify(snapshot)).not.toContain("private user content");
    expect(JSON.stringify(snapshot)).not.toContain("draft secret");
  });

  test("assistant answer extraction prioritizes message body over the accessibility role heading", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);
    await driver.observe();

    expect(page.lastObserveSource).toContain(
      "group.querySelector('[data-markdown-text-style=\"assistant-message\"]')",
    );
    expect(page.lastObserveSource).toContain(
      "|| group.querySelector('[data-message-author-role=\"assistant\"] .markdown')",
    );
    expect(page.lastObserveSource).toContain("|| assistant");
    expect(page.lastObserveSource).not.toContain(
      "[data-markdown-text-style=\"assistant-message\"], [data-message-author-role=\"assistant\"] .markdown, [data-conversation-role=\"assistant\"]",
    );
  });

  test("keeps a turn streaming while the current composer still exposes Stop", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);
    await driver.observe();

    expect(page.lastObserveSource).toContain("const stopVisible = composerElements.some");
    expect(page.lastObserveSource).toContain(
      'phase: failure ? "failed" : stopVisible ? "streaming" : complete ? "complete" : "thinking"',
    );
    expect(page.lastObserveSource).toContain(
      "form.querySelectorAll('[data-testid=\"stop-button\"], button[aria-label=\"Stop\"]')",
    );
  });

  test("approval appearance and replacement wake the semantic observer without message changes", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);
    const before = await driver.observe();
    page.mutations.push(() => { page.approval = {cardCount:1,denyCount:1,allowCount:0,allowOnceCount:1,alwaysAllowCount:1,unknownCount:0,cardKey:"card1",proofKey:"proof1"}; });
    const appeared = await driver.waitForChange(before.revision);
    expect(appeared.turns).toEqual(before.turns);
    expect(appeared.approval?.cardCount).toBe(1);
    page.mutations.push(() => { page.approval.proofKey = "proof2"; });
    const replaced = await driver.waitForChange(appeared.revision);
    expect(replaced.revision).not.toBe(appeared.revision);
    page.mutations.push(() => { page.approval.cardCount = 0; });
    const removed = await driver.waitForChange(replaced.revision);
    expect(removed.approval).toBeUndefined();
  });

  test("uses narrow fill/send actions and waits on DOM mutations instead of polling", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);
    const before = await driver.observe();
    await driver.replaceComposerText("composer:primary", "new prompt");
    await driver.activateSend("send:composer:primary");
    expect(page.actions).toEqual([
      "fill:composer:primary",
      "send:send:composer:primary",
    ]);

    const unchanged = structuredClone(page.raw);
    page.mutations.push(() => { page.raw = structuredClone(unchanged); });
    page.mutations.push(() => {
      page.raw = {
        ...page.raw,
        turns: [...page.raw.turns, { key: "assistant:t1", role: "assistant", parentUserTurnKey: "user:t1", phase: "streaming" }],
      };
    });
    const changed = await driver.waitForChange((await driver.observe()).revision);
    expect(changed.turns.at(-1)).toEqual({
      key: "assistant:t1",
      role: "assistant",
      parentUserTurnKey: "user:t1",
      phase: "streaming",
    });
    expect(changed.revision).not.toBe(before.revision);
  });

  test("clears one exact composer through trusted focused keyboard input", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);

    await driver.clearComposerText("composer:primary");

    expect(page.actions).toEqual(["clear-focused"]);
    expect(page.raw.composers[0]?.text).toBe("");
  });

  test("connector action is exact-name scoped and prompt append preserves the selected connector identity", async () => {
    const page = new FakePage();
    page.raw.composers[0]!.text = "";
    const driver = new ChatGptDomSurfaceDriver(page);

    await driver.selectConnector("composer:primary", "ChatGPT Tela Development");
    await driver.appendComposerText("composer:primary", " payload");
    const snapshot = await driver.observe();

    expect(page.actions).toEqual([
      "connector-focus:ChatGPT Tela Development",
      "type:@ChatGPT Tela Development",
      "pointer:25,40",
      "append:composer:primary",
    ]);
    expect(snapshot.composers[0]?.connectorFingerprints)
      .toEqual([digest("ChatGPT Tela Development")]);
    expect(snapshot.composers[0]?.textFingerprint).toBe(digest("payload"));
  });

  test("add-context exact connector uses bounded keyboard highlight before pointer fallback", async () => {
    const page = new FakePage();
    page.raw.composers[0]!.text = "";
    page.forceMentionFailure = true;
    const driver = new ChatGptDomSurfaceDriver(page);

    await driver.selectConnector("composer:primary", "ChatGPT Tela");

    expect(page.raw.composers[0]?.connectorNames).toEqual(["ChatGPT Tela"]);
    expect(page.actions).toContain("pointer:10,20");
    expect(page.actions.filter(action => action === "key:ArrowDown")).toHaveLength(2);
    expect(page.actions).toContain("key:Enter");
    expect(page.actions).not.toContain("pointer:75,80");
  });

  test("semantic provider can derive its product driver from generic page automation", async () => {
    const page = new FakePage();
    page.raw.composers[0]!.text = "";
    page.raw.turns = [];
    const host = new ControlledBrowserHost(async () => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() {},
      capability(capability) {
        return capability === BROWSER_PAGE_AUTOMATION ? page as never : undefined;
      },
    }));
    const lease = await host.acquire({ taskId: "task-1", epochId: "epoch-1" });
    try {
      const observation = await new ChatGptSemanticProvider().observeCapabilities(lease);
      expect(observation.state).toBe("proven");
    } finally {
      await host.close();
    }
  });
});
