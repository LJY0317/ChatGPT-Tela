import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "bun:test";
import { structuralDiagnosticEvent, observeDiagnosticEvents } from "@chatgpt-tela/core";
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
  forceAddContextObservationFailure = false;
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
    if (source.includes("ChatGPT connector failure structure v1")) {
      return { composerCount: 1, addContextCount: 1, menuCount: 0,
        dialogCount: 0, listboxCount: 0, candidateRowCount: 0 } as Result;
    }
    if (source.includes("ChatGPT add-context control is not unique")) {
      return { x: 10, y: 20 } as Result;
    }
    if (source.includes("ChatGPT add-context menu exposed no recognized connector path")) {
      if (this.forceAddContextObservationFailure) throw new Error("fixture menu structure was unavailable");
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
  hasAttribute(name: string) { return this.getAttribute(name) !== null; }
  querySelectorAll(selector: string): FixtureElement[] {
    return [...new Set(selector.split(/,\s*/).flatMap(part => this.selectors[part] ?? []))];
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 20, height: 20 }; }
  closest(_selector?: string) { return this.selectors.form?.[0] ?? null; }
  cloneNode() { return this; }
}

class RendererFixturePage extends FakePage {
  readonly rendererState: Record<string | symbol, unknown> = {};
  animationFrame: (callback: () => void) => void = callback => callback();
  hitTest: () => FixtureElement | null | undefined = () => this.document.querySelectorAll('[data-codex-approval-surface="true"]')[0]
    ?.querySelectorAll("button").find(b => b.textContent.startsWith("Allow once"));
  constructor(readonly document: FixtureElement) { super(); }
  override async evaluate<Argument, Result>(source: string, argument: Argument): Promise<Result> {
    if (source.includes("return { url: location.href, composers, sendControls, turns }") || source.includes("const cards =")) {
      return runInNewContext(`(${source})(argument)`, Object.assign(this.rendererState, {
        argument, innerWidth: 800, innerHeight: 600, requestAnimationFrame: (callback: () => void) => this.animationFrame(callback),
        document: Object.assign(this.document, { documentElement: this.document, elementFromPoint: this.hitTest, baseURI: "https://chatgpt.com/" }), URL, HTMLElement: FixtureElement, HTMLButtonElement: FixtureElement,
        getComputedStyle: (element: FixtureElement) => ({ display: element.getAttribute("data-fixture-display") ?? "block", visibility: element.getAttribute("data-fixture-visibility") ?? "visible", opacity: element.getAttribute("data-fixture-opacity") ?? "1", pointerEvents: element.getAttribute("data-fixture-pointer-events") ?? "auto", overflowY: element.getAttribute("data-fixture-overflow-y") ?? "visible" }),
        location: { href: "https://chatgpt.com/" }, crypto: { randomUUID: () => "synthetic-card" },
      })) as Result;
    }
    return super.evaluate(source, argument);
  }
}

describe("current ChatGPT DOM surface driver", () => {
  test.each([false, true])("marker siblings expose only unique public progress, ambiguous=%s", async ambiguous => {
    const label=new FixtureElement({id:'public-label'}); label.innerText='Reviewing changes';
    const button=new FixtureElement({'aria-expanded':'true','aria-labelledby':'public-label'});
    const description=new FixtureElement(); description.childNodes=[{nodeType:3,textContent:'Checking the current patch.'}];
    const shell=new FixtureElement({}, {'button[aria-expanded][aria-labelledby]':[button],'[id]':[label]});
    shell.childNodes=[button,label,description];
    const body=new FixtureElement({'data-markdown-text-style':'assistant-message'}); body.innerText='FINAL_EXCLUDED';
    const group=new FixtureElement({'data-turn-key':'owned'}, {'[data-markdown-text-style="assistant-message"]':[body]});
    const marker=Object.assign(new FixtureElement(),{parentElement:group});
    group.selectors['[data-chatgpt-agent-turn-start]']=[marker];
    group.childNodes=[marker,shell,body,...(ambiguous?[shell]:[])];
    group.contains=node=>node===group||group.childNodes.includes(node as FixtureElement);
    const driver=new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, {'[data-turn-key]':[group]})));
    const turns=(await driver.observe()).turns;
    expect(turns.find(t=>t.role==='assistant')?.publicProgress??[]).toEqual(ambiguous?[]:['Reviewing changes\n\nChecking the current patch.']);
    expect(JSON.stringify(turns.find(t=>t.role==='assistant')?.publicProgress??[])).not.toContain('FINAL_EXCLUDED');
  });
  test.each(['visible','hidden','duplicate','answer','unlinked'])("public status only follows a unique visible linked region inside its owned turn: %s", async mode => {
    const label=new FixtureElement({id:'label'});label.innerText='Thinking';
    const button=new FixtureElement({'aria-expanded':'true','aria-labelledby':'label',...(mode==='unlinked'?{}:{'aria-controls':'details'})});
    const shell=new FixtureElement({}, {'button[aria-expanded][aria-labelledby]':[button],'[id]':[label]});
    shell.childNodes=[button,label];
    const marker=Object.assign(new FixtureElement(),{parentElement:shell});
    const region=new FixtureElement({id:'details',...(mode==='hidden'?{hidden:''}:{}),...(mode==='answer'?{'data-markdown-text-style':'assistant-message'}:{})});
    region.childNodes=[{nodeType:3,textContent:'Visible public status.'}];
    const group=new FixtureElement({'data-turn-key':'owned'}, {'p':[region],'[data-chatgpt-agent-turn-start]':[marker],'[id]':mode==='duplicate'?[region,new FixtureElement({id:'details'})]:[region],
      ...(mode==='answer'?{'[data-markdown-text-style="assistant-message"]':[region]}:{})});
    group.contains=node=>[group,shell,region].includes(node as FixtureElement);
    const driver=new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, {'[data-turn-key]':[group]})));
    const assistant=(await driver.observe()).turns.find(t=>t.role==='assistant');
    const parts=assistant?.publicProgress??[];
    expect(parts).toEqual(mode==='visible'?['Thinking\n\nVisible public status.']:['Thinking']);
    expect(assistant?.progressProbe).toMatchObject({titleCount:1,descriptionCount:mode==='visible'?1:0});
    if(mode==='unlinked')expect(assistant?.progressProbe?.unmappedVisibleProsePresent).toBe(true);
  });
  test("manual consent classifier releases only a current observed card, including warnings, without auto activation", async () => {
    const allow=new FixtureElement({'data-fixture-tag':'BUTTON'});allow.textContent='Allow once';
    const deny=new FixtureElement({'data-fixture-tag':'BUTTON'});deny.textContent='Deny';
    const disclosure=new FixtureElement({'data-fixture-tag':'BUTTON','aria-haspopup':'dialog'});disclosure.textContent='See details';
    const card=new FixtureElement({}, {button:[deny,allow,disclosure]});
    card.textContent=card.innerText='Suspicious Instruction. The tool description prescribes or suppresses the classifier risk label or approval outcome.';
    card.contains=node=>node===allow||node===deny||node===disclosure;
    allow.closest=(selector?:string)=>selector==='button,[role="button"]'?allow:null;
    deny.closest=(selector?:string)=>selector==='button,[role="button"]'?deny:null;
    disclosure.closest=(selector?:string)=>selector==='button,[role="button"]'?disclosure:null;
    const page=new RendererFixturePage(new FixtureElement({}, {'[data-codex-approval-surface="true"]':[card]}));
    const driver=new ChatGptDomSurfaceDriver(page);
    const snapshot=await driver.observe();
    const registry=page.rendererState[Symbol.for('chatgpt-tela.approval-observations.v1')] as {manualInputTarget:(node:unknown)=>boolean};
    expect(registry.manualInputTarget(allow)).toBe(true);
    expect(registry.manualInputTarget(deny)).toBe(true);
    expect(registry.manualInputTarget(disclosure)).toBe(true);
    disclosure.disabled=true;expect(registry.manualInputTarget(disclosure)).toBe(false);disclosure.disabled=false;
    disclosure.attributes['aria-haspopup']='menu';expect(registry.manualInputTarget(disclosure)).toBe(false);
    disclosure.attributes['aria-haspopup']='dialog';
    disclosure.textContent='Unknown action';expect(registry.manualInputTarget(disclosure)).toBe(false);disclosure.textContent='See details';
    expect(registry.manualInputTarget(new FixtureElement())).toBe(false);
    await expect(driver.processApprovalCard('off')).resolves.toMatchObject({status:'none'});
    expect(page.actions).toEqual([]);
    card.textContent='Replaced request';expect(registry.manualInputTarget(allow)).toBe(false);
    await driver.observe();expect(registry.manualInputTarget(allow)).toBe(true);
    allow.disabled=true;expect(registry.manualInputTarget(allow)).toBe(false);
  });
  test("a human approval-options menu preserves input identity only through a uniquely linked visible portal", async () => {
    const deny = new FixtureElement({ 'data-fixture-tag': 'BUTTON' }); deny.textContent = 'Deny';
    const allow = new FixtureElement({ 'data-fixture-tag': 'BUTTON' }); allow.textContent = 'Allow once';
    const disclosure = new FixtureElement({ 'data-fixture-tag': 'BUTTON', 'id': 'approval-trigger',
      'aria-haspopup': 'menu', 'aria-controls': 'approval-options-menu', 'aria-expanded': 'false' });
    disclosure.textContent = 'Approval options';
    const portal = new FixtureElement({ 'id': 'approval-options-menu', 'role': 'menu' });
    const scoped = new FixtureElement({ 'role': 'menuitem' });
    scoped.textContent = 'Allow ChatGPT Tela for this conversation';
    const foreign = new FixtureElement({ 'role': 'menuitem' });
    foreign.textContent = 'Unrelated UI action';
    const card = new FixtureElement({}, { button: [deny, allow, disclosure] });
    card.textContent = 'Owned request: opaque local test data';
    card.contains = value => [deny, allow, disclosure].includes(value as FixtureElement);
    portal.contains = value => value === scoped || value === foreign;
    const controlSelector = 'button,[role="button"]';
    const itemSelector = '[role="menuitem"]';
    disclosure.closest = (selector?: string) => selector === controlSelector ? disclosure : null;
    scoped.closest = (selector?: string) => selector === itemSelector ? scoped : selector === '[role="menu"]' ? portal : null;
    foreign.closest = (selector?: string) => selector === itemSelector ? foreign : selector === '[role="menu"]' ? portal : null;
    const root = new FixtureElement({}, {
      '[data-codex-approval-surface="true"]': [card],
      '[role="menu"]': [portal],
    });
    const page = new RendererFixturePage(root);
    const driver = new ChatGptDomSurfaceDriver(page);
    await driver.observe();
    const registry = page.rendererState[Symbol.for('chatgpt-tela.approval-observations.v1')] as {
      manualInputTarget: (node: unknown) => boolean;
    };
    expect(registry.manualInputTarget(disclosure)).toBe(true);
    expect(registry.manualInputTarget(scoped)).toBe(false); // menu is not opened yet
    disclosure.attributes['aria-expanded'] = 'true';
    expect(registry.manualInputTarget(scoped)).toBe(true);
    expect(registry.manualInputTarget(foreign)).toBe(false);
    portal.attributes['id'] = 'unrelated-menu';
    expect(registry.manualInputTarget(scoped)).toBe(false);
    portal.attributes['id'] = 'approval-options-menu';
    root.selectors['[role="menu"]']!.push(new FixtureElement({ role: 'menu' }));
    expect(registry.manualInputTarget(scoped)).toBe(false);
    root.selectors['[role="menu"]']!.pop();
    scoped.disabled = true;
    expect(registry.manualInputTarget(scoped)).toBe(false);
    scoped.disabled = false;
    card.textContent = 'Replaced request';
    expect(registry.manualInputTarget(scoped)).toBe(false);
    await driver.observe();
    expect(registry.manualInputTarget(scoped)).toBe(true);
    const otherCard = new FixtureElement();
    root.selectors['[data-codex-approval-surface="true"]']!.push(otherCard);
    expect(registry.manualInputTarget(scoped)).toBe(true);
    expect(page.actions).toEqual([]); // Classification is passive; no approvals were dispatched.
  });
  test.each(["ordinary", "provider warning"] as const)(
    "a native-button portal permits human but not unreviewed %s approval", async scenario => {
    const deny = new FixtureElement({ "data-fixture-tag": "BUTTON" }); deny.textContent = "Deny";
    const once = new FixtureElement({ "data-fixture-tag": "BUTTON" }); once.textContent = "Allow once";
    const disclosure = new FixtureElement({ "data-fixture-tag": "BUTTON", "aria-haspopup": "menu",
      "aria-controls": "linked-approval", "aria-expanded": "true" });
    disclosure.textContent = "Approval options";
    const scoped = new FixtureElement({ "data-fixture-tag": "BUTTON" });
    scoped.textContent = "Allow ChatGPT Tela for this conversation";
    const foreign = new FixtureElement({ "data-fixture-tag": "BUTTON" });
    foreign.textContent = "Approve unrelated workflow";
    const menu = new FixtureElement({ role: "menu", id: "linked-approval" }, {
      button: [scoped, foreign],
    });
    menu.contains = value => value === scoped || value === foreign;
    const card = new FixtureElement({}, { button: [deny, once, disclosure] });
    card.textContent = scenario === "provider warning"
      ? "Suspicious Instruction: private fixture warning requires human review"
      : "Fixture-owned read-only task";
    card.contains = value => [deny, once, disclosure].includes(value as FixtureElement);
    for (const item of [scoped, foreign]) item.closest = (selector?: string) =>
      selector === "button,[role=\"button\"]" ? item : selector === '[role="menu"]' ? menu : null;
    const root = new FixtureElement({}, {
      '[data-codex-approval-surface="true"]': [card], '[role="menu"]': [menu],
    });
    const page = new RendererFixturePage(root);
    const driver = new ChatGptDomSurfaceDriver(page);
    const observed = await driver.observe();
    if (scenario === "provider warning") {
      expect(await driver.processApprovalCard("off"))
        .toMatchObject({ status: "none", reason: "disabled" });
    }
    const registry = page.rendererState[Symbol.for("chatgpt-tela.approval-observations.v1")] as {
      manualInputTarget(node: unknown): boolean;
    };
    expect(registry.manualInputTarget(scoped)).toBe(true);
    expect(registry.manualInputTarget(foreign)).toBe(false);
    scoped.disabled = true; expect(registry.manualInputTarget(scoped)).toBe(false);
    scoped.disabled = false;
    disclosure.attributes["aria-expanded"] = "false";
    expect(registry.manualInputTarget(scoped)).toBe(false);
    disclosure.attributes["aria-expanded"] = "true";
    menu.attributes.id = "unlinked-menu";
    expect(registry.manualInputTarget(scoped)).toBe(false);
    menu.attributes.id = "linked-approval";
    root.selectors['[role="menu"]']!.push(new FixtureElement({ role: "menu" }));
    expect(registry.manualInputTarget(scoped)).toBe(false);
    root.selectors['[role="menu"]']!.pop();
    card.textContent = "Request replaced";
    expect(registry.manualInputTarget(scoped)).toBe(false);
    expect(page.actions).toEqual([]);
  });
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

  test("machine JSON uses literal body text instead of layout line breaks", async () => {
    const wire = JSON.stringify({ type: "tela_context_checkpoint_v1", summary: "one two" });
    const body = new FixtureElement();
    body.textContent = wire;
    body.innerText = wire.replace("one two", "one\ntwo");
    body.childNodes = [{ nodeType: 3, textContent: wire }];
    const group = new FixtureElement({ 'data-turn-key': 'checkpoint' }, {
      '[data-markdown-text-style="assistant-message"]': [body],
      'button[data-testid="copy-turn-action-button"]': [new FixtureElement()],
    });
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] })));
    const answer = (await driver.observe()).turns[0]!;
    expect(() => JSON.parse(body.innerText)).toThrow();
    expect(JSON.parse(answer.plainBodyText!)).toEqual(JSON.parse(wire));
  });

  test("retained answer ignores link icon hydration but preserves destination and author changes", async () => {
    const icon = new FixtureElement({ 'data-fixture-tag': 'IMG', src: '/placeholder' });
    const graphic = new FixtureElement({ 'data-fixture-tag': 'SVG' });
    const label = { nodeType: 3, textContent: 'Reference' };
    const link = new FixtureElement({ 'data-fixture-tag': 'A', href: 'https://example.com/one' });
    link.childNodes = [graphic, icon, label];
    const body = new FixtureElement(); body.childNodes = [link];
    const group = new FixtureElement({ 'data-turn-key': 'prior' }, {
      '[data-markdown-text-style="assistant-message"]': [body],
      'button[data-testid="copy-turn-action-button"]': [new FixtureElement()],
    });
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] })));
    const before = (await driver.observe()).turns[0]!;
    link.childNodes = [icon, label]; icon.attributes.src = '/loaded';
    expect((await driver.observe()).turns[0]!.bodyProof).toEqual(before.bodyProof);
    link.attributes.href = 'https://example.com/two';
    expect((await driver.observe()).turns[0]!.bodyProof).not.toEqual(before.bodyProof);
    link.attributes.href = 'https://example.com/one'; label.textContent = 'Changed author text';
    expect((await driver.observe()).turns[0]!.bodyProof).not.toEqual(before.bodyProof);
  });

  test("retained body digest ignores paragraph wrapping while detecting code and link edits", async () => {
    const prose = { nodeType: 3, textContent: "An unchanged answer." };
    const code = new FixtureElement({ 'data-fixture-tag': 'CODE' });
    Object.assign(code, { classList: [] });
    code.childNodes = [{ nodeType: 3, textContent: 'return `ok`;' }];
    code.textContent = 'return `ok`;';
    const pre = new FixtureElement({ 'data-fixture-tag': 'PRE' });
    pre.childNodes = [code];
    pre.querySelector = (selector: string) => selector === 'code' ? code : null;
    const link = new FixtureElement({ 'data-fixture-tag': 'A', href: 'https://example.com/original' });
    link.childNodes = [{ nodeType: 3, textContent: 'Reference' }];
    const paragraph = new FixtureElement({ 'data-fixture-tag': 'P' });
    paragraph.childNodes = [prose];
    const body = new FixtureElement(); body.childNodes = [paragraph, pre, link];
    const group = new FixtureElement({ 'data-turn-key': 'retained' }, {
      '[data-markdown-text-style="assistant-message"]': [body],
      'button[data-testid="copy-turn-action-button"]': [new FixtureElement()],
    });
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, { '[data-turn-key]': [group] })));
    const before = (await driver.observe()).turns[0]!.bodyProof?.digest;
    const wrapper = new FixtureElement({ 'data-fixture-tag': 'DIV' });
    wrapper.childNodes = [{ nodeType: 3, textContent: "An unchanged\nanswer." }];
    body.childNodes = [wrapper, pre, link];
    expect((await driver.observe()).turns[0]!.bodyProof?.digest).toBe(before);
    code.childNodes = [{ nodeType: 3, textContent: 'return `changed`;' }];
    code.textContent = 'return `changed`;';
    expect((await driver.observe()).turns[0]!.bodyProof?.digest).not.toBe(before);
    code.childNodes = [{ nodeType: 3, textContent: 'return `ok`;' }];
    code.textContent = 'return `ok`;';
    link.attributes.href = 'https://example.com/different';
    expect((await driver.observe()).turns[0]!.bodyProof?.digest).not.toBe(before);
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
    const authored = new FixtureElement({ 'data-content-search-unit-key': 'final:assistant' });
    const shell = new FixtureElement({}, { 'button[aria-expanded][aria-labelledby]': [button], '[id]': [label],
      ...(variant === 'answer-in-shell' ? { '[data-content-search-unit-key]': [authored] } : {}) });
    shell.childNodes = [button, label, description, ...(variant === 'answer-in-shell' ? [authored] : [])];
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
  test("failure diagnostics survive more than 32 progress transitions and deduplicate unchanged reads", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);
    const rows: Array<Record<string, unknown>> = [];
    const stop = observeDiagnosticEvents(row => { rows.push(row); });
    try {
      for (let index = 0; index < 35; index++) {
        page.raw.turns = [{ key: "assistant:owned", role: "assistant", phase: "thinking",
          progressProbe: { containerPresent: true, containerVisible: true, markerCount: index } }];
        await driver.observe();
      }
      page.raw.turns = [{ key: "assistant:owned", role: "assistant", phase: "failed",
        progressProbe: { containerPresent: true, containerVisible: true, failureSource: "alert",
          failureCandidateCount: 1, failureEligibleCount: 1 } }];
      await driver.observe();
      await driver.observe();
      expect(rows.filter(row => row.stage === "web_provider_failure_observed")).toHaveLength(1);
      expect(rows.filter(row => row.stage === "web_public_progress_extraction")).toHaveLength(36);
    } finally { stop?.(); }
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
      expect(rows[0]).toMatchObject({ progress_container_visible: mode === "contents", progress_container_has_rects: false,
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

  test.each(["provider", "provider-with-body", "provider-with-progress", "user-content", "assistant-content", "hidden", "progress", "active-progress", "approval-card", "approval-and-provider"])(
    "a failed fetch alert without an assistant body is scoped to its own provider turn (%s)", async variant => {
      const alert = new FixtureElement({ role: "alert", ...(variant === "hidden" ? { "data-fixture-display": "none" } : {}) });
      alert.innerText = variant.startsWith("approval") ? "Allow ChatGPT to use ChatGPT Tela?" : "Failed to fetch";
      const approval = new FixtureElement({ "data-codex-approval-surface": "true" });
      approval.contains = node => node === approval || node === alert;
      const providerAlert = new FixtureElement({ role: "alert" }); providerAlert.innerText = "Failed to fetch";
      const user = new FixtureElement();
      if (variant === "user-content") user.contains = node => node === user || node === alert;
      const progress = new FixtureElement();
      if (variant === "progress") progress.contains = node => node === progress || node === alert;
      const body = new FixtureElement();
      if (variant === "assistant-content") body.contains = node => node === body || node === alert;
      const group = new FixtureElement({ "data-turn-key": "failed-fetch" }, {
        '[data-user-message-bubble]': [user], '[role="alert"]': variant === "approval-and-provider" ? [alert, providerAlert] : [alert],
        ...(variant.startsWith("approval") ? { '[data-codex-approval-surface="true"]': [approval] } : {}),
        ...(["progress", "provider-with-progress", "approval-card", "approval-and-provider"].includes(variant) ? { '[data-streaming-response-status]': [progress] } : {}),
        ...(["assistant-content", "provider-with-body", "approval-card", "approval-and-provider"].includes(variant) ? { '[data-markdown-text-style="assistant-message"]': [body] } : {}),
      });
      const form = new FixtureElement({}, { '[data-testid="stop-button"]': [new FixtureElement()] });
      const composer = new FixtureElement({ contenteditable: "true" }, { form: [form] });
      const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(new FixtureElement({}, {
        '[data-turn-key]': [group],
        ...(variant === "active-progress" ? { '#prompt-textarea': [composer] } : {}),
      })));
      const observation = await driver.observe();
      const assistant = observation.turns.find(turn => turn.role === "assistant");
      if (variant.startsWith("provider") || variant === "approval-and-provider") {
        expect(assistant).toMatchObject({ parentUserTurnKey: "user:failed-fetch", phase: "failed", failureDetail: "Failed to fetch" });
      } else {
        expect(assistant?.phase).not.toBe("failed");
      }
    },
  );

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

  test.each(["marked", "dialog", "nested", "warning wrapper", "foreign heading", "duplicate choice", "disabled"])(
    "candidate discovery and exact execution tolerate structure changes: %s", async scenario => {
    const heading = new FixtureElement(); heading.textContent = scenario === "foreign heading" ? "Other connector" : "ChatGPT Tela";
    const deny = new FixtureElement(); deny.textContent = "Deny";
    const allow = new FixtureElement(); allow.textContent = scenario === "dialog" ? "Allow" : "Allow once";
    if (scenario === "disabled") allow.disabled = true;
    const extra = new FixtureElement(); extra.textContent = "Copy details";
    const duplicate = new FixtureElement(); duplicate.textContent = allow.textContent;
    const card = new FixtureElement({}, {button:[deny,allow,extra,...(scenario === "duplicate choice" ? [duplicate] : [])],h2:[heading]});
    const wrapper = new FixtureElement({ role: "dialog" }, {button:[deny,allow],h2:[heading]});
    wrapper.contains = node => node === card || node === wrapper;
    if (scenario === "warning wrapper") wrapper.textContent = "Suspicious Instruction";
    const root = new FixtureElement({}, {
      ...(scenario === "dialog" || scenario === "foreign heading" ? {} : {'[data-codex-approval-surface="true"]':[card]}),
      ...(scenario === "marked" || scenario === "duplicate choice" || scenario === "disabled" ? {} : {'[role="dialog"]':[scenario === "nested" || scenario === "warning wrapper" ? wrapper : card]}),
    });
    const page = new RendererFixturePage(root); page.hitTest = () => allow;
    let clicks = 0; page.pointerClick = async () => { clicks++; };
    const driver = new ChatGptDomSurfaceDriver(page);
    const result = await driver.processApprovalCard("full_access");
    const eligible = ["marked", "dialog", "nested", "warning wrapper", "foreign heading"].includes(scenario);
    expect(result.status).toBe(eligible ? "dispatched" : "none");
    expect(clicks).toBe(eligible ? 1 : 0);
  });

  test.each(["stopped", "still running", "foreign", "edited before dispatch", "occluded", "disabled"])(
    "owned public Stop dispatch is one-shot with observed outcome: %s", async scenario => {
    const user = new FixtureElement(); user.innerText = user.textContent = "Owned test request";
    user.selectors['[data-search-result-target]'] = [user];
    const answer = new FixtureElement(); answer.textContent = "Working";
    const group = new FixtureElement({'data-turn-key':'owned'}, {
      '[data-user-message-bubble]':[user], '[data-markdown-text-style="assistant-message"]':[answer],
    });
    const stop = new FixtureElement(); stop.textContent = "Stop"; stop.disabled = scenario === "disabled";
    const form = new FixtureElement({}, {'[data-testid="stop-button"]':[stop]});
    const composer = new FixtureElement({'contenteditable':'true'});
    composer.closest = selector => selector?.startsWith('form') ? form : null;
    const root = new FixtureElement({}, {'[data-turn-key]':[group], '[data-testid="prompt-textarea"]':[composer]});
    const page = new RendererFixturePage(root); page.hitTest = () => scenario === "occluded" ? root : stop;
    let clicks = 0;
    page.pointerClick = async () => { clicks++; if (scenario === "stopped") form.selectors['[data-testid="stop-button"]'] = []; };
    if (scenario === "edited before dispatch") {
      const evaluate = page.evaluate.bind(page);
      page.evaluate = async (source, argument) => {
        if (source.includes("const snapshot =")) user.textContent = "Changed request with identical turn keys";
        return evaluate(source, argument);
      };
    }
    const driver = new ChatGptDomSurfaceDriver(page);
    const expected = { assistantKey: scenario === "foreign" ? "assistant:foreign" : "assistant:owned", userTurnKey: "user:owned", userFingerprint: createHash("sha256").update("Owned test request").digest("base64url") };
    const result = await driver.stopGeneration(expected);
    expect(result.status).toBe(scenario === "stopped" ? "stopped" : scenario === "still running" ? "stop_sent"
      : scenario === "foreign" || scenario === "edited before dispatch" ? "ownership_changed" : "unavailable");
    expect(clicks).toBe(["stopped", "still running"].includes(scenario) ? 1 : 0);
    await driver.stopGeneration(expected);
    expect(clicks).toBe(["stopped", "still running"].includes(scenario) ? 1 : 0);
  });

  test("multiple pending cards use the same approval path and settled cards do not block the next", async () => {
    const callbacks = new Map<FixtureElement, (event: { isTrusted: boolean }) => void>();
    const makeCard = () => {
      const deny = new FixtureElement(); deny.textContent = "Deny";
      const allow = new FixtureElement(); allow.textContent = "Allow once";
      Object.assign(allow, {
        addEventListener: (_name: string, callback: (event: { isTrusted: boolean }) => void) => callbacks.set(allow, callback),
        removeEventListener: () => callbacks.delete(allow),
      });
      const card = new FixtureElement({}, { button: [deny, allow] });
      card.contains = node => node === deny || node === allow || node === card;
      return { card, allow };
    };
    const first = makeCard(), second = makeCard();
    const settled = new FixtureElement();
    const root = new FixtureElement({}, { '[data-codex-approval-surface="true"]': [settled, first.card, second.card] });
    const page = new RendererFixturePage(root);
    let target = first.allow;
    page.hitTest = () => target;
    const clicks: FixtureElement[] = [];
    page.pointerClick = async () => { clicks.push(target); callbacks.get(target)?.({ isTrusted: true }); };
    const driver = new ChatGptDomSurfaceDriver(page);
    const before = await driver.observe();
    expect(before.approval).toMatchObject({ cardCount: 2, allowOnceCount: 1 });
    expect(typeof before.approval?.cardFingerprint).toBe("string");
    expect(await driver.processApprovalCard("off")).toMatchObject({ status: "none", reason: "disabled" });
    expect(clicks).toHaveLength(0);
    expect(await driver.processApprovalCard("full_access")).toMatchObject({ status: "dispatched" });
    target = second.allow;
    const next = await driver.observe();
    expect(next.approval).toMatchObject({ cardCount: 1 });
    expect(next.approval?.cardFingerprint).not.toBe(before.approval?.cardFingerprint);
    expect(next.approvalInputReceipt?.cardFingerprint).toBe(before.approval?.cardFingerprint);
    expect(await driver.processApprovalCard("full_access")).toMatchObject({ status: "dispatched" });
    expect(clicks).toEqual([first.allow, second.allow]);
    expect((await driver.observe()).approval).toBeUndefined();
  });
  test("generic Allow remains eligible when an unrelated options button is present", async () => {
    const buttons = ["Deny", "Allow", "Approval options"].map(label => {
      const button = new FixtureElement(); button.innerText = label; return button;
    });
    const card = new FixtureElement({}, { button: buttons });
    const page = new RendererFixturePage(new FixtureElement({}, {
      '[data-codex-approval-surface="true"]': [card],
    }));
    page.hitTest = () => buttons[1]!;
    let clicks = 0; page.pointerClick = async () => { clicks++; };
    const driver = new ChatGptDomSurfaceDriver(page);
    const observed = await driver.observe();
    expect(observed.approval).toMatchObject({ cardCount: 1, denyCount: 1, allowCount: 1, allowOnceCount: 0, unknownCount: 1 });
    expect(await driver.processApprovalCard("full_access")).toMatchObject({ status: "dispatched", reason: "allow" });
    expect(clicks).toBe(1);
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
    expect((await driver.processApprovalCard("full_access")).status).toBe("dispatched");
    const unknown = new FixtureElement(); unknown.textContent = "Synthetic new decision";
    card.selectors.button!.push(unknown);
    expect((await driver.observe()).approval?.unknownCount).toBe(1);
    expect((await driver.processApprovalCard("full_access")).status).toBe("none");
    expect(clicks).toBe(1);
  });
  test("explicit conversation-only consent is preferred over once when user opts in, without selecting Always allow", async () => {
    const deny = new FixtureElement(); deny.textContent = "Deny";
    const once = new FixtureElement(); once.textContent = "Allow once";
    const scoped = new FixtureElement(); scoped.textContent = "Allow for this conversation";
    once.getBoundingClientRect = () => ({ left: 10, top: 10, width: 20, height: 20 });
    scoped.getBoundingClientRect = () => ({ left: 60, top: 10, width: 20, height: 20 });
    const card = new FixtureElement({}, { button: [deny, once, scoped] });
    const page = new RendererFixturePage(new FixtureElement({}, {
      '[data-codex-approval-surface="true"]': [card],
    }));
    page.hitTest = () => scoped;
    const clicks: { x: number; y: number }[] = [];
    page.pointerClick = async point => { clicks.push(point); };
    const driver = new ChatGptDomSurfaceDriver(page);
    expect((await driver.observe()).approval).toMatchObject({
      denyCount: 1, allowOnceCount: 1, allowConversationCount: 1,
      unknownCount: 0,
    });
    expect(await driver.processApprovalCard("full_access")).toMatchObject({
      status: "dispatched", reason: "allow_conversation",
    });
    expect(clicks).toEqual([{ x: 70, y: 20 }]);
  });
  test.each([
    ["verified", "allow_conversation", 2],
    ["verified native buttons", "allow_conversation", 2],
    ["button menuitem", "allow_conversation", 2],
    ["security warning", "allow_conversation", 2],
    ["replaced card", "options_unverified", 1],
    ["unlinked portal", "options_unverified", 1],
    ["ambiguous portals", "options_unverified", 1],
    ["menu warning", "allow_conversation", 2],
    ["persistent alternative", "allow_conversation", 2],
  ] as const)("automatic options disclosure rejects unsafe states: %s", async (scenario, outcome, expectedClicks) => {
    const deny = new FixtureElement(); deny.textContent = "Deny";
    const once = new FixtureElement(); once.textContent = "Allow once";
    const trigger = new FixtureElement({ id: "approval-trigger", "aria-label": "Approval options",
      "aria-haspopup": "menu", "aria-controls": "approval-scope-menu", "aria-expanded": "false" });
    trigger.textContent = "Approval options";
    trigger.getBoundingClientRect = () => ({ left: 0, top: 0, width: 20, height: 20 });
    const nativeButtons = scenario === "verified native buttons" || scenario === "button menuitem";
    const scoped = new FixtureElement(nativeButtons ? { "data-fixture-tag": "BUTTON" } : { role: "menuitem" });
    scoped.textContent = "Allow for this conversation";
    scoped.getBoundingClientRect = () => ({ left: 60, top: 0, width: 20, height: 20 });
    const menuOnce = new FixtureElement(nativeButtons ? { "data-fixture-tag": "BUTTON" } : { role: "menuitem" });
    menuOnce.textContent = "Allow once";
    const forever = new FixtureElement({ role: "menuitem" }); forever.textContent = "Always allow";
    const menu = new FixtureElement({ role: "menu", id: "approval-scope-menu" }, {
      ...(scenario === "button menuitem" ? {'[role="menuitem"]':[scoped,menuOnce]} : {}),
      [nativeButtons ? "button" : '[role="menuitem"]']: [scoped, menuOnce,
        ...(scenario === "persistent alternative" ? [forever] : [])],
      ...(scenario === "menu warning" ? { '[role="alert"]': [new FixtureElement({ role: "alert" })] } : {}),
    });
    menu.contains = value => [scoped, menuOnce, forever].includes(value as FixtureElement);
    const card = new FixtureElement({}, { button: [deny, once, trigger] });
    card.textContent = scenario === "security warning"
      ? "Suspicious Instruction: a tool description attempts to dictate the approval outcome"
      : "Fixture-owned normal approval";
    card.contains = value => [deny, once, trigger].includes(value as FixtureElement);
    for (const item of [scoped, menuOnce, forever]) {
      item.closest = (selector?: string) => selector === (nativeButtons ? 'button,[role="button"]' : '[role="menuitem"]')
        ? item : selector === '[role="menu"]' ? menu : null;
    }
    trigger.closest = (selector?: string) => selector === 'button,[role="button"]' ? trigger : null;
    const root = new FixtureElement({}, {
      '[data-codex-approval-surface="true"]': [card], '[role="menu"]': [],
    });
    const page = new RendererFixturePage(root);
    const clicks: { x: number; y: number }[] = [];
    page.hitTest = () => clicks.length === 0 ? trigger : scoped;
    page.pointerClick = async point => {
      clicks.push(point);
      if (clicks.length === 1) {
        trigger.attributes['aria-expanded'] = 'true';
        root.selectors['[role="menu"]'] = [menu];
        if (scenario === "replaced card") card.textContent = "Changed request while opening";
        if (scenario === "unlinked portal") menu.attributes.id = "foreign-menu";
        if (scenario === "ambiguous portals") {
          root.selectors['[role="menu"]']!.push(new FixtureElement({ role: "menu", id: "other-menu" }));
        }
      }
    };
    const driver = new ChatGptDomSurfaceDriver(page);
    const seen = await driver.observe();
    const first = await driver.processApprovalCard("full_access", undefined, 0, {
      cardFingerprint: seen.approval!.cardFingerprint!,
      revisionFingerprint: seen.approval!.revisionFingerprint,
    });
    expect(first.reason).toBe(outcome);
    expect(clicks).toHaveLength(expectedClicks);
    if (scenario === "verified" || scenario === "verified native buttons" || scenario === "persistent alternative"
      || scenario === "button menuitem" || scenario === "security warning" || scenario === "menu warning") {
      expect(first.status).toBe("dispatched");
      expect(first).toMatchObject({ revisionFingerprint: expect.any(String) });
      if (first.status === "dispatched") {
        expect(first.revisionFingerprint).not.toBe(seen.approval!.revisionFingerprint);
      }
      expect(clicks).toEqual([{ x: 10, y: 10 }, { x: 70, y: 10 }]);
    } else {
      expect(first.status).toBe("none");
      expect(await driver.processApprovalCard("full_access")).toMatchObject({
        status: "none",
      });
      expect(clicks).toHaveLength(expectedClicks);
    }
  });
  test("no ambiguous or warning card receives a broader grant", async () => {
    for (const unsafe of ["Always allow", "Suspicious content: external execution"]) {
      const deny = new FixtureElement(); deny.textContent = "Deny";
      const once = new FixtureElement(); once.textContent = "Allow once";
      const scoped = new FixtureElement(); scoped.textContent = "Allow for this conversation";
      const buttons = [deny, once, scoped];
      const card = new FixtureElement({}, { button: buttons });
      if (unsafe === "Always allow") {
        const forever = new FixtureElement(); forever.textContent = "Always allow";
        buttons.push(forever);
      } else card.textContent = unsafe;
      const page = new RendererFixturePage(new FixtureElement({}, {
        '[data-codex-approval-surface="true"]': [card],
      }));
      let clicks = 0;
      page.hitTest = () => scoped;
      page.pointerClick = async () => { clicks++; };
      const outcome = await new ChatGptDomSurfaceDriver(page).processApprovalCard("full_access");

      // Both Always allow alternative and warnings permit allow_conversation without broadening
      expect(outcome).toMatchObject({ status: "dispatched", reason: "allow_conversation" });
      expect(clicks).toBe(1);
    }
  });
  test("a visible external-execution warning remains manual when approval is off", async () => {
    const deny = new FixtureElement(); deny.textContent = "Deny";
    const allow = new FixtureElement(); allow.textContent = "Allow once";
    const card = new FixtureElement({}, { button: [deny, allow] });
    card.textContent = "Suspicious content: external execution. PRIVATE CARD DETAILS";
    const page = new RendererFixturePage(new FixtureElement({}, {
      '[data-codex-approval-surface="true"]': [card],
    }));
    let dispatched = 0;
    page.pointerClick = async () => { dispatched++; };
    const driver = new ChatGptDomSurfaceDriver(page);
    expect((await driver.observe()).approval).toMatchObject({
      cardCount: 1,
    });
    expect(await driver.processApprovalCard("off"))
      .toEqual({ status: "none", reason: "disabled" });
    expect(dispatched).toBe(0);
    expect(await driver.processApprovalCard("full_access"))
      .toMatchObject({ status: "dispatched", reason: "allow_once" });
    expect(dispatched).toBe(1);
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
    expect((await driver.processApprovalCard("full_access")).status).toBe("dispatched");
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
        new ChatGptDomSurfaceDriver(page).processApprovalCard("full_access", owner.signal),
        new Promise<"frame_wait_stalled"> (resolve => { timer = setTimeout(() => resolve("frame_wait_stalled"), 100); }),
      ]);
      expect(outcome).toMatchObject({ status: "dispatched" });
      expect(scrolled).toBe(true); expect(frames).toBe(0);
      expect(clicks).toEqual([{ x: 20, y: 30 }]);
    } finally { clearTimeout(timer); owner.abort(); }
  });
  test("approval diagnosis preserves missing menu linkage and clipped target evidence without card data", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "tela-approval-probe-"));
    const file = join(scratch, "events.jsonl");
    const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
    class DiagnosticElement extends FixtureElement {
      parentElement: DiagnosticElement | null = null;
      id = "PRIVATE_ELEMENT_ID";
      clientWidth = 200; clientHeight = 50; clientLeft = 0; clientTop = 0;
      scrollTop = 100; scrollLeft = 0; scrollWidth = 200; scrollHeight = 500;
      hasAttribute(name: string) { return this.getAttribute(name) !== null; }
      matches(selector: string) { return selector.includes(":disabled") && this.disabled; }
    }
    try {
      const deny = new DiagnosticElement(); deny.textContent = "Deny";
      const allow = new DiagnosticElement(); allow.textContent = "Allow once";
      allow.getBoundingClientRect = () => ({ left: 10, top: 90, width: 80, height: 30 });
      const disclosure = new DiagnosticElement({ "aria-label": "Approval options", "aria-haspopup": "menu", "aria-expanded": "false" });
      const card = new DiagnosticElement({}, { button: [deny, allow, disclosure] });
      card.textContent = "PRIVATE_CARD_CONTENT";
      const viewport = new DiagnosticElement({ "data-fixture-overflow-y": "hidden" });
      viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 50 });
      card.parentElement = viewport; allow.parentElement = card;
      const blocker = new DiagnosticElement(); blocker.textContent = "PRIVATE_BLOCKER_CONTENT";
      const document = Object.assign(new DiagnosticElement({}, { '[data-codex-approval-surface="true"]': [card] }), {
        hasFocus: () => false, visibilityState: "hidden",
      });
      const page = new RendererFixturePage(document); page.hitTest = () => blocker;
      let clicks = 0; page.pointerClick = async () => { clicks++; };
      const driver = new ChatGptDomSurfaceDriver(page);
      await driver.processApprovalCard("full_access");
      const first = readFileSync(file, "utf8");
      await driver.processApprovalCard("full_access");
      const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const probes = rows.filter(row => /approval_(structure|control|layout)_observed/.test(row.stage));
      expect(probes.length).toBeGreaterThan(0);
      expect(probes).toEqual(first.trim().split("\n").map(line => JSON.parse(line))
        .filter(row => /approval_(structure|control|layout)_observed/.test(row.stage)));
      for (const row of probes) expect(structuralDiagnosticEvent(row)).toEqual(row);
      expect(probes.find(row => row.stage === "approval_structure_observed" && row.phase === "observed"))
        .toMatchObject({ probe_available: true, popup_menu_count: 1, popup_with_controls_count: 0,
          options_disclosure_count: 1, options_ready: false, document_hidden: true });
      expect(probes.find(row => row.stage === "approval_control_observed" && row.kind === "options"))
        .toMatchObject({ popup_menu: true, controls_present: false, collapsed: true });
      expect(probes.find(row => row.stage === "approval_layout_observed" && row.phase === "target" && row.depth === 2))
        .toMatchObject({ scroll_top: 100, height: 50, overflow_y_clips: true, target_center_outside_y: true });
      expect(first).not.toMatch(/PRIVATE_|Approval options|Allow once/);
      expect(clicks).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  test.each(["none", "document", "dialog", "control", "other"] as const)(
    "obstructed approval records bounded content-free %s evidence without input", async kind => {
      const scratch = mkdtempSync(join(tmpdir(), "tela-approval-obstruction-"));
      const file = join(scratch, "events.jsonl");
      const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
      try {
        const deny = new FixtureElement(); deny.textContent = "Deny";
        const allow = new FixtureElement({ "data-fixture-pointer-events": "none" }); allow.textContent = "Allow once";
        const card = new FixtureElement(); card.textContent = "PRIVATE_CARD_CONTENT";
        card.selectors.button = [deny, allow];
        const document = Object.assign(new FixtureElement({}, { '[data-codex-approval-surface="true"]': [card] }), { visibilityState: "hidden" });
        const blocker = kind === "none" ? null : kind === "document" ? document : new FixtureElement({ id: "PRIVATE_BLOCKER" });
        if (blocker && kind !== "document") {
          blocker.textContent = "PRIVATE_BLOCKER_CONTENT";
          blocker.closest = (selector?: string) =>
            (kind === "dialog" && selector?.startsWith("dialog")) || (kind === "control" && selector?.startsWith("button")) ? blocker : null;
        }
        allow.closest = () => null; // Occlusion, not an inert ancestor, is the failed boundary.
        card.contains = element => element === card || element === blocker;
        const page = new RendererFixturePage(document); page.hitTest = () => blocker;
        let clicks = 0; page.pointerClick = async () => { clicks++; };
        const driver = new ChatGptDomSurfaceDriver(page);
        expect((await driver.processApprovalCard("full_access")).status).toBe("none");
        expect((await driver.processApprovalCard("full_access")).status).toBe("none");
        let raw = readFileSync(file, "utf8");
        const witnesses = () => raw.trim().split("\n").map(line => JSON.parse(line)).filter(event => event.stage === "approval_target_failed");
        expect(witnesses()).toHaveLength(1);
        expect(structuralDiagnosticEvent(witnesses()[0])).toEqual(witnesses()[0]);
        expect(witnesses()[0]).toMatchObject({ reason_class: "occluded", dispatch_started: false,
          target_kind: kind, hit_in_card: blocker !== null, target_pointer_events_none: true, target_inert: false, document_hidden: true });
        card.textContent += " changed revision";
        expect((await driver.processApprovalCard("full_access")).status).toBe("none");
        raw = readFileSync(file, "utf8");
        expect(witnesses()).toHaveLength(2);
        expect(raw).not.toMatch(/PRIVATE_|elementFromPoint|selector/);
        expect(clicks).toBe(0);
      } finally {
        if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
        else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
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
      expect((await new ChatGptDomSurfaceDriver(page).processApprovalCard("full_access")).status).toBe("none");
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
        if ((argument as { choice?: string } | undefined)?.choice) return { ...this.lastObservation,
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
      { ...approvalCard, allowOnceCount: 2 },
    ]) {
      const page = new ApprovalPage();
      page.observations = [card];
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 50);
      try {
        const result = await new ChatGptDomSurfaceDriver(page).processApprovalCard("full_access", abort.signal, 15_000);
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
    expect(await driver.processApprovalCard("full_access", undefined, 0, expected))
      .toEqual({ status: "none", reason: "card_changed" });
    expect(clicks).toBe(0);
    const current = (await driver.observe()).approval!;
    expect(current.cardFingerprint).toBe(before.cardFingerprint);
    expect(current.revisionFingerprint).not.toBe(before.revisionFingerprint);
    expect((await driver.processApprovalCard("full_access", undefined, 0,
      { cardFingerprint: current.cardFingerprint!, revisionFingerprint: current.revisionFingerprint })).status).toBe("dispatched");
    expect(clicks).toBe(1);
  });

  test("delayed approval rechecks the same card and uses its current target", async () => {
    const page = new ApprovalPage();
    page.observations = [approvalCard, { ...approvalCard, allowOncePoint: { x: 30, y: 40 } }];
    const result = await new ChatGptDomSurfaceDriver(page).processApprovalCard("full_access", undefined, 1);
    expect(result.status).toBe("dispatched");
    expect(page.inspections).toBe(2);
    expect(page.actions).toEqual(["pointer:30,40"]);
  });

  test("delayed approval never activates a replaced, ambiguous, or disabled card", async () => {
    for (const changed of [
      { ...approvalCard, cardKey: "card-2" },
      { ...approvalCard, proofKey: "proof-2" },
      { ...approvalCard, allowOnceCount: 2 },
      { ...approvalCard, allowOncePoint: null },
    ]) {
      const page = new ApprovalPage();
      page.observations = [approvalCard, changed];
      const result = await new ChatGptDomSurfaceDriver(page).processApprovalCard("full_access", undefined, 1);
      expect(result.status).toBe("none");
      expect(page.actions).toEqual([]);
    }
  });

  test("an occluded target does not consume the card activation budget", async () => {
    const page = new ApprovalPage();
    page.observations = [approvalCard, approvalCard];
    page.preparedTarget = null;
    const driver = new ChatGptDomSurfaceDriver(page);
    expect((await driver.processApprovalCard("full_access")).reason).toBe("target_missing");
    expect(page.actions).toEqual([]);
    page.preparedTarget = { x: 30, y: 40 };
    expect((await driver.processApprovalCard("full_access")).status).toBe("dispatched");
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
      await expect(new ChatGptDomSurfaceDriver(page).processApprovalCard("full_access"))
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
    const pending = new ChatGptDomSurfaceDriver(page).processApprovalCard("full_access", owner.signal);
    await preparing; owner.abort(new DOMException("Owner ended", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    release(approvalCard); await Promise.resolve(); await Promise.resolve();
    expect(page.actions).toEqual([]);
  });
  test("cancelled approval delay cannot click the card", async () => {
    const page = new ApprovalPage();
    page.observations = [approvalCard];
    const abort = new AbortController();
    const operation = new ChatGptDomSurfaceDriver(page).processApprovalCard("full_access", abort.signal, 15_000);
    await Promise.resolve();
    abort.abort();
    await expect(operation).rejects.toThrow();
    expect(page.actions).toEqual([]);
  });

  test("one approval card is activated at most once even if it stays visible", async () => {
    const page = new ApprovalPage();
    page.observations = [approvalCard, { ...approvalCard, proofKey: "proof-2" }, { ...approvalCard, cardKey: "card-2" }];
    const driver = new ChatGptDomSurfaceDriver(page);
    expect((await driver.processApprovalCard("full_access")).status).toBe("dispatched");
    expect((await driver.processApprovalCard("full_access")).reason).toBe("already_activated");
    expect((await driver.processApprovalCard("full_access")).status).toBe("dispatched");
    expect(page.actions).toHaveLength(2);
  });

  test("an ambiguous activation is not retried for the same approval card", async () => {
    class FailedActivationPage extends ApprovalPage {
      override async pointerClick(): Promise<void> { throw new Error("activation indeterminate"); }
    }
    const page = new FailedActivationPage();
    page.observations = [approvalCard, approvalCard];
    const driver = new ChatGptDomSurfaceDriver(page);
    await expect(driver.processApprovalCard("full_access")).rejects.toThrow("indeterminate");
    expect((await driver.processApprovalCard("full_access")).reason).toBe("already_activated");
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
    const heading = new FixtureElement({ 'data-conversation-role': 'assistant' });
    heading.textContent = 'Assistant label';
    const statusBody = new FixtureElement({ 'data-markdown-text-style': 'assistant-message' });
    statusBody.textContent = 'Still thinking';
    const status = new FixtureElement();
    status.contains = element => element === status || element === statusBody;
    const answerBody = new FixtureElement({ 'data-markdown-text-style': 'assistant-message' });
    answerBody.textContent = 'Exact final response.';
    const group = new FixtureElement({ 'data-turn-key': 'owned' }, {
      '[data-markdown-text-style="assistant-message"]': [statusBody, answerBody],
      '[data-streaming-response-status]': [status],
      '[data-conversation-role="assistant"]': [heading],
      'button[data-testid="copy-turn-action-button"]': [new FixtureElement()],
    });
    const driver = new ChatGptDomSurfaceDriver(new RendererFixturePage(
      new FixtureElement({}, { '[data-turn-key]': [group] }),
    ));
    const before = (await driver.observe()).turns[0]!;
    expect(before).toMatchObject({ phase: 'complete', text: 'Exact final response.',
      plainBodyText: 'Exact final response.' });
    expect(before.bodyProof?.digest).toBeDefined();

    statusBody.textContent = 'Different progress';
    heading.textContent = 'Changed accessibility label';
    const restyled = (await driver.observe()).turns[0]!;
    expect(restyled.text).toBe(before.text);
    expect(restyled.bodyProof).toEqual(before.bodyProof);

    answerBody.textContent = 'Different final response.';
    expect((await driver.observe()).turns[0]!.bodyProof).not.toEqual(before.bodyProof);
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

  test("failed connector preparation records bounded visible structure without card or account text", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tela-connector-failure-observation-"));
    const file = join(directory, "events.jsonl");
    const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
    try {
      const page = new FakePage();
      page.raw.composers[0]!.text = "";
      page.forceMentionFailure = true;
      page.forceAddContextObservationFailure = true;
      await expect(new ChatGptDomSurfaceDriver(page).selectConnector("composer:primary", "PRIVATE_CONNECTOR_NAME"))
        .rejects.toThrow("connector selection failed");
      const events = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(events.find(row => row.stage === "selection_failed")).toMatchObject({
        reason_class: "selection_unproven", structure_observed: true,
        visible_composers: 1, visible_add_context_controls: 1,
        visible_menus: 0, visible_candidate_rows: 0,
      });
      expect(JSON.stringify(events)).not.toContain("PRIVATE_CONNECTOR_NAME");
      expect(page.raw.composers[0]?.connectorNames).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
      rmSync(directory, { recursive: true, force: true });
    }
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
