import { createHash } from "node:crypto";
import type { BrowserPageAutomation } from "@chatgpt-tela/browser-host";
import type {
  ChatGptAssistantPhase,
  ChatGptComposerObservation,
  ChatGptSendObservation,
  ChatGptSurfaceDriver,
  ChatGptSurfaceSnapshot,
  ChatGptTurnObservation,
} from "./surface";

interface RawComposer {
  readonly key: string;
  readonly visible: boolean;
  readonly editable: boolean;
  readonly ownedByChatGptForm: boolean;
  readonly text: string;
  readonly connectorNames: readonly string[];
}

interface RawSend {
  readonly key: string;
  readonly composerKey: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly semantic: "send";
}

interface RawTurn {
  readonly key: string;
  readonly role: "user" | "assistant";
  readonly parentUserTurnKey?: string;
  readonly contentText?: string;
  readonly phase?: ChatGptAssistantPhase;
  readonly text?: string;
  readonly failureDetail?: string;
}

interface RawSnapshot {
  readonly url: string;
  readonly composers: readonly RawComposer[];
  readonly sendControls: readonly RawSend[];
  readonly turns: readonly RawTurn[];
}

/**
 * Current ChatGPT composer renderer variants observed across the supported Web surface.
 * The semantic layer still requires exactly one visible/editable element and one matching
 * send control in its ancestor form; this selector list does not weaken that proof.
 */
export const CHATGPT_CURRENT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  '#prompt-textarea',
  '[contenteditable="true"][data-lexical-editor="true"]',
  'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
  '[data-composer-body] [contenteditable="true"][role="textbox"]',
].join(', ');

const COMPOSER_SELECTOR_SOURCE = JSON.stringify(CHATGPT_CURRENT_COMPOSER_SELECTOR);

const OBSERVE_CHATGPT_SURFACE = String.raw`function () {
  const visible = element => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0"
      && element.getClientRects().length > 0;
  };
  const text = element => element instanceof HTMLElement
    ? (element.innerText || element.textContent || "").replace(/\r\n?/g, "\n")
    : "";
  const composerText = element => {
    if (!(element instanceof HTMLElement)) return "";
    const clone = element.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return "";
    clone.querySelectorAll(
      '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]'
    ).forEach(part => part.remove());
    const value = [...clone.childNodes]
      .map(child => child.textContent || "")
      .join("\n")
      .replace(/\r\n?/g, "\n");
    const normalized = value.trimStart();
    return normalized.trim().length === 0 ? "" : normalized;
  };
  const connectorNames = element => {
    if (!(element instanceof HTMLElement)) return [];
    return [...element.querySelectorAll(
      '[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]'
    )].map(part => part.getAttribute("data-keyword") || part.getAttribute("app-mention-display-name") || "")
      .filter(name => name.length > 0);
  };

  const composerSelector = ${COMPOSER_SELECTOR_SOURCE};
  const composerElements = [...document.querySelectorAll(composerSelector)];
  const composers = composerElements.map((element, index) => ({
    key: composerElements.length === 1 ? "composer:primary" : "composer:" + index,
    visible: visible(element),
    editable: element.getAttribute("contenteditable") === "true",
    ownedByChatGptForm: element.closest("form[data-chatgpt-composer], form") !== null,
    text: composerText(element),
    connectorNames: connectorNames(element),
  }));

  const sendControls = [];
  composerElements.forEach((element, index) => {
    const form = element.closest("form[data-chatgpt-composer], form");
    if (!form) return;
    const composerKey = composerElements.length === 1 ? "composer:primary" : "composer:" + index;
    const controls = [...form.querySelectorAll('[data-testid="send-button"], button[type="submit"]')];
    controls.forEach((control, controlIndex) => {
      if (!(control instanceof HTMLButtonElement)) return;
      sendControls.push({
        key: controls.length === 1 ? "send:" + composerKey : "send:" + composerKey + ":" + controlIndex,
        composerKey,
        visible: visible(control),
        enabled: !control.disabled && control.getAttribute("aria-disabled") !== "true",
        semantic: "send",
      });
    });
  });

  const stopVisible = composerElements.some(element => {
    const form = element.closest('form[data-chatgpt-composer], form');
    if (!form) return false;
    return [...form.querySelectorAll('[data-testid="stop-button"], button[aria-label="Stop"]')]
      .some(visible);
  });
  const turns = [];
  for (const group of document.querySelectorAll("[data-turn-key]")) {
    if (!(group instanceof HTMLElement)) continue;
    const rawKey = group.getAttribute("data-turn-key");
    if (!rawKey) continue;
    const user = group.querySelector("[data-user-message-bubble]");
    if (user) {
      turns.push({
        key: "user:" + rawKey,
        role: "user",
        contentText: text(user),
      });
    }
    const assistant = group.querySelector('[data-conversation-role="assistant"]');
    if (assistant) {
      const complete = [...group.querySelectorAll('button[data-testid="copy-turn-action-button"], .turn-action-controls button')]
        .some(visible);
      const failure = group.querySelector('[data-message-error], [data-testid="message-error"]');
      const answer = group.querySelector('[data-markdown-text-style="assistant-message"]')
        || group.querySelector('[data-message-author-role="assistant"] .markdown')
        || assistant;
      turns.push({
        key: "assistant:" + rawKey,
        role: "assistant",
        parentUserTurnKey: "user:" + rawKey,
        // ChatGPT can expose copy/turn-action controls before generation is finished. The current
        // composer Stop control is the stronger in-progress signal and must dominate those actions.
        phase: failure ? "failed" : stopVisible ? "streaming" : complete ? "complete" : "thinking",
        text: complete ? text(answer || assistant) : undefined,
        failureDetail: failure ? text(failure) : undefined,
      });
    }
  }

  return { url: location.href, composers, sendControls, turns };
}`;

const REPLACE_COMPOSER_TEXT = String.raw`function (argument) {
  const selector = ${COMPOSER_SELECTOR_SOURCE};
  const composers = [...document.querySelectorAll(selector)].filter(element => element instanceof HTMLElement && element.getClientRects().length > 0);
  if (composers.length !== 1 || argument.composerKey !== "composer:primary") {
    throw new Error("ChatGPT current composer is not uniquely addressable");
  }
  const composer = composers[0];
  composer.focus();
  const selection = document.getSelection();
  if (!selection) throw new Error("ChatGPT composer selection is unavailable");
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection.removeAllRanges();
  selection.addRange(range);
  const command = argument.text.length === 0 ? "delete" : "insertText";
  const value = argument.text.length === 0 ? null : argument.text;
  if (!document.execCommand(command, false, value)) {
    throw new Error("ChatGPT composer rejected plain-text insertion");
  }
}`;

const APPEND_COMPOSER_TEXT = String.raw`function (argument) {
  const selector = ${COMPOSER_SELECTOR_SOURCE};
  const composers = [...document.querySelectorAll(selector)].filter(element => element instanceof HTMLElement && element.getClientRects().length > 0);
  if (composers.length !== 1 || argument.composerKey !== "composer:primary") {
    throw new Error("ChatGPT current composer is not uniquely addressable");
  }
  const composer = composers[0];
  composer.focus();
  const selection = document.getSelection();
  if (!selection) throw new Error("ChatGPT composer selection is unavailable");
  const range = document.createRange();
  range.selectNodeContents(composer);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  if (!document.execCommand("insertText", false, argument.text)) {
    throw new Error("ChatGPT composer rejected appended plain text");
  }
}`;

const FOCUS_COMPOSER = String.raw`function (argument) {
  const selector = ${COMPOSER_SELECTOR_SOURCE};
  const composers = [...document.querySelectorAll(selector)].filter(element => element instanceof HTMLElement && element.getClientRects().length > 0);
  if (composers.length !== 1 || argument.composerKey !== "composer:primary") {
    throw new Error("ChatGPT current composer is not uniquely addressable");
  }
  composers[0].focus();
}`;

const PREPARE_CONNECTOR_SELECTION = String.raw`async function (argument) {
  const composerSelector = ${COMPOSER_SELECTOR_SOURCE};
  const pillSelector = '[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]';
  const rowSelector = '.__menu-item[tabindex="0"], [data-mention-list-scroll-area] button[data-list-navigation-item="true"]';
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const activeComposer = () => {
    const composers = [...document.querySelectorAll(composerSelector)].filter(visible);
    if (composers.length !== 1 || argument.composerKey !== "composer:primary") {
      throw new Error("ChatGPT current composer is not uniquely addressable");
    }
    return composers[0];
  };
  const selectedNames = composer => [...composer.querySelectorAll(pillSelector)].filter(visible)
    .map(part => part.getAttribute("data-keyword") || part.getAttribute("app-mention-display-name") || "")
    .filter(name => name.length > 0);
  const waitUntil = async predicate => {
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const observer = new MutationObserver(() => {
        try { if (predicate()) finish(); } catch (error) { finish(error); }
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const timer = setTimeout(() => finish(new Error("ChatGPT connector target lookup timed out")), 5000);
    });
  };

  if (typeof argument.connectorName !== "string" || !argument.connectorName.trim()
    || argument.connectorName.length > 128 || /[\u0000\r\n]/.test(argument.connectorName)) {
    throw new Error("ChatGPT connector identity is invalid");
  }
  let composer = activeComposer();
  const already = selectedNames(composer);
  if (already.length > 1) throw new Error("ChatGPT composer has multiple selected connectors");
  if (already.length === 1) {
    if (already[0] !== argument.connectorName) throw new Error("ChatGPT composer has a different selected connector");
    return null;
  }
  const clone = composer.cloneNode(true);
  if (!(clone instanceof HTMLElement)) throw new Error("ChatGPT composer clone failed");
  clone.querySelectorAll(pillSelector + ', [data-inline-selection-pill-cursor-target]').forEach(part => part.remove());
  if ((clone.textContent || "").trim().length !== 0) {
    throw new Error("ChatGPT connector selection refuses a non-empty composer");
  }
  composer.focus();
  const selection = document.getSelection();
  if (!selection) throw new Error("ChatGPT composer selection is unavailable");
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection.removeAllRanges();
  selection.addRange(range);
  const query = "@" + argument.connectorName;
  if (!document.execCommand("insertText", false, query)) {
    throw new Error("ChatGPT connector mention insertion failed");
  }

  let exactRows = [];
  await waitUntil(() => {
    exactRows = [...document.querySelectorAll(rowSelector)].filter(visible).filter(row => {
      const title = ((row.innerText || row.textContent || "").split("\n")[0] || "").replace(/\s+/g, " ").trim();
      return title === argument.connectorName;
    });
    return exactRows.length > 0;
  });
  if (exactRows.length !== 1) throw new Error("ChatGPT connector menu is ambiguous for the configured identity");
  const target = exactRows[0];
  const bounds = target.getBoundingClientRect();
  if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)
    || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("ChatGPT connector menu target has invalid bounds");
  }
  return {
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  };
}`;

const PROVE_CONNECTOR_SELECTION = String.raw`async function (argument) {
  const composerSelector = ${COMPOSER_SELECTOR_SOURCE};
  const pillSelector = '[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]';
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const activeComposer = () => {
    const composers = [...document.querySelectorAll(composerSelector)].filter(visible);
    if (composers.length !== 1 || argument.composerKey !== "composer:primary") {
      throw new Error("ChatGPT current composer is not uniquely addressable");
    }
    return composers[0];
  };
  const selectedNames = composer => [...composer.querySelectorAll(pillSelector)].filter(visible)
    .map(part => part.getAttribute("data-keyword") || part.getAttribute("app-mention-display-name") || "")
    .filter(name => name.length > 0);
  const waitUntil = async predicate => {
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const observer = new MutationObserver(() => {
        try { if (predicate()) finish(); } catch (error) { finish(error); }
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const timer = setTimeout(() => finish(new Error("ChatGPT connector activation timed out")), 5000);
    });
  };

  await waitUntil(() => {
    const names = selectedNames(activeComposer());
    if (names.length > 1) throw new Error("ChatGPT composer has multiple selected connectors");
    if (names.length === 1 && names[0] !== argument.connectorName) {
      throw new Error("ChatGPT composer selected a different connector");
    }
    return names.length === 1 && names[0] === argument.connectorName;
  });
}`;

const ACTIVATE_SEND = String.raw`function (argument) {
  const composerSelector = ${COMPOSER_SELECTOR_SOURCE};
  const composers = [...document.querySelectorAll(composerSelector)].filter(element => element instanceof HTMLElement && element.getClientRects().length > 0);
  if (composers.length !== 1 || argument.controlKey !== "send:composer:primary") {
    throw new Error("ChatGPT send control is not uniquely addressable");
  }
  const form = composers[0].closest("form[data-chatgpt-composer], form");
  if (!form) throw new Error("ChatGPT composer form is unavailable");
  const controls = [...form.querySelectorAll('[data-testid="send-button"], button[type="submit"]')]
    .filter(element => element instanceof HTMLButtonElement && element.getClientRects().length > 0);
  if (controls.length !== 1) throw new Error("ChatGPT send control is not unique");
  const send = controls[0];
  if (send.disabled || send.getAttribute("aria-disabled") === "true") {
    throw new Error("ChatGPT send control is disabled");
  }
  send.click();
}`;

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function semanticRevision(value: unknown): string {
  return fingerprint(JSON.stringify(value));
}

function composer(raw: RawComposer): ChatGptComposerObservation {
  return Object.freeze({
    key: raw.key,
    visible: raw.visible,
    editable: raw.editable,
    ownedByChatGptForm: raw.ownedByChatGptForm,
    textLength: raw.text.length,
    ...(raw.text.length > 0 ? { textFingerprint: fingerprint(raw.text) } : {}),
    connectorFingerprints: Object.freeze(raw.connectorNames.map(fingerprint)),
  });
}

function turn(raw: RawTurn): ChatGptTurnObservation {
  return Object.freeze({
    key: raw.key,
    role: raw.role,
    ...(raw.parentUserTurnKey ? { parentUserTurnKey: raw.parentUserTurnKey } : {}),
    ...(raw.contentText !== undefined ? { contentFingerprint: fingerprint(raw.contentText) } : {}),
    ...(raw.phase ? { phase: raw.phase } : {}),
    ...(raw.text !== undefined ? { text: raw.text } : {}),
    ...(raw.failureDetail ? { failureDetail: raw.failureDetail } : {}),
  });
}

/**
 * Concrete current-ChatGPT DOM adapter over a product-neutral browser page executor.
 * The page script reads only structure needed for semantic proof and converts user text to hashes
 * before exposing the snapshot to the provider/runtime boundary.
 */
export class ChatGptDomSurfaceDriver implements ChatGptSurfaceDriver {
  constructor(readonly page: BrowserPageAutomation) {}

  async observe(signal?: AbortSignal): Promise<ChatGptSurfaceSnapshot> {
    const raw = await this.page.evaluate<undefined, RawSnapshot>(OBSERVE_CHATGPT_SURFACE, undefined, signal);
    const snapshot = {
      url: raw.url,
      composers: Object.freeze(raw.composers.map(composer)),
      sendControls: Object.freeze(raw.sendControls.map((control): ChatGptSendObservation => Object.freeze({ ...control }))),
      turns: Object.freeze(raw.turns.map(turn)),
    };
    return Object.freeze({ revision: semanticRevision(snapshot), ...snapshot });
  }

  async replaceComposerText(composerKey: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.page.evaluate(REPLACE_COMPOSER_TEXT, { composerKey, text }, signal);
  }

  async clearComposerText(composerKey: string, signal?: AbortSignal): Promise<void> {
    await this.page.evaluate(FOCUS_COMPOSER, { composerKey }, signal);
    await this.page.clearFocusedEditable(signal);
  }

  async appendComposerText(composerKey: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.page.evaluate(APPEND_COMPOSER_TEXT, { composerKey, text }, signal);
  }

  async selectConnector(composerKey: string, connectorName: string, signal?: AbortSignal): Promise<void> {
    const target = await this.page.evaluate<
      { readonly composerKey: string; readonly connectorName: string },
      { readonly x: number; readonly y: number } | null
    >(PREPARE_CONNECTOR_SELECTION, { composerKey, connectorName }, signal);
    if (target === null) return;
    await this.page.pointerClick(target, signal);
    await this.page.evaluate(PROVE_CONNECTOR_SELECTION, { composerKey, connectorName }, signal);
  }

  async activateSend(controlKey: string, signal?: AbortSignal): Promise<void> {
    await this.page.evaluate(ACTIVATE_SEND, { controlKey }, signal);
  }

  async waitForChange(afterRevision: string, signal?: AbortSignal): Promise<ChatGptSurfaceSnapshot> {
    let domRevision = await this.page.mutationRevision(signal);
    for (;;) {
      const snapshot = await this.observe(signal);
      if (snapshot.revision !== afterRevision) return snapshot;
      domRevision = await this.page.waitForDomMutation(domRevision, signal);
    }
  }
}
