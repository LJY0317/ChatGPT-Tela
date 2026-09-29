import { createHash } from "node:crypto";
import type { BrowserPageAutomation } from "@chatgpt-tela/browser-host";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { decideChatGptApproval, type ChatGptApprovalAutomationMode } from "./approval-policy";
import {
  ChatGptConnectorCatalogUnavailableError,
  type ChatGptAssistantPhase,
  type ChatGptComposerObservation,
  type ChatGptSendObservation,
  type ChatGptSurfaceDriver,
  type ChatGptSurfaceSnapshot,
  type ChatGptTurnObservation,
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

const INSPECT_APPROVAL_CARD = String.raw`function () {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const cards = [...document.querySelectorAll('[data-testid="tool-approval-card"]')].filter(visible);
  const result = {
    cardCount: cards.length,
    denyCount: 0,
    allowCount: 0,
    allowOnceCount: 0,
    alwaysAllowCount: 0,
    allowPoint: null,
    allowOncePoint: null,
  };
  if (cards.length !== 1) return result;
  const point = element => {
    const bounds = element.getBoundingClientRect();
    if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)
      || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
      || bounds.width <= 0 || bounds.height <= 0) return null;
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  };
  for (const button of cards[0].querySelectorAll('button,[role="button"]')) {
    if (!visible(button)) continue;
    const label = normalize(button.innerText || button.textContent);
    if (label === "Deny") result.denyCount += 1;
    else if (label === "Allow once") {
      result.allowOnceCount += 1;
      if (result.allowOnceCount === 1) result.allowOncePoint = point(button);
    } else if (label === "Allow") {
      result.allowCount += 1;
      if (result.allowCount === 1) result.allowPoint = point(button);
    } else if (label === "Always allow") result.alwaysAllowCount += 1;
  }
  return result;
}`;

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

const CLASSIFY_CONNECTOR_ARTIFACT = String.raw`function (argument) {
  const selector = ${COMPOSER_SELECTOR_SOURCE};
  const pillSelector = '[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]';
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const composers = [...document.querySelectorAll(selector)].filter(visible);
  if (composers.length !== 1 || argument.composerKey !== "composer:primary") {
    return { owned: false, reason: "composer_ambiguous" };
  }
  const composer = composers[0];
  const selected = [...composer.querySelectorAll(pillSelector)].filter(visible)
    .map(part => part.getAttribute("data-keyword") || part.getAttribute("app-mention-display-name") || "")
    .filter(Boolean);
  if (selected.length > 1) return { owned: false, reason: "multiple_connectors", selectedCount: selected.length };
  const clone = composer.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return { owned: false, reason: "clone_failed" };
  clone.querySelectorAll(pillSelector + ', [data-inline-selection-pill-cursor-target]').forEach(part => part.remove());
  const normalizedText = (clone.textContent || "")
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const exactMention = "@" + argument.connectorName;
  const productMentionArtifacts = [
    exactMention,
    exactMention + " " + exactMention,
    exactMention + " " + exactMention + " " + exactMention,
  ];
  let connectorMatches = 0;
  let connectorOffset = 0;
  while (connectorOffset <= normalizedText.length) {
    const next = normalizedText.indexOf(argument.connectorName, connectorOffset);
    if (next < 0) break;
    connectorMatches += 1;
    connectorOffset = next + argument.connectorName.length;
  }
  const atCount = [...normalizedText].filter(character => character === "@").length;
  let remainder = normalizedText;
  for (let index = 0; index < 4; index += 1) {
    remainder = remainder.replace("@" + argument.connectorName, "");
  }
  remainder = remainder.replace(/\s+/g, "");
  const selectedExact = selected.length === 1 && selected[0] === argument.connectorName;
  const selectedKnownDevelopment = argument.connectorName === "ChatGPT Tela"
    && selected.length === 1
    && selected[0] === "ChatGPT Tela Development";
  const owned = (selected.length === 0 && productMentionArtifacts.includes(normalizedText))
    || ((selectedExact || selectedKnownDevelopment) && normalizedText.length === 0);
  return {
    owned,
    reason: owned ? "recognized" : "unrecognized",
    normalizedLength: normalizedText.length,
    connectorMatches,
    atCount,
    remainderLength: remainder.length,
    selectedCount: selected.length,
    selectedExact,
    selectedKnownDevelopment,
  };
}`;

const PREPARE_CONNECTOR_SELECTION = String.raw`async function (argument) {
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

  if (typeof argument.connectorName !== "string" || !argument.connectorName.trim()
    || argument.connectorName.length > 128 || /[\u0000\r\n]/.test(argument.connectorName)) {
    throw new Error("ChatGPT connector identity is invalid");
  }
  let composer = activeComposer();
  const already = selectedNames(composer);
  if (already.length > 1) throw new Error("ChatGPT composer has multiple selected connectors");
  if (already.length === 1) {
    if (already[0] !== argument.connectorName) throw new Error("ChatGPT composer has a different selected connector");
    return "selected";
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
  return "ready";
}`;

const LOCATE_CONNECTOR_TARGET = String.raw`async function (argument) {
  const composerSelector = ${COMPOSER_SELECTOR_SOURCE};
  const rowSelector = '.__menu-item[tabindex="0"], [data-mention-list-scroll-area] button[data-list-navigation-item="true"]';
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const waitUntil = async (predicate, timeoutMessage) => {
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
      const timer = setTimeout(() => finish(new Error(timeoutMessage())), 5000);
    });
  };

  let visibleRows = [];
  let exactRows = [];
  let exactVisibleAnywhere = 0;
  let visibleListboxes = 0;
  let visibleMenus = 0;
  let visibleDialogs = 0;
  let mentionChars = 0;
  let composerFocused = false;
  let visibleAddContextButtons = 0;
  let temporaryChat = false;
  await waitUntil(() => {
    visibleRows = [...document.querySelectorAll(rowSelector)].filter(visible);
    exactRows = visibleRows.filter(row => {
      const title = ((row.innerText || row.textContent || "").split("\n")[0] || "").replace(/\s+/g, " ").trim();
      return title === argument.connectorName;
    });
    exactVisibleAnywhere = [...document.querySelectorAll("body *")].filter(visible).filter(element => {
      const title = ((element.innerText || element.textContent || "").split("\n")[0] || "").replace(/\s+/g, " ").trim();
      return title === argument.connectorName;
    }).length;
    visibleListboxes = [...document.querySelectorAll('[role="listbox"]')].filter(visible).length;
    visibleMenus = [...document.querySelectorAll('[role="menu"]')].filter(visible).length;
    visibleDialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible).length;
    const composers = [...document.querySelectorAll(composerSelector)].filter(visible);
    if (composers.length === 1) {
      const composer = composers[0];
      mentionChars = (composer.textContent || "").length;
      composerFocused = composer === document.activeElement || composer.contains(document.activeElement);
    }
    visibleAddContextButtons = [...document.querySelectorAll('button[data-composer-navigation-target="add-context"]')]
      .filter(visible).length;
    try { temporaryChat = new URL(location.href).searchParams.get("temporary-chat") === "true"; }
    catch { temporaryChat = false; }
    return exactRows.length > 0;
  }, () => "ChatGPT connector target lookup timed out (visible_rows=" + visibleRows.length
    + ", exact_rows=" + exactRows.length
    + ", exact_visible_anywhere=" + exactVisibleAnywhere
    + ", listboxes=" + visibleListboxes
    + ", menus=" + visibleMenus
    + ", dialogs=" + visibleDialogs
    + ", mention_chars=" + mentionChars
    + ", composer_focused=" + composerFocused
    + ", add_context_buttons=" + visibleAddContextButtons
    + ", temporary_chat=" + temporaryChat + ")");
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

const PREPARE_ADD_CONTEXT = String.raw`function () {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const buttons = [...document.querySelectorAll('button[data-composer-navigation-target="add-context"]')]
    .filter(visible);
  if (buttons.length !== 1) {
    throw new Error("ChatGPT add-context control is not unique (visible=" + buttons.length + ")");
  }
  const bounds = buttons[0].getBoundingClientRect();
  if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)
    || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("ChatGPT add-context control has invalid bounds");
  }
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}`;

const LOCATE_ADD_CONTEXT_TARGET = String.raw`async function (argument) {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const fullText = element => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  const normalized = element => ((element.innerText || element.textContent || "").split("\n")[0] || "")
    .replace(/\s+/g, " ").trim();
  const candidates = () => [...document.querySelectorAll(
    'button[data-list-navigation-item="true"], [role="menuitem"], [role="option"]',
  )].filter(visible);
  const point = element => {
    const bounds = element.getBoundingClientRect();
    if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)
      || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
      || bounds.width <= 0 || bounds.height <= 0) {
      throw new Error("ChatGPT add-context target has invalid bounds");
    }
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  };
  const highlighted = element => element.getAttribute("data-highlighted") !== null
    || element.getAttribute("aria-current") === "true"
    || element.getAttribute("aria-selected") === "true";
  const result = (kind, element, rows) => ({
    kind,
    ...point(element),
    rowCount: rows.length,
    targetIndex: rows.indexOf(element),
    highlighted: highlighted(element),
    highlightedIndex: rows.findIndex(highlighted),
    categoryShapes,
    genericAttributeShapes,
  });
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
      const timer = setTimeout(() => finish(), 3000);
    });
  };

  let rows = [];
  let exact = [];
  let more = [];
  let apps = [];
  let exactContained = [];
  let moreContained = [];
  let appsContained = [];
  let pluginsContained = [];
  let sourcesContained = [];
  let toolsContained = [];
  let connectorsContained = [];
  let categoryShapes = [];
  let genericAttributeShapes = [];
  await waitUntil(() => {
    rows = candidates();
    exact = rows.filter(row => normalized(row) === argument.connectorName);
    more = rows.filter(row => ["More", "더 보기"].includes(normalized(row)));
    apps = rows.filter(row => ["Apps", "앱", "Plugins", "플러그인"].includes(normalized(row)));
    exactContained = rows.filter(row => fullText(row).includes(argument.connectorName));
    moreContained = rows.filter(row => /(^|\s)(More|더 보기)(\s|$)/i.test(fullText(row)));
    appsContained = rows.filter(row => /(^|\s)(Apps?|앱)(\s|$)/i.test(fullText(row)));
    pluginsContained = rows.filter(row => /(^|\s)(Plugins?|플러그인)(\s|$)/i.test(fullText(row)));
    sourcesContained = rows.filter(row => /(^|\s)(Sources?|소스)(\s|$)/i.test(fullText(row)));
    toolsContained = rows.filter(row => /(^|\s)(Tools?|도구)(\s|$)/i.test(fullText(row)));
    connectorsContained = rows.filter(row => /(^|\s)(Connectors?|커넥터)(\s|$)/i.test(fullText(row)));
    const categorized = [
      ...appsContained.map(row => ["apps", row]),
      ...toolsContained.map(row => ["tools", row]),
      ...moreContained.map(row => ["more", row]),
      ...pluginsContained.map(row => ["plugins", row]),
      ...sourcesContained.map(row => ["sources", row]),
      ...connectorsContained.map(row => ["connectors", row]),
    ];
    categoryShapes = categorized.map(([kind, row]) => {
      const bounds = row.getBoundingClientRect();
      return [
        kind,
        row.tagName.toLowerCase(),
        row.getAttribute("role") || "none",
        row.getAttribute("data-testid") || "none",
        row.getAttribute("data-list-navigation-item") || "none",
        row.getAttribute("data-composer-navigation-target") || "none",
        row.getAttribute("aria-haspopup") || "none",
        row.getAttribute("aria-expanded") || "none",
        Math.round(bounds.width),
        Math.round(bounds.height),
      ].join(":");
    });
    const genericPattern = /(more|apps?|plugins?|tools?|sources?|connectors?|더\s*보기|앱|플러그인|도구|소스|커넥터)/i;
    genericAttributeShapes = rows.flatMap((row, index) => {
      const values = [
        ["aria-label", row.getAttribute("aria-label")],
        ["title", row.getAttribute("title")],
        ["data-testid", row.getAttribute("data-testid")],
        ["data-value", row.getAttribute("data-value")],
        ["data-action", row.getAttribute("data-action")],
        ["data-state", row.getAttribute("data-state")],
      ].filter(([, value]) => typeof value === "string" && genericPattern.test(value));
      return values.map(([name, value]) => [index, name, value].join(":"));
    });
    return exact.length > 0 || more.length > 0 || apps.length > 0 || exactContained.length > 0;
  });
  if (exact.length === 1) return result("connector", exact[0], rows);
  if (exactContained.length === 1) return result("connector", exactContained[0], rows);
  if (exactContained.length > 1) throw new Error("ChatGPT add-context menu exposed duplicate connector-containing rows");
  if (exact.length > 1) throw new Error("ChatGPT add-context menu exposed duplicate exact connector rows");
  if (more.length === 1) return result("more", more[0], rows);
  if (more.length > 1) throw new Error("ChatGPT add-context menu exposed duplicate More rows");
  if (moreContained.length === 1) return result("more", moreContained[0], rows);
  if (moreContained.length > 1) throw new Error("ChatGPT add-context menu exposed duplicate More-containing rows");
  if (apps.length === 1) return result("apps", apps[0], rows);
  if (apps.length > 1) throw new Error("ChatGPT add-context menu exposed duplicate Apps rows");
  if (appsContained.length === 1) return result("apps", appsContained[0], rows);
  if (appsContained.length > 1) throw new Error("ChatGPT add-context menu exposed duplicate Apps-containing rows");
  if (toolsContained.length === 1) return result("apps", toolsContained[0], rows);
  if (toolsContained.length > 1) throw new Error("ChatGPT add-context menu exposed duplicate Tools-containing rows");
  throw new Error(
    "ChatGPT add-context menu exposed no recognized connector path"
    + " (visible_rows=" + rows.length
    + ", exact_rows=" + exact.length
    + ", more_rows=" + more.length
    + ", apps_rows=" + apps.length
    + ", exact_contained=" + exactContained.length
    + ", more_contained=" + moreContained.length
    + ", apps_contained=" + appsContained.length
    + ", plugins_contained=" + pluginsContained.length
    + ", sources_contained=" + sourcesContained.length
    + ", tools_contained=" + toolsContained.length
    + ", connectors_contained=" + connectorsContained.length
    + ", category_shapes=" + categoryShapes.join("|")
    + ", generic_attribute_shapes=" + genericAttributeShapes.join("|") + ")",
  );
}`;

const ACTIVATE_ADD_CONTEXT_TARGET = String.raw`function (argument) {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const fullText = element => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  const normalized = element => ((element.innerText || element.textContent || "").split("\n")[0] || "")
    .replace(/\s+/g, " ").trim();
  const rows = [...document.querySelectorAll(
    'button[data-list-navigation-item="true"], [role="menuitem"], [role="option"]',
  )].filter(visible);
  const more = rows.filter(row => ["More", "더 보기", "더보기"].includes(normalized(row)));
  const moreContained = rows.filter(row => /(^|\s)(More|더\s*보기)(\s|$)/i.test(fullText(row)));
  const apps = rows.filter(row => ["Apps", "앱", "Plugins", "플러그인"].includes(normalized(row)));
  const appsContained = rows.filter(row => /(^|\s)(Apps?|앱)(\s|$)/i.test(fullText(row)));
  const toolsContained = rows.filter(row => /(^|\s)(Tools?|도구)(\s|$)/i.test(fullText(row)));
  const chooseOne = candidates => candidates.length === 1 ? candidates[0] : null;
  const target = chooseOne(more)
    || chooseOne(moreContained)
    || chooseOne(apps)
    || chooseOne(appsContained)
    || chooseOne(toolsContained);
  if (!target) return false;
  target.click();
  return true;
}`;

const LOCATE_INTEGRATION_CONTEXT_TARGET = String.raw`function (argument) {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const normalized = element => ((element.innerText || element.textContent || "").split("\n")[0] || "")
    .replace(/\s+/g, " ").trim();
  const expected = argument.kind === "apps"
    ? ["Apps", "App", "앱"]
    : argument.kind === "plugins"
      ? ["Plugins", "Plugin", "플러그인"]
      : [];
  if (expected.length === 0) throw new Error("ChatGPT integration context kind is invalid");
  const candidates = [...document.querySelectorAll(
    'button, [role="button"], [role="menuitem"], [role="option"]',
  )].filter(visible).filter(element => expected.includes(normalized(element)));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw new Error("ChatGPT plugin context control is ambiguous (visible=" + candidates.length + ")");
  }
  const bounds = candidates[0].getBoundingClientRect();
  if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)
    || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("ChatGPT plugin context control has invalid bounds");
  }
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}`;

const LOCATE_INTEGRATION_TAB_TARGET = String.raw`function (argument) {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const normalized = element => ((element.innerText || element.textContent || "").split("\n")[0] || "")
    .replace(/\s+/g, " ").trim();
  const expected = argument.kind === "apps"
    ? ["Apps", "App", "앱"]
    : argument.kind === "plugins"
      ? ["Plugins", "Plugin", "플러그인"]
      : [];
  if (expected.length === 0) throw new Error("ChatGPT integration tab kind is invalid");
  const candidates = [...document.querySelectorAll('[role="tab"]')]
    .filter(visible)
    .filter(element => expected.includes(normalized(element)));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw new Error("ChatGPT integration tab is ambiguous (visible=" + candidates.length + ")");
  }
  const bounds = candidates[0].getBoundingClientRect();
  if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)
    || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("ChatGPT integration tab has invalid bounds");
  }
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}`;

const INSPECT_PLUGIN_CONTEXT = String.raw`function (argument) {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const text = element => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  const elements = [...document.querySelectorAll("body *")].filter(visible);
  const exact = elements.filter(element => text(element) === argument.connectorName);
  const contained = elements.filter(element => text(element).includes(argument.connectorName));
  const clickable = new Set();
  for (const element of exact) {
    const target = element.closest('button, [role="button"], a[href], [data-list-navigation-item="true"], [tabindex]');
    if (target && visible(target)) clickable.add(target);
  }
  const shapes = [...clickable].slice(0, 12).map((element, index) => {
    const bounds = element.getBoundingClientRect();
    return [
      index,
      element.tagName.toLowerCase(),
      element.getAttribute("role") || "none",
      element.getAttribute("data-testid") || "none",
      element.getAttribute("data-list-navigation-item") || "none",
      element.getAttribute("tabindex") || "none",
      Math.round(bounds.width),
      Math.round(bounds.height),
    ].join(":");
  });
  const category = value => {
    if (/(^|\s)(More|더\s*보기)(\s|$)/i.test(value)) return "more";
    if (/(^|\s)(Apps?|앱)(\s|$)/i.test(value)) return "apps";
    if (/(^|\s)(Plugins?|플러그인)(\s|$)/i.test(value)) return "plugins";
    if (/(^|\s)(Tools?|도구)(\s|$)/i.test(value)) return "tools";
    if (/(^|\s)(Sources?|소스)(\s|$)/i.test(value)) return "sources";
    if (/(^|\s)(Connectors?|커넥터)(\s|$)/i.test(value)) return "connectors";
    if (/(^|\s)(Search|검색)(\s|$)/i.test(value)) return "search";
    return null;
  };
  const generic = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [role="tab"]')]
    .filter(visible)
    .filter(element => category(text(element)) !== null)
    .slice(0, 24)
    .map((element, index) => [
      index,
      category(text(element)),
      element.tagName.toLowerCase(),
      element.getAttribute("role") || "none",
      element.getAttribute("data-testid") || "none",
      element instanceof HTMLButtonElement && element.disabled ? "disabled" : "enabled",
      element.getAttribute("aria-disabled") || "none",
      element.getAttribute("data-state") || "none",
      element.getAttribute("aria-haspopup") || "none",
      element.getAttribute("aria-expanded") || "none",
      element.parentElement?.tagName.toLowerCase() || "none",
      element.parentElement?.getAttribute("role") || "none",
      element.parentElement?.getAttribute("data-testid") || "none",
      Math.round(element.getBoundingClientRect().width),
      Math.round(element.getBoundingClientRect().height),
    ].join(":"));
  return {
    exactCount: exact.length,
    containedCount: contained.length,
    clickableCount: clickable.size,
    clickableShapes: shapes,
    genericControls: generic,
    dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(visible).length,
    listboxes: [...document.querySelectorAll('[role="listbox"]')].filter(visible).length,
    menus: [...document.querySelectorAll('[role="menu"]')].filter(visible).length,
    searchInputs: [...document.querySelectorAll('input[type="search"], input[role="searchbox"], [role="searchbox"]')]
      .filter(visible).length,
  };
}`;

const LOCATE_EXACT_CONTEXT_CONNECTOR = String.raw`async function (argument) {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const normalized = element => ((element.innerText || element.textContent || "").split("\n")[0] || "")
    .replace(/\s+/g, " ").trim();
  const selector = 'button[data-list-navigation-item="true"], [role="menuitem"], [role="option"]';
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
      const timer = setTimeout(() => finish(), 8000);
    });
  };
  let rows = [];
  let exact = [];
  let exactTextElements = [];
  let exactClickableAncestors = [];
  let exactLineElements = [];
  let exactLineLeafElements = [];
  let stableContainedElements = [];
  let stableContainedLeafElements = [];
  let stableClickableAncestors = [];
  let stableClickableLeaves = [];
  let stableClickableShapes = [];
  let excludedContainedElements = [];
  let exactVisibleAnywhere = 0;
  let visibleDialogs = 0;
  let visibleListboxes = 0;
  let visibleMenus = 0;
  let visibleSearchInputs = 0;
  let pageClass = "other";
  let genericControlShapes = [];
  await waitUntil(() => {
    rows = [...document.querySelectorAll(selector)].filter(visible);
    exact = rows.filter(row => normalized(row) === argument.connectorName);
    const visibleElements = [...document.querySelectorAll("body *")].filter(visible);
    const elementText = element => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    exactTextElements = visibleElements.filter(element => {
      const text = elementText(element);
      return text === argument.connectorName;
    });
    const hasExactLine = element => (element.innerText || element.textContent || "")
      .split("\n").map(line => line.replace(/\s+/g, " ").trim())
      .includes(argument.connectorName);
    exactLineElements = visibleElements.filter(hasExactLine);
    exactLineLeafElements = exactLineElements.filter(element => (
      ![...element.children].some(child => visible(child) && hasExactLine(child))
    ));
    const excluded = typeof argument.excludedConnectorName === "string" && argument.excludedConnectorName
      ? argument.excludedConnectorName : undefined;
    stableContainedElements = visibleElements.filter(element => {
      const text = elementText(element);
      return text.includes(argument.connectorName) && (!excluded || !text.includes(excluded));
    });
    stableContainedLeafElements = stableContainedElements.filter(element => (
      ![...element.children].some(child => visible(child)
        && elementText(child).includes(argument.connectorName)
        && (!excluded || !elementText(child).includes(excluded)))
    ));
    excludedContainedElements = excluded
      ? visibleElements.filter(element => elementText(element).includes(excluded))
      : [];
    exactVisibleAnywhere = visibleElements.filter(element => {
      const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      return text === argument.connectorName || text.includes(argument.connectorName);
    }).length;
    const clickable = new Set();
    for (const element of exactTextElements) {
      const target = element.closest(
        'button, [role="button"], a[href], [data-list-navigation-item="true"], [tabindex="0"]',
      );
      if (target && visible(target)) clickable.add(target);
    }
    exactClickableAncestors = [...clickable];
    const stableClickable = new Set();
    for (const element of stableContainedLeafElements) {
      const target = element.closest(
        'button, [role="button"], a[href], [data-list-navigation-item="true"], [tabindex]',
      );
      if (target && visible(target)) stableClickable.add(target);
    }
    stableClickableAncestors = [...stableClickable];
    stableClickableLeaves = stableClickableAncestors.filter((element, index) => (
      !stableClickableAncestors.some((other, otherIndex) => otherIndex !== index && element.contains(other))
    ));
    stableClickableShapes = stableClickableAncestors.map((element, index) => {
      const bounds = element.getBoundingClientRect();
      return [
        index,
        element.tagName.toLowerCase(),
        element.getAttribute("role") || "none",
        element.getAttribute("data-list-navigation-item") || "none",
        element.getAttribute("data-testid") || "none",
        element.getAttribute("data-state") || "none",
        element.getAttribute("aria-current") || "none",
        element.getAttribute("aria-pressed") || "none",
        element.getAttribute("tabindex") || "none",
        Math.round(bounds.width),
        Math.round(bounds.height),
        stableClickableAncestors.some((other, otherIndex) => otherIndex !== index && element.contains(other)) ? 1 : 0,
        stableClickableAncestors.some((other, otherIndex) => otherIndex !== index && other.contains(element)) ? 1 : 0,
      ].join(":");
    });
    visibleDialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible).length;
    visibleListboxes = [...document.querySelectorAll('[role="listbox"]')].filter(visible).length;
    visibleMenus = [...document.querySelectorAll('[role="menu"]')].filter(visible).length;
    visibleSearchInputs = [...document.querySelectorAll(
      'input[type="search"], input[role="searchbox"], [role="searchbox"], input[placeholder]',
    )].filter(visible).length;
    try {
      const url = new URL(location.href);
      pageClass = url.pathname === "/" ? "home"
        : url.pathname.startsWith("/c/") ? "conversation"
        : url.pathname.includes("settings") ? "settings"
        : url.pathname.includes("plugin") || url.pathname.includes("apps") ? "plugins"
        : "other";
    } catch { pageClass = "other"; }
    const categoryFor = text => {
      if (/(^|\s)(More|더\s*보기)(\s|$)/i.test(text)) return "more";
      if (/(^|\s)(Apps?|앱)(\s|$)/i.test(text)) return "apps";
      if (/(^|\s)(Plugins?|플러그인)(\s|$)/i.test(text)) return "plugins";
      if (/(^|\s)(Tools?|도구)(\s|$)/i.test(text)) return "tools";
      if (/(^|\s)(Sources?|소스)(\s|$)/i.test(text)) return "sources";
      if (/(^|\s)(Connectors?|커넥터)(\s|$)/i.test(text)) return "connectors";
      if (/(^|\s)(Search|검색)(\s|$)/i.test(text)) return "search";
      return null;
    };
    genericControlShapes = [...document.querySelectorAll(
      'button, [role="button"], [role="menuitem"], [role="option"], [role="tab"]',
    )].filter(visible).flatMap((element, index) => {
      const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      const category = categoryFor(text);
      if (!category) return [];
      const bounds = element.getBoundingClientRect();
      return [[
        index,
        category,
        element.tagName.toLowerCase(),
        element.getAttribute("role") || "none",
        element.getAttribute("data-testid") || "none",
        element.getAttribute("aria-haspopup") || "none",
        element.getAttribute("aria-expanded") || "none",
        Math.round(bounds.width),
        Math.round(bounds.height),
      ].join(":")];
    }).slice(0, 32);
    return exact.length > 0 || exactClickableAncestors.length > 0 || exactLineLeafElements.length > 0
      || stableClickableAncestors.length > 0;
  });
  const targets = exact.length === 1
    ? exact
      : exactClickableAncestors.length === 1
      ? exactClickableAncestors
      : exactLineLeafElements.length === 1
        ? exactLineLeafElements
        : stableClickableLeaves.length === 1
          ? stableClickableLeaves
        : stableClickableAncestors;
  if (exact.length === 0
    && exactClickableAncestors.length === 0
    && exactLineLeafElements.length === 0
    && stableClickableAncestors.length > 0) {
    throw new Error("ChatGPT context picker stable fallback diagnostic"
      + " (stable_clickable_ancestors=" + stableClickableAncestors.length
      + ", stable_clickable_shapes=" + stableClickableShapes.join("|") + ")");
  }
  if (targets.length !== 1) {
    throw new Error("ChatGPT context picker did not expose one exact connector"
      + " (visible_rows=" + rows.length
      + ", exact_rows=" + exact.length
      + ", exact_text_elements=" + exactTextElements.length
      + ", exact_clickable_ancestors=" + exactClickableAncestors.length
      + ", exact_line_elements=" + exactLineElements.length
      + ", exact_line_leaf_elements=" + exactLineLeafElements.length
      + ", stable_contained=" + stableContainedElements.length
      + ", stable_contained_leaf=" + stableContainedLeafElements.length
      + ", stable_clickable_ancestors=" + stableClickableAncestors.length
      + ", stable_clickable_leaves=" + stableClickableLeaves.length
      + ", stable_clickable_shapes=" + stableClickableShapes.join("|")
      + ", excluded_contained=" + excludedContainedElements.length
      + ", exact_visible_anywhere=" + exactVisibleAnywhere
      + ", dialogs=" + visibleDialogs
      + ", listboxes=" + visibleListboxes
      + ", menus=" + visibleMenus
      + ", search_inputs=" + visibleSearchInputs
      + ", page_class=" + pageClass
      + ", generic_controls=" + genericControlShapes.join("|") + ")");
  }
  const bounds = targets[0].getBoundingClientRect();
  if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)
    || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("ChatGPT context connector row has invalid bounds");
  }
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
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
  const waitUntil = async (predicate, timeoutMessage) => {
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
      const timer = setTimeout(() => finish(new Error(timeoutMessage())), 5000);
    });
  };

  let selectedCount = 0;
  await waitUntil(() => {
    const names = selectedNames(activeComposer());
    selectedCount = names.length;
    if (names.length > 1) throw new Error("ChatGPT composer has multiple selected connectors");
    if (names.length === 1 && names[0] !== argument.connectorName) {
      throw new Error("ChatGPT composer selected a different connector");
    }
    return names.length === 1 && names[0] === argument.connectorName;
  }, () => "ChatGPT connector activation timed out (selected_count=" + selectedCount + ")");
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

  #diagnostic(stage: string, fields: Readonly<Record<string, string | number | boolean>> = {}): void {
    emitDiagnosticEvent("chatgpt_tela_connector", stage, fields);
  }

  async #settleUi(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("operation aborted", "AbortError");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, 250);
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new DOMException("operation aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

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

  async dismissTransientUi(signal?: AbortSignal): Promise<void> {
    await this.page.pressKey("Escape", signal);
  }

  async recoverConnectorArtifact(composerKey: string, connectorName: string, signal?: AbortSignal): Promise<boolean> {
    const classification = await this.page.evaluate<
      { readonly composerKey: string; readonly connectorName: string },
      {
        readonly owned: boolean;
        readonly reason: string;
        readonly normalizedLength?: number;
        readonly connectorMatches?: number;
        readonly atCount?: number;
        readonly remainderLength?: number;
        readonly selectedCount?: number;
        readonly selectedExact?: boolean;
        readonly selectedKnownDevelopment?: boolean;
      }
    >(CLASSIFY_CONNECTOR_ARTIFACT, { composerKey, connectorName }, signal);
    if (!classification.owned) {
      this.#diagnostic("artifact_not_owned", {
        reason: classification.reason,
        normalized_length: classification.normalizedLength ?? -1,
        connector_matches: classification.connectorMatches ?? -1,
        at_count: classification.atCount ?? -1,
        remainder_length: classification.remainderLength ?? -1,
        selected_count: classification.selectedCount ?? -1,
        selected_exact: classification.selectedExact ?? false,
        selected_known_development: classification.selectedKnownDevelopment ?? false,
      });
      return false;
    }
    this.#diagnostic("artifact_recovered", {
      normalized_length: classification.normalizedLength ?? 0,
      connector_matches: classification.connectorMatches ?? 0,
      at_count: classification.atCount ?? 0,
    });
    await this.page.evaluate(FOCUS_COMPOSER, { composerKey }, signal);
    await this.page.clearFocusedEditable(signal);
    return true;
  }

  async processApprovalCard(
    mode: ChatGptApprovalAutomationMode,
    signal?: AbortSignal,
  ): Promise<{ readonly status: "none" | "approved"; readonly reason: string }> {
    const observed = await this.page.evaluate<undefined, {
      readonly cardCount: number;
      readonly denyCount: number;
      readonly allowCount: number;
      readonly allowOnceCount: number;
      readonly alwaysAllowCount: number;
      readonly allowPoint: { readonly x: number; readonly y: number } | null;
      readonly allowOncePoint: { readonly x: number; readonly y: number } | null;
    }>(INSPECT_APPROVAL_CARD, undefined, signal);
    const decision = decideChatGptApproval(mode, observed);
    this.#diagnostic("approval_policy", {
      mode,
      action: decision.action,
      card_count: observed.cardCount,
      deny_count: observed.denyCount,
      allow_count: observed.allowCount,
      allow_once_count: observed.allowOnceCount,
      always_allow_count: observed.alwaysAllowCount,
    });
    if (decision.action !== "approve_once") {
      return Object.freeze({ status: "none" as const, reason: decision.reason });
    }
    const target = observed.allowOncePoint;
    if (!target) {
      this.#diagnostic("approval_target_missing", { preferred: decision.preferredChoice });
      return Object.freeze({ status: "none" as const, reason: "target_missing" });
    }
    await this.page.pointerClick(target, signal);
    this.#diagnostic("approval_activated", { choice: decision.preferredChoice });
    return Object.freeze({ status: "approved" as const, reason: decision.preferredChoice });
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
    this.#diagnostic("selection_start");
    const prepared = await this.page.evaluate<
      { readonly composerKey: string; readonly connectorName: string },
      "ready" | "selected"
    >(PREPARE_CONNECTOR_SELECTION, { composerKey, connectorName }, signal);
    if (prepared === "selected") {
      this.#diagnostic("already_selected");
      return;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 1; attempt += 1) {
      this.#diagnostic("mention_attempt", { attempt: attempt + 1 });
      if (attempt > 0) {
        await this.page.clearFocusedEditable(signal);
        await this.page.evaluate(FOCUS_COMPOSER, { composerKey }, signal);
      }
      await this.page.typeFocusedEditable(`@${connectorName}`, signal);
      try {
        const target = await this.page.evaluate<
          { readonly connectorName: string },
          { readonly x: number; readonly y: number }
        >(LOCATE_CONNECTOR_TARGET, { connectorName }, signal);
        await this.page.pointerClick(target, signal);
        await this.page.evaluate(PROVE_CONNECTOR_SELECTION, { composerKey, connectorName }, signal);
        this.#diagnostic("mention_selection_proven");
        return;
      } catch (error) {
        lastError = error;
        this.#diagnostic("mention_attempt_failed", { attempt: attempt + 1 });
      }
    }
    try {
      this.#diagnostic("add_context_fallback_start");
      await this.dismissTransientUi(signal);
      await this.#settleUi(signal);
      await this.page.evaluate(FOCUS_COMPOSER, { composerKey }, signal);
      await this.page.clearFocusedEditable(signal);
      let first: {
        readonly kind: "connector" | "more" | "apps";
        readonly x: number;
        readonly y: number;
        readonly rowCount: number;
        readonly targetIndex: number;
        readonly highlighted: boolean;
        readonly highlightedIndex: number;
        readonly categoryShapes: readonly string[];
        readonly genericAttributeShapes: readonly string[];
      } | undefined;
      let addContextError: unknown;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (attempt > 1) {
          this.#diagnostic("add_context_retry", { attempt });
          await this.dismissTransientUi(signal);
          await this.#settleUi(signal);
          await this.page.evaluate(FOCUS_COMPOSER, { composerKey }, signal);
          await this.page.clearFocusedEditable(signal);
        }
        const addContext = await this.page.evaluate<undefined, { readonly x: number; readonly y: number }>(
          PREPARE_ADD_CONTEXT,
          undefined,
          signal,
        );
        await this.page.pointerClick(addContext, signal);
        this.#diagnostic("add_context_opened", { attempt });
        try {
          first = await this.page.evaluate<
        { readonly connectorName: string },
        {
          readonly kind: "connector" | "more" | "apps";
          readonly x: number;
          readonly y: number;
          readonly rowCount: number;
          readonly targetIndex: number;
          readonly highlighted: boolean;
          readonly highlightedIndex: number;
          readonly categoryShapes: readonly string[];
          readonly genericAttributeShapes: readonly string[];
        }
          >(LOCATE_ADD_CONTEXT_TARGET, { connectorName }, signal);
          break;
        } catch (error) {
          addContextError = error;
          this.#diagnostic("add_context_observation_failed", { attempt });
        }
      }
      if (!first) throw addContextError instanceof Error
        ? addContextError
        : new Error("ChatGPT add-context menu did not become observable");
      this.#diagnostic("add_context_category_found", {
        kind: first.kind,
        row_count: first.rowCount,
        target_index: first.targetIndex,
        highlighted_index: first.highlightedIndex,
        category_shapes: first.categoryShapes.join("|"),
        generic_attribute_shapes: first.genericAttributeShapes.join("|"),
      });
      if (first.kind === "connector") {
        // Hidden/offscreen Chromium surfaces can expose the exact connector row while refusing a
        // compositor pointer activation. The downstream bridge proved that ChatGPT's menu keyboard
        // owner remains reliable here: move the real highlight onto the exact row, press Enter, and
        // accept the action only after the exact selected-connector pill appears in the composer.
        // This loop is bounded by the currently visible row count and never guesses a row by text
        // after activation.
        let observed = first;
        for (let step = 0; step <= first.rowCount; step += 1) {
          if (observed.highlighted) {
            this.#diagnostic("add_context_connector_keyboard_ready", {
              step,
              target_index: observed.targetIndex,
              highlighted_index: observed.highlightedIndex,
            });
            await this.page.pressKey("Enter", signal);
            this.#diagnostic("add_context_connector_keyboard_activated", { step });
            await this.page.evaluate(PROVE_CONNECTOR_SELECTION, { composerKey, connectorName }, signal);
            this.#diagnostic("add_context_selection_proven");
            return;
          }
          if (step === first.rowCount) break;
          await this.page.pressKey("ArrowDown", signal);
          await this.#settleUi(signal);
          observed = await this.page.evaluate<
            { readonly connectorName: string },
            {
              readonly kind: "connector" | "more" | "apps";
              readonly x: number;
              readonly y: number;
              readonly rowCount: number;
              readonly targetIndex: number;
              readonly highlighted: boolean;
              readonly highlightedIndex: number;
              readonly categoryShapes: readonly string[];
              readonly genericAttributeShapes: readonly string[];
            }
          >(LOCATE_ADD_CONTEXT_TARGET, { connectorName }, signal);
          if (observed.kind !== "connector") break;
        }
        this.#diagnostic("add_context_connector_keyboard_unavailable", {
          target_index: observed.targetIndex,
          highlighted_index: observed.highlightedIndex,
        });
        await this.page.pointerClick({ x: observed.x, y: observed.y }, signal);
        this.#diagnostic("add_context_connector_pointer_fallback");
        await this.page.evaluate(PROVE_CONNECTOR_SELECTION, { composerKey, connectorName }, signal);
        this.#diagnostic("add_context_selection_proven");
        return;
      }
      await this.page.pointerClick({ x: first.x, y: first.y }, signal);
      this.#diagnostic("add_context_category_clicked", { kind: first.kind });
      await this.#settleUi(signal);
      {
        type IntegrationInspection = {
          readonly exactCount: number;
          readonly containedCount: number;
          readonly clickableCount: number;
          readonly clickableShapes: readonly string[];
          readonly genericControls: readonly string[];
          readonly dialogs: number;
          readonly listboxes: number;
          readonly menus: number;
          readonly searchInputs: number;
        };
        let matchedContext: "direct" | "apps" | "plugins" | undefined;
        let directInspection: IntegrationInspection | undefined;
        for (let attempt = 1; attempt <= 12; attempt += 1) {
          await this.#settleUi(signal);
          try {
            directInspection = await this.page.evaluate<
              { readonly connectorName: string },
              IntegrationInspection
            >(INSPECT_PLUGIN_CONTEXT, { connectorName }, signal);
          } catch {
            this.#diagnostic("add_context_direct_observation_failed", { attempt });
            continue;
          }
          if (directInspection.exactCount > 0
            || directInspection.containedCount > 0
            || directInspection.clickableCount > 0) break;
        }
        if (directInspection) {
          this.#diagnostic("add_context_direct_state", {
            exact_count: directInspection.exactCount,
            contained_count: directInspection.containedCount,
            clickable_count: directInspection.clickableCount,
            generic_controls: directInspection.genericControls.join("|"),
            dialogs: directInspection.dialogs,
            listboxes: directInspection.listboxes,
            menus: directInspection.menus,
            search_inputs: directInspection.searchInputs,
          });
          if (directInspection.exactCount > 0
            || directInspection.containedCount > 0
            || directInspection.clickableCount > 0) {
            matchedContext = "direct";
          }
        }

        if (!matchedContext) {
          let catalogOpened = false;
          for (const contextKind of ["apps", "plugins"] as const) {
            const contextTarget = await this.page.evaluate<
              { readonly kind: "apps" | "plugins" },
              { readonly x: number; readonly y: number } | null
            >(LOCATE_INTEGRATION_CONTEXT_TARGET, { kind: contextKind }, signal);
            if (!contextTarget) continue;
            await this.page.pointerClick(contextTarget, signal);
            this.#diagnostic("integration_catalog_opened", { kind: contextKind });
            await this.#settleUi(signal);
            catalogOpened = true;
            break;
          }
          if (!catalogOpened) {
            throw new Error("ChatGPT integration catalog entry point is unavailable");
          }

          for (const contextKind of ["apps", "plugins"] as const) {
            const integrationTabTarget = await this.page.evaluate<
              { readonly kind: "apps" | "plugins" },
              { readonly x: number; readonly y: number } | null
            >(LOCATE_INTEGRATION_TAB_TARGET, { kind: contextKind }, signal);
            if (integrationTabTarget) {
              await this.page.pointerClick(integrationTabTarget, signal);
              this.#diagnostic("integration_tab_clicked", { kind: contextKind });
              await this.#settleUi(signal);
            } else {
              this.#diagnostic("integration_tab_missing", { kind: contextKind });
            }
            let inspected: IntegrationInspection | undefined;
            let inspectionError: unknown;
            for (let attempt = 1; attempt <= 12; attempt += 1) {
              await this.#settleUi(signal);
              try {
                inspected = await this.page.evaluate<
                  { readonly connectorName: string },
                  IntegrationInspection
                >(INSPECT_PLUGIN_CONTEXT, { connectorName }, signal);
              } catch (error) {
                inspectionError = error;
                this.#diagnostic("integration_context_observation_failed", { kind: contextKind, attempt });
                continue;
              }
              if (inspected.exactCount > 0 || inspected.containedCount > 0 || inspected.clickableCount > 0) break;
            }
            if (!inspected) {
              throw new Error("ChatGPT integration context did not stabilize for structural observation", {
                cause: inspectionError,
              });
            }
            this.#diagnostic("integration_context_state", {
              kind: contextKind,
              exact_count: inspected.exactCount,
              contained_count: inspected.containedCount,
              clickable_count: inspected.clickableCount,
              generic_control_count: inspected.genericControls.length,
              generic_controls: inspected.genericControls.join("|"),
              dialogs: inspected.dialogs,
              listboxes: inspected.listboxes,
              menus: inspected.menus,
              search_inputs: inspected.searchInputs,
            });
            if (inspected.exactCount > 0 || inspected.containedCount > 0 || inspected.clickableCount > 0) {
              matchedContext = contextKind;
              break;
            }
          }
        }
        if (!matchedContext) {
          throw new ChatGptConnectorCatalogUnavailableError();
        }
        const excludedConnectorName = connectorName === "ChatGPT Tela"
          ? "ChatGPT Tela Development"
          : undefined;
        const connectorArguments = {
          connectorName,
          ...(excludedConnectorName ? { excludedConnectorName } : {}),
        };
        let connector: { readonly x: number; readonly y: number } | undefined;
        let locateError: unknown;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            connector = await this.page.evaluate<
              { readonly connectorName: string; readonly excludedConnectorName?: string },
              { readonly x: number; readonly y: number }
            >(LOCATE_EXACT_CONTEXT_CONNECTOR, connectorArguments, signal);
            break;
          } catch (error) {
            locateError = error;
            this.#diagnostic("connector_target_observation_failed", { attempt });
            if (attempt < 2) await this.#settleUi(signal);
          }
        }
        if (!connector) throw locateError instanceof Error ? locateError : new Error("ChatGPT connector target observation failed");
        this.#diagnostic("connector_target_found");
        await this.page.pointerClick(connector, signal);
        this.#diagnostic("connector_target_clicked");
      }
      await this.page.evaluate(PROVE_CONNECTOR_SELECTION, { composerKey, connectorName }, signal);
      this.#diagnostic("add_context_selection_proven");
      return;
    } catch (fallbackError) {
      this.#diagnostic("selection_failed");
      let cleanupError: unknown;
      let cleanupComplete = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await this.dismissTransientUi(signal);
          await this.#settleUi(signal);
          await this.page.evaluate(FOCUS_COMPOSER, { composerKey }, signal);
          await this.page.clearFocusedEditable(signal);
          cleanupComplete = true;
          this.#diagnostic("selection_cleanup_complete", { attempt });
          break;
        } catch (error) {
          cleanupError = error;
          this.#diagnostic("selection_cleanup_retry", { attempt });
        }
      }
      if (fallbackError instanceof ChatGptConnectorCatalogUnavailableError) {
        if (!cleanupComplete) this.#diagnostic("selection_cleanup_deferred_to_surface_reset");
        throw fallbackError;
      }
      if (!cleanupComplete) {
        this.#diagnostic("selection_cleanup_failed");
        throw new AggregateError(
          [fallbackError, cleanupError],
          "ChatGPT connector selection failed and its transient UI could not be cleaned",
        );
      }
      throw new AggregateError(
        [lastError, fallbackError].filter(error => error !== undefined),
        "ChatGPT connector selection failed through mention and add-context paths",
      );
    }
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
