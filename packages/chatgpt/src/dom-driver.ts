import { prepareApprovalWithinDeadline } from "./approval-preparation";
import { createHash } from "node:crypto";
import { setTimeout as waitForDelay } from "node:timers/promises";
import type { BrowserPageAutomation } from "@chatgpt-tela/browser-host";
import { configuredDiagnosticRoot, privateDiagnosticCaptureEnabled, diagnosticFingerprint, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { decideChatGptApproval, type ChatGptApprovalAutomationMode } from "./approval-policy";
import { assistantMarkdown } from "./answer-markdown";
import { assistantBody } from "./answer-body";
import { userPayload } from "./user-payload";
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
  readonly attachmentNames: readonly string[];
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
  readonly lineageAnchor?: string;
  readonly contentText?: string;
  readonly candidateTexts?: readonly string[];
  readonly userPayloadReason?: string;
  /** Content-free adapter witness, count saturated at 65; never acceptance authority. */
  readonly userPayloadStructure?: { readonly rootCount: number; readonly nestedRoots?: boolean; readonly equivalentRoots?: boolean; readonly outerLength?: number; readonly innerLength?: number };
  readonly bodyProof?: { readonly version: 1; readonly value?: string; readonly reason?: string };
  readonly plainBodyText?: string;
  readonly phase?: ChatGptAssistantPhase;
  readonly text?: string;
  readonly failureDetail?: string;
  readonly publicProgress?: readonly string[];
  readonly progressProbe?: { readonly linkedRegionCount?: number; readonly visibleLinkedRegionCount?: number; readonly shellSearchDepth?: number; readonly shellCandidateCount?: number; readonly containerPresent: boolean; readonly anchorCount: number; readonly titleCount: number; readonly descriptionCount: number; readonly containerVisible: boolean; readonly markerCount: number; readonly agentShellEligible: boolean; readonly visibleAnchorCount: number; readonly controlCount: number; readonly visibleControlCount: number; readonly localLabelCount: number; readonly visibleLabelCount: number; readonly containerDisplay: "none" | "contents" | "other"; readonly containerVisibilityHidden: boolean; readonly containerOpacityZero: boolean; readonly containerHasRects: boolean; readonly ownedControlCount: number; readonly ownedVisibleControlCount: number; readonly ownedLocalLabelCount: number; readonly ownedVisibleLabelCount: number };
}

interface RawSnapshot {
  readonly url: string;
  readonly composers: readonly RawComposer[];
  readonly sendControls: readonly RawSend[];
  readonly turns: readonly RawTurn[];
}

const INSPECT_APPROVAL_CARD = String.raw`async function inspectApproval(prepare) {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const registryKey = Symbol.for("chatgpt-tela.approval-observations.v1");
  const registry = globalThis[registryKey] ||= { cards: new WeakMap(), prefix: crypto.randomUUID(), next: 0, receipt: null };
  const cards = [...document.querySelectorAll('[data-testid="tool-approval-card"], [data-codex-approval-surface="true"]')].filter(visible);
  const result = {
    cardCount: cards.length,
    denyCount: 0,
    allowCount: 0,
    allowOnceCount: 0,
    allowConversationCount: 0,
    alwaysAllowCount: 0,
    unknownCount: 0,
    requiresManualReview: false,
    reviewReason: null,
    allowPoint: null,
    allowOncePoint: null,
    allowConversationPoint: null,
    optionsDisclosureCount: 0,
    optionsExpanded: false,
    optionsPoint: null,
    optionsAnchorStable: null,
    optionsAttempted: false,
    cardKey: null,
    proofKey: null,
    targetState: "unprepared",
    inputReceived: false,
    receipt: registry.receipt || null,
  };
  // This provider-owned classifier identifies human consent/navigation input,
  // not authority to approve. Recheck the exact card on every gesture. Approval
  // options may render in a portal outside the card: only an accessible, uniquely
  // linked, currently expanded menu can preserve the accepted input witness.
  registry.manualInputTarget = node => {
    const current = [...document.querySelectorAll('[data-testid="tool-approval-card"], [data-codex-approval-surface="true"]')].filter(visible);
    if (current.length !== 1) return false;
    const card = current[0], observed = registry.cards.get(card);
    const control = node?.closest?.('[role="menuitem"]') || node?.closest?.('button,[role="button"]');
    if (!observed || observed.text !== card.textContent || !control || !visible(control)
      || control.disabled || control.getAttribute('aria-disabled') === 'true'
      || control.closest('[inert]')) return false;
    const decision = normalize(control.getAttribute('aria-label') || control.textContent);
    const allowed = ['Deny', 'Allow', 'Allow once', 'Always allow',
      'Allow for this conversation', 'Allow ChatGPT Tela for this conversation'];
    if (card.contains(control)) {
      return allowed.includes(decision)
        || (decision === 'Approval options' && control.getAttribute('aria-haspopup') === 'menu');
    }
    // The provider may render a consent choice as a native button instead
    // of role=menuitem. Its role is not proof of authority: require the same
    // uniquely linked, expanded, card-owned menu and exact choice label.
    if (!allowed.includes(decision)
      || (control.getAttribute('role') !== 'menuitem'
        && control.tagName !== 'BUTTON' && control.getAttribute('role') !== 'button')) return false;
    const menu = control.closest('[role="menu"]');
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(visible);
    if (!menu || menus.length !== 1 || menus[0] !== menu || !menu.contains(control)) return false;
    const disclosures = [...card.querySelectorAll('button,[role="button"]')].filter(button =>
      visible(button) && button.getAttribute('aria-haspopup') === 'menu'
      && normalize(button.getAttribute('aria-label') || button.textContent) === 'Approval options'
      && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
      && !button.closest('[inert]'));
    if (disclosures.length !== 1 || disclosures[0].getAttribute('aria-expanded') !== 'true') return false;
    const disclosure = disclosures[0];
    const menuId = menu.getAttribute('id'), disclosureId = disclosure.getAttribute('id');
    return !!(menuId && disclosure.getAttribute('aria-controls') === menuId
      || disclosureId && menu.getAttribute('aria-labelledby') === disclosureId);
  };
  if (cards.length !== 1) return result;
  // Warnings belong to human review whether rendered inside the card or
  // inside its authenticated portal. Never reduce warning scope by opening
  // a menu. Card/menu text stays inside the renderer; only fixed reasons leave.
  const classifyWarning = container => {
    const displayedText = container.innerText || container.textContent || '';
    const suspicious = /(?:Suspicious (?:Instruction|Activity|content)|의심스러운 지침|의심스러운 명령|의심스러운 콘텐츠)/i.test(displayedText);
    const hasAlert = [...container.querySelectorAll('[role="alert"], [data-warning], [data-safety-warning]')].some(visible);
    if (!suspicious && !hasAlert) return;
    result.requiresManualReview = true;
    result.reviewReason ||= /(?:tool description|도구 설명)/i.test(displayedText)
      && /(?:classifier|approval outcome|risk label|분류기|승인 결과|위험 등급)/i.test(displayedText)
      ? 'tool_description_policy_directive'
      : suspicious ? 'suspicious_instruction' : 'provider_warning';
  };
  classifyWarning(cards[0]);
  const point = element => {
    const bounds = element.getBoundingClientRect();
    if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)
      || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
      || bounds.width <= 0 || bounds.height <= 0) return null;
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  };
  let allowOnceButton = null;
  let allowConversationButton = null;
  // Use the control's accessible label, not visual shortcut decorations. A keyboard hint
  // is presentation, whereas an unknown decision remains an unknown decision.
  const accessibleText = node => {
    if (node instanceof HTMLElement && node.getAttribute("aria-hidden") === "true") return "";
    if (!node.childNodes?.length) return node.textContent || node.innerText || "";
    return [...node.childNodes].map(accessibleText).join("");
  };
  let optionsDisclosure = null;
  for (const button of cards[0].querySelectorAll('button,[role="button"]')) {
    if (!visible(button)) continue;
    const label = normalize(button.getAttribute("aria-label") || accessibleText(button));
    // These explicitly identified disclosure controls do not grant or deny authority.
    if (label === "See details" && button.getAttribute("aria-haspopup") === "dialog") continue;
    if (label === "Approval options" && button.getAttribute("aria-haspopup") === "menu") {
      result.optionsDisclosureCount += 1;
      if (result.optionsDisclosureCount === 1) {
        optionsDisclosure = button;
        result.optionsExpanded = button.getAttribute("aria-expanded") === "true";
        if (button.getAttribute("aria-expanded") === "false"
          && button.getAttribute("aria-controls") && !button.disabled
          && button.getAttribute("aria-disabled") !== "true" && !button.closest('[inert]')) {
          result.optionsPoint = point(button);
        }
      }
      continue;
    }
    if (label === "Deny") result.denyCount += 1;
    else if (label === "Allow once") {
      result.allowOnceCount += 1;
      if (result.allowOnceCount === 1) {
        allowOnceButton = button;
        if (!button.disabled && button.getAttribute("aria-disabled") !== "true") {
          result.allowOncePoint = point(button);
        }
      }
    } else if (label === "Allow") {
      result.allowCount += 1;
      if (result.allowCount === 1) result.allowPoint = point(button);
    } else if (label === "Allow for this conversation"
      || label === "Allow ChatGPT Tela for this conversation") {
      result.allowConversationCount += 1;
      if (result.allowConversationCount === 1) {
        allowConversationButton = button;
        if (!button.disabled && button.getAttribute("aria-disabled") !== "true") {
          result.allowConversationPoint = point(button);
        }
      }
    } else if (label === "Always allow") result.alwaysAllowCount += 1;
    else result.unknownCount += 1;
  }
  // Only a uniquely expanded, structurally linked menu belongs to the current
  // approval card. Global/foreign menus cannot become approval choices.
  if (result.optionsDisclosureCount === 1 && result.optionsExpanded) {
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(visible);
    if (menus.length === 1) {
      const menu = menus[0], menuId = menu.getAttribute("id");
      const disclosureId = optionsDisclosure.getAttribute("id");
      if ((menuId && optionsDisclosure.getAttribute("aria-controls") === menuId)
        || (disclosureId && menu.getAttribute("aria-labelledby") === disclosureId)) {
        classifyWarning(menu);
        // Some provider surfaces use buttons in a popover without menuitem
        // roles. Do not combine both variants: a mixed surface is ambiguous.
        const menuItems = [...menu.querySelectorAll('[role="menuitem"]')];
        const menuButtons = [...menu.querySelectorAll('button')];
        const choices = menuItems.length ? (menuButtons.length ? [] : menuItems) : menuButtons;
        if (menuItems.length && menuButtons.length) result.unknownCount += 1;
        for (const item of choices) {
          if (!visible(item)) continue;
          const label = normalize(item.getAttribute("aria-label") || accessibleText(item));
          if (!registry.manualInputTarget(item)) {
            result.unknownCount += 1;
          } else if (label === "Allow for this conversation"
            || label === "Allow ChatGPT Tela for this conversation") {
            result.allowConversationCount += 1;
            if (result.allowConversationCount === 1) {
              allowConversationButton = item;
              result.allowConversationPoint = point(item);
            }
          } else if (label === "Always allow") {
            result.alwaysAllowCount += 1;
          } else if (label === "Allow once" || label === "Deny") {
            // A menu may repeat known narrower choices already on the card.
          } else {
            // A second/unknown decision is not an implicit grant.
            result.unknownCount += 1;
          }
        }
      }
    }
  }
  // Raw card text and element references remain in the renderer. Only a disposable identity
  // crosses the boundary, so a delay cannot silently approve a replaced or changed request.
  const text = cards[0].textContent;
  let prior = registry.cards.get(cards[0]);
  if (!prior || prior.text !== text || prior.button !== allowOnceButton
    || prior.conversationButton !== allowConversationButton) {
    const key = registry.prefix + ":" + (++registry.next);
    if (prior) Object.assign(prior, { text, button: allowOnceButton,
      conversationButton: allowConversationButton, proofKey: key });
    else prior = { text, button: allowOnceButton, conversationButton: allowConversationButton,
      cardKey: key, proofKey: key, inputReceived: false };
    registry.cards.set(cards[0], prior);
  }
  result.cardKey = prior.cardKey;
  result.proofKey = prior.proofKey;
  result.inputReceived = prior.inputReceived === true;
  result.optionsAttempted = prior.menuOpenAttempted === true;
  result.optionsAnchorStable = prior.menuOpenAnchorText === undefined
    ? null : prior.menuOpenAnchorText === text;
  if (prepare) {
    result.allowOncePoint = null;
    result.allowConversationPoint = null;
    result.optionsPoint = null;
    result.targetState = "changed";
    // Only a proven exact permission choice may prepare its target. Ordinary
    // inspection never scrolls or consumes an activation attempt.
    const conversation = prepare.choice === 'allow_conversation';
    const openingOptions = prepare.choice === 'open_options';
    const selected = openingOptions ? optionsDisclosure : conversation ? allowConversationButton : allowOnceButton;
    if (prepare.cardKey !== prior.cardKey || prepare.proofKey !== prior.proofKey
      || (prior.menuOpenAttempted && prior.menuOpenAnchorText !== text)
      || result.denyCount !== 1 || result.allowCount !== 0
      || (openingOptions ? result.optionsDisclosureCount !== 1 || result.optionsExpanded
          || result.allowOnceCount !== 1 || result.allowConversationCount !== 0
          || result.alwaysAllowCount !== 0 || !selected?.getAttribute("aria-controls")
        : conversation ? result.allowConversationCount !== 1 || result.alwaysAllowCount !== 0
        : result.allowOnceCount !== 1)
      || result.requiresManualReview || result.unknownCount !== 0 || !selected || selected.disabled
      || selected.getAttribute("aria-disabled") === "true") return result;
    selected.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    // Instant scroll plus synchronous geometry/hit testing flushes current layout.
    // Frame callbacks may stop in hidden windows and must never gate approval.
    // This preparation performs no input; dispatch remains on the host boundary.
    const after = await inspectApproval();
    if (after.cardKey !== prepare.cardKey || after.proofKey !== prepare.proofKey
      || after.cardCount !== 1 || after.denyCount !== 1 || after.allowCount !== 0
      || (openingOptions ? after.optionsDisclosureCount !== 1 || after.optionsExpanded
          || after.allowOnceCount !== 1 || after.allowConversationCount !== 0
          || after.alwaysAllowCount !== 0
        : conversation ? after.allowConversationCount !== 1 || after.alwaysAllowCount !== 0
        : after.allowOnceCount !== 1)
      || after.requiresManualReview || after.unknownCount !== 0
      || !selected.isConnected || selected.disabled
      || selected.getAttribute("aria-disabled") === "true") return result;
    const target = point(selected);
    result.targetState = "outside_viewport";
    if (!target || target.x < 0 || target.y < 0
      || Math.round(target.x) >= innerWidth || Math.round(target.y) >= innerHeight) return result;
    const hit = document.elementFromPoint(Math.round(target.x), Math.round(target.y));
    result.targetState = "occluded";
    if (hit !== selected && !selected.contains(hit)) {
      // Content-free witness at the failed hit-test boundary, never authority to click.
      // DOM labels, selectors, coordinates and element references stay in the renderer.
      result.obstruction = {
        kind: !hit ? "none" : hit === document.documentElement || hit === document.body ? "document"
          : hit.closest('dialog,[role="dialog"],[aria-modal="true"]') ? "dialog"
          : hit.closest('button,a,input,select,textarea,[role="button"]') ? "control" : "other",
        inCard: !!hit && cards[0].contains(hit),
        pointerEventsNone: getComputedStyle(selected).pointerEvents === "none",
        inert: !!selected.closest('[inert]'),
        documentHidden: document.visibilityState === "hidden",
      };
      return result;
    }
    // Passive, card-local receipt of actual browser input. No click, authority or polling here.
    if (!openingOptions && prior.receiptButton !== selected && typeof selected.addEventListener === "function") {
      prior.receiptButton = selected;
      const preparedProofKey = prior.proofKey;
      const preparedCardKey = prior.cardKey;
      const receive = event => {
        if (!event.isTrusted) return;
        prior.inputReceived = true;
        // One disposable receipt survives immediate removal. No element or card text is retained.
        registry.receipt = { cardKey: preparedCardKey, proofKey: preparedProofKey };
        selected.removeEventListener("click", receive, true);
      };
      selected.addEventListener("click", receive, { capture: true });
    }
    result.targetState = "ready";
    if (openingOptions) {
      prior.menuOpenAnchorText = text;
      prior.menuOpenAttempted = true;
      result.optionsPoint = target;
    }
    else if (conversation) result.allowConversationPoint = target;
    else result.allowOncePoint = target;
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
const CHATGPT_MEMORY_UPLOAD_TARGET_SELECTOR = 'input[data-chatgpt-tela-memory-upload="context"]';

const LOCATE_ADD_CONTEXT_CONTROL = String.raw`function () {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const buttons = [...document.querySelectorAll('button[data-composer-navigation-target="add-context"]')].filter(visible);
  if (buttons.length !== 1) throw new Error("ChatGPT add-context control is not unique");
  const rect = buttons[0].getBoundingClientRect();
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw new Error("ChatGPT add-context control has no trusted pointer target");
  }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}`;

const FOCUS_ADD_CONTEXT_CONTROL = String.raw`function () {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const buttons = [...document.querySelectorAll('button[data-composer-navigation-target="add-context"]')].filter(visible);
  if (buttons.length !== 1) throw new Error("ChatGPT add-context control is not unique");
  buttons[0].focus({ preventScroll: true });
  if (document.activeElement !== buttons[0]) throw new Error("ChatGPT add-context control did not become keyboard owner");
  return true;
}`;

const ACTIVATE_ADD_CONTEXT_CONTROL = String.raw`function () {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const buttons = [...document.querySelectorAll('button[data-composer-navigation-target="add-context"]')].filter(visible);
  if (buttons.length !== 1) throw new Error("ChatGPT add-context control is not unique");
  buttons[0].click();
  return true;
}`;

const OBSERVE_ACTIVE_ADD_CONTEXT_UPLOAD_ACTION = String.raw`function () {
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const normalized = element => ((element.innerText || element.textContent || "").split("\n")[0] || "")
    .replace(/\s+/g, " ").trim();
  const rows = [...document.querySelectorAll(
    'button[data-list-navigation-item="true"], [role="menuitem"], [role="option"]',
  )].filter(visible);
  const uploadText = value => /^(?:Upload files?|Upload from computer|Add files?|Attach files?|Add photos?\s*(?:&|and)\s*files?|Upload photos?\s*(?:&|and)\s*files?|파일 업로드|컴퓨터에서 업로드|파일 추가|파일 첨부|사진\s*(?:및|과)\s*파일\s*(?:추가|업로드))$/i.test(value);
  const genericPattern = /(upload|files?|attach|파일|첨부)/i;
  const genericAttributeShapes = rows.flatMap((row, index) => {
    const values = [
      ["aria-label", row.getAttribute("aria-label")],
      ["title", row.getAttribute("title")],
      ["data-testid", row.getAttribute("data-testid")],
      ["data-value", row.getAttribute("data-value")],
      ["data-action", row.getAttribute("data-action")],
    ].filter(([, value]) => typeof value === "string" && genericPattern.test(value));
    return values.map(([name, value]) => [index, name, value].join(":"));
  });
  const semantic = rows.filter(row => {
    if (uploadText(normalized(row))) return true;
    return ["aria-label", "title", "data-testid", "data-value", "data-action"]
      .some(name => genericPattern.test(row.getAttribute(name) || ""));
  });
  const highlighted = rows.filter(row => row.getAttribute("data-highlighted") !== null
    || row.getAttribute("aria-current") === "true"
    || row.getAttribute("aria-selected") === "true");
  const target = semantic.length === 1 ? semantic[0] : semantic.length === 0 && highlighted.length === 1 ? highlighted[0] : undefined;
  const targetKind = semantic.length === 1 ? "semantic" : target ? "highlighted" : "none";
  if (!target) return {
    rowCount: rows.length,
    semanticCount: semantic.length,
    highlightedCount: highlighted.length,
    targetKind,
    genericAttributeShapes,
  };
  const rect = target.getBoundingClientRect();
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    return {
      rowCount: rows.length,
      semanticCount: semantic.length,
      highlightedCount: highlighted.length,
      targetKind,
      genericAttributeShapes,
    };
  }
  return {
    rowCount: rows.length,
    semanticCount: semantic.length,
    highlightedCount: highlighted.length,
    targetKind,
    targetIndex: rows.indexOf(target),
    genericAttributeShapes,
    point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
  };
}`;

const PREPARE_CONTEXT_UPLOAD_INPUT = String.raw`function () {
  const composerSelector = ${COMPOSER_SELECTOR_SOURCE};
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const composers = [...document.querySelectorAll(composerSelector)].filter(visible);
  if (composers.length !== 1) {
    return { ready: false, reason: "composer_ambiguous", composerCount: composers.length, fileInputCount: 0, addContextCount: 0 };
  }
  const composer = composers[0];
  const form = composer.closest('form[data-chatgpt-composer], form');
  if (!(form instanceof HTMLFormElement)) {
    return { ready: false, reason: "form_missing", composerCount: 1, fileInputCount: 0, addContextCount: 0 };
  }
  document.querySelectorAll('[data-chatgpt-tela-memory-upload="context"]').forEach(element => {
    element.removeAttribute('data-chatgpt-tela-memory-upload');
  });
  const inputs = [...document.querySelectorAll('input[type="file"]')]
    .filter(element => element instanceof HTMLInputElement);
  const inForm = inputs.filter(input => input.closest('form[data-chatgpt-composer], form') === form);
  const noAccept = input => !input.hasAttribute('accept') || !(input.getAttribute('accept') || '').trim();
  const imageOnly = input => {
    const raw = (input.getAttribute('accept') || '').toLowerCase().trim();
    if (!raw) return false;
    const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
    return parts.length > 0 && parts.every(part => part.startsWith('image/')
      || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.avif'].includes(part));
  };
  const chooseOne = (values, kind) => values.length === 1 ? { input: values[0], kind } : undefined;
  const candidates = [
    chooseOne(inForm.filter(input => input.multiple && noAccept(input)), 'composer-generic'),
    chooseOne(inputs.filter(input => input.multiple && noAccept(input)), 'global-generic'),
    chooseOne(inForm.filter(input => !imageOnly(input)), 'composer-general'),
    chooseOne(inputs.filter(input => !imageOnly(input)), 'global-general'),
  ].filter(Boolean);
  const unique = candidates.find(candidate => candidate);
  const addContextCount = [...form.querySelectorAll('button[data-composer-navigation-target="add-context"]')].filter(visible).length;
  const summary = {
    composerCount: 1,
    fileInputCount: inputs.length,
    formFileInputCount: inForm.length,
    genericInputCount: inputs.filter(input => input.multiple && noAccept(input)).length,
    imageOnlyInputCount: inputs.filter(imageOnly).length,
    addContextCount,
    inputSummaries: inputs.slice(0, 8).map((input, index) => ({
      index,
      inForm: input.closest('form[data-chatgpt-composer], form') === form,
      multiple: input.multiple,
      disabled: input.disabled,
      acceptKind: noAccept(input) ? 'none' : imageOnly(input) ? 'image-only' : 'general',
      testIdKind: input.getAttribute('data-testid') === 'upload-photos-input' ? 'upload-photos' : input.hasAttribute('data-testid') ? 'other' : 'none',
      selected: Boolean(unique && unique.input === input),
    })),
  };
  if (!unique) return { ready: false, reason: "generic_input_missing", ...summary };
  // Refuse a lower-priority candidate when the same semantic tier is ambiguous. The priority list
  // above may contain the same exact input at multiple tiers, so deduplicate by identity first.
  const sameTier = candidates.filter(candidate => candidate.kind === unique.kind);
  if (sameTier.length !== 1) return { ready: false, reason: "generic_input_ambiguous", ...summary };
  unique.input.setAttribute('data-chatgpt-tela-memory-upload', 'context');
  return { ready: true, reason: "ready", targetKind: unique.kind, ...summary };
}`;

const CLEAR_CONTEXT_UPLOAD_INPUT_MARKER = String.raw`function () {
  document.querySelectorAll('[data-chatgpt-tela-memory-upload="context"]').forEach(element => {
    element.removeAttribute('data-chatgpt-tela-memory-upload');
  });
}`;

const OBSERVE_EXPECTED_ATTACHMENT_IDENTITY = String.raw`function (argument) {
  const composerSelector = ${COMPOSER_SELECTOR_SOURCE};
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const composers = [...document.querySelectorAll(composerSelector)].filter(visible);
  if (composers.length !== 1) {
    return { composerCount: composers.length, matchedCount: 0, fileInputMatchCount: 0, visibleOutsideComposerMatchCount: 0, attachmentRootCount: 0, outsideGroupCount: 0, progressCount: 0 };
  }
  const composer = composers[0];
  const form = composer.closest('form[data-chatgpt-composer], form');
  if (!(form instanceof HTMLElement)) {
    return { composerCount: 1, matchedCount: 0, fileInputMatchCount: 0, visibleOutsideComposerMatchCount: 0, attachmentRootCount: 0, outsideGroupCount: 0, progressCount: 0 };
  }
  const expected = Array.isArray(argument.names) ? argument.names.filter(name => typeof name === "string" && name.length > 0) : [];
  const matched = new Set();
  let fileInputMatchCount = 0;
  for (const input of form.querySelectorAll('input[type="file"]')) {
    if (!(input instanceof HTMLInputElement) || !input.files) continue;
    for (const file of input.files) {
      if (expected.includes(file.name)) {
        matched.add(file.name);
        fileInputMatchCount += 1;
      }
    }
  }
  let visibleOutsideComposerMatchCount = 0;
  const outside = element => element instanceof HTMLElement
    && visible(element)
    && element !== composer
    && !composer.contains(element)
    && !element.contains(composer);
  const attachmentRootCount = [...form.querySelectorAll('[data-composer-attachments], .composer-attachment-surface')]
    .filter(outside).length;
  const outsideGroupCount = [...form.querySelectorAll('[role="group"]')].filter(outside).length;
  const progressCount = [...form.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].filter(outside).length;
  const attributes = ["aria-label", "title", "data-file-name", "data-filename", "data-name"];
  for (const element of form.querySelectorAll('*')) {
    if (!outside(element)) continue;
    const values = [element.textContent || "", ...attributes.map(name => element.getAttribute(name) || "")];
    for (const name of expected) {
      if (!values.some(value => value.includes(name))) continue;
      matched.add(name);
      visibleOutsideComposerMatchCount += 1;
    }
  }
  return {
    composerCount: 1,
    matchedCount: matched.size,
    fileInputMatchCount,
    visibleOutsideComposerMatchCount,
    attachmentRootCount,
    outsideGroupCount,
    progressCount,
  };
}`;

const OBSERVE_CHATGPT_SURFACE = String.raw`function () {
  const answerMarkdown = ${assistantMarkdown.toString()};
  const answerBodyProof = ${assistantBody.toString()};
  const requestPayload = ${userPayload.toString()};
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
  const attachmentNames = element => {
    if (!(element instanceof HTMLElement)) return [];
    const form = element.closest("form[data-chatgpt-composer], form");
    if (!(form instanceof HTMLElement)) return [];
    const result = new Set();
    const add = value => {
      const normalized = String(value || "").replace(/\s+/g, " ").trim();
      if (normalized && normalized.length <= 240 && !/[\r\n]/.test(normalized)) result.add(normalized);
    };
    for (const candidate of form.querySelectorAll('[data-composer-attachments] [role="group"], .composer-attachment-surface')) {
      if (!(candidate instanceof HTMLElement) || !visible(candidate)) continue;
      add(candidate.getAttribute("aria-label"));
      const labelledBy = candidate.getAttribute("aria-labelledby");
      if (labelledBy) add(document.getElementById(labelledBy)?.textContent);
    }
    for (const root of form.querySelectorAll('[data-composer-attachments]')) {
      if (!(root instanceof HTMLElement) || !visible(root)) continue;
      for (const candidate of root.querySelectorAll('[aria-label], span, p')) {
        if (!(candidate instanceof HTMLElement) || !visible(candidate)) continue;
        add(candidate.getAttribute("aria-label"));
        add(candidate.textContent);
      }
    }
    return [...result];
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
    attachmentNames: attachmentNames(element),
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
  const groups = [...document.querySelectorAll("[data-turn-key]")];
  // Optimistic renderer keys can disappear during hydration while the public logical
  // turn anchor remains. Bind only an exact, unique anchor inside its keyed group and
  // the current document. Duplicate/nested groups expose no such identity capability.
  const documentKey = document.documentElement?.getAttribute('data-page-load-id');
  const logicalAnchors = new Map();
  const anchorCounts = new Map();
  if (documentKey && documentKey.length <= 256) for (const group of groups) {
    if (!(group instanceof HTMLElement) || group.querySelectorAll('[data-turn-key]').length) continue;
    const nodes = [...group.querySelectorAll('[data-content-search-turn-key]')];
    if (nodes.length !== 1) continue;
    const key = nodes[0].getAttribute('data-content-search-turn-key');
    if (!key || key.length > 256) continue;
    const anchor = JSON.stringify([documentKey, key]);
    logicalAnchors.set(group, anchor);
    anchorCounts.set(anchor, (anchorCounts.get(anchor) || 0) + 1);
  }
  for (const group of groups) {
    if (!(group instanceof HTMLElement)) continue;
    const rawKey = group.getAttribute("data-turn-key");
    if (!rawKey) continue;
    const candidateAnchor = logicalAnchors.get(group);
    const lineageAnchor = candidateAnchor && anchorCounts.get(candidateAnchor) === 1 ? candidateAnchor : undefined;
    const user = group.querySelector("[data-user-message-bubble]");
    if (user) {
      const payload = requestPayload(user);
      turns.push({
        key: "user:" + rawKey,
        role: "user",
        ...(lineageAnchor ? { lineageAnchor } : {}),
        ...(payload.value !== undefined ? { contentText: payload.value } : {}),
        ...(payload.candidates ? { candidateTexts: payload.candidates } : {}),
        userPayloadReason: payload.reason,
        userPayloadStructure: { rootCount: payload.rootCount, ...(payload.nestedRoots !== undefined ? { nestedRoots: payload.nestedRoots } : {}), ...(payload.equivalentRoots !== undefined ? { equivalentRoots: payload.equivalentRoots } : {}), ...(payload.outerLength !== undefined ? { outerLength: payload.outerLength, innerLength: payload.innerLength } : {}) },
      });
    }
    // The current renderer identifies assistant bodies directly, without the role wrapper.
    // Keep the proof inside the keyed turn; generic markdown or user content is not an answer.
    const answerBody = group.querySelector('[data-markdown-text-style="assistant-message"]')
      || group.querySelector('[data-message-author-role="assistant"] .markdown');
    // Observed agent-status shell: one start marker in a dedicated sibling branch,
    // outside both user and answer bodies. Never treat an arbitrary disclosure as progress.
    const agentStarts = [...group.querySelectorAll('[data-chatgpt-agent-turn-start]')];
    const agentShell = agentStarts.length === 1 ? agentStarts[0].parentElement : undefined;
    let ownedAgentShell = agentShell && group.contains(agentShell)
      && !agentShell.querySelector('[data-user-message-bubble], [data-markdown-text-style="assistant-message"], [data-turn-key]')
      ? agentShell : undefined;
    // A start marker can be a sibling of the public disclosure rather than its
    // child. Search only bounded sibling branches of that exact owned marker;
    // never promote the whole keyed turn (which also contains user/final text).
    let shellSearchDepth = 0, shellCandidateCount = 0;
    if ((!ownedAgentShell || ownedAgentShell.querySelectorAll('button[aria-expanded][aria-labelledby]').length === 0) && agentStarts.length === 1) {
      let parent = agentShell;
      for (; parent && group.contains(parent) && shellSearchDepth < 4; parent = parent.parentElement) {
        shellSearchDepth++;
        if (parent.children.length > 64) { shellCandidateCount = 65; break; }
        const candidates = [...parent.children].slice(0, 64).filter(branch =>
          branch instanceof HTMLElement
          && !branch.querySelector('[data-user-message-bubble], [data-markdown-text-style="assistant-message"], [data-turn-key]')
          && branch.getAttribute('data-user-message-bubble') === null
          && branch.getAttribute('data-markdown-text-style') !== 'assistant-message'
          && branch.getAttribute('data-turn-key') === null
          && branch.querySelectorAll('button[aria-expanded][aria-labelledby]').length === 1);
        shellCandidateCount = candidates.length;
        if (candidates.length === 1) { ownedAgentShell = candidates[0]; break; }
        if (candidates.length > 1 || parent === group) break;
      }
    }
    const progressRoot = group.querySelector('[data-streaming-response-status]') || ownedAgentShell;
    const progressAnchors = progressRoot ? (progressRoot === ownedAgentShell
      ? [progressRoot] : [...progressRoot.querySelectorAll('[data-item-anchor]')]) : [];
    // A display:contents wrapper has no box even when its owned children render.
    // Visibility belongs to rendered content; hidden ancestors still exclude that subtree.
    const progressStyles = new WeakMap();
    const progressAllowedCache = new WeakMap();
    const progressVisibleCache = new WeakMap();
    const progressNodeStyle = node => {
      if (!progressStyles.has(node)) progressStyles.set(node, getComputedStyle(node));
      return progressStyles.get(node);
    };
    const progressAllowed = node => {
      if (!(node instanceof HTMLElement)) return true;
      if (progressAllowedCache.has(node)) return progressAllowedCache.get(node);
      const style = progressNodeStyle(node);
      const allowed = node.getAttribute('hidden') === null && node.getAttribute('aria-hidden') !== 'true'
        && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
        && style.opacity !== '0' && progressAllowed(node.parentElement);
      progressAllowedCache.set(node, allowed);
      return allowed;
    };
    const progressVisible = node => {
      if (!(node instanceof HTMLElement)) return false;
      if (progressVisibleCache.has(node)) return progressVisibleCache.get(node);
      const shown = progressAllowed(node) && (node.getClientRects().length > 0
        || progressNodeStyle(node).display === 'contents' && [...node.children].some(progressVisible));
      progressVisibleCache.set(node, shown);
      return shown;
    };
    // Structural evidence must survive the outer visibility rejection. Do not read prose
    // here or change extraction eligibility: boxless layout and hidden UI need distinct proof.
    const progressStyle = progressRoot instanceof HTMLElement ? getComputedStyle(progressRoot) : undefined;
    const ownedControls = ownedAgentShell ? [...ownedAgentShell.querySelectorAll('button[aria-expanded][aria-labelledby]')] : [];
    const ownedVisibleControls = ownedControls.filter(progressVisible);
    const ownedLabels = ownedControls.length === 1 ? [...ownedAgentShell.querySelectorAll('[id]')]
      .filter(node => node.getAttribute('id') === ownedControls[0].getAttribute('aria-labelledby')) : [];
    let linkedRegionCount = 0, visibleLinkedRegionCount = 0;
    let progressTitleCount = 0;
    let progressDescriptionCount = 0;
    let visibleAnchorCount = 0, controlCount = 0, visibleControlCount = 0, localLabelCount = 0, visibleLabelCount = 0;
    const visibleDescription = (node, title) => {
      if (node === title) return "";
      if (node.nodeType === 3) return node.textContent || "";
      if (!(node instanceof HTMLElement) || !progressVisible(node)
        || node.getAttribute('aria-hidden') === 'true' || node.getAttribute('hidden') !== null
        || ['BUTTON', 'SVG', 'SCRIPT', 'STYLE'].includes(node.tagName)) return "";
      return [...node.childNodes].map(child => visibleDescription(child, title)).join(" ");
    };
    const publicProgress = progressRoot ? progressAnchors
      .filter(progressVisible).map(row => {
        visibleAnchorCount += 1;
        let title, disclosure;
        if (row === ownedAgentShell) {
          const candidates = [...row.querySelectorAll('button[aria-expanded][aria-labelledby]')];
          controlCount += candidates.length;
          const controls = candidates.filter(progressVisible);
          visibleControlCount += controls.length;
          if (controls.length !== 1) return "";
          disclosure = controls[0];
          const labelId = controls[0].getAttribute('aria-labelledby');
          const labels = [...row.querySelectorAll('[id]')].filter(node => node.getAttribute('id') === labelId);
          localLabelCount += labels.length;
          visibleLabelCount += labels.filter(progressVisible).length;
          if (labels.length !== 1) return "";
          title = labels[0];
        } else {
          title = row.querySelector('button[aria-expanded], [data-markdown-text-tone="tertiary"]');
          disclosure = row.querySelector('button[aria-expanded]');
        }
        if (!title || !progressVisible(title)) return "";
        progressTitleCount += 1;
        const copy = title.cloneNode(true);
        copy.querySelectorAll('button, svg, [aria-hidden="true"]').forEach(control => control.remove());
        const titleText = text(copy).replace(/\s+/g, " ").trim();
        // Public disclosures may place their visible description outside the status
        // row. Follow only a unique explicit local relationship inside this owned
        // keyed turn; never scan the page or promote an answer/user body to progress.
        const regionId = disclosure?.getAttribute('aria-controls');
        const linked = regionId ? [...group.querySelectorAll('[id]')].filter(node => node.getAttribute('id') === regionId) : [];
        linkedRegionCount += Math.min(linked.length, 65);
        const region = linked.length === 1 && linked[0] !== answerBody
          && !linked[0].querySelector('[data-user-message-bubble], [data-markdown-text-style="assistant-message"], [data-turn-key]')
          && linked[0].getAttribute('data-user-message-bubble') === null
          && linked[0].getAttribute('data-markdown-text-style') !== 'assistant-message'
          && linked[0].getAttribute('data-turn-key') === null
          && progressVisible(linked[0]) ? linked[0] : undefined;
        if (region) visibleLinkedRegionCount++;
        const description = [visibleDescription(row, title), region && !row.contains(region) ? visibleDescription(region, title) : '']
          .filter(Boolean).join(' ').replace(/\s+/g, " ").trim();
        if (description) progressDescriptionCount += 1;
        return [titleText, description].filter(Boolean).join("\n\n").slice(0, 4096);
      }).filter(value => value.length > 0 && value.length <= 4096).slice(0, 64) : [];
    const assistantBody = answerBody || group.querySelector('[data-conversation-role="assistant"]');
    const assistant = assistantBody || progressRoot;
    if (assistant) {
      const complete = !!assistantBody && [...group.querySelectorAll('button[data-testid="copy-turn-action-button"], .turn-action-controls button')]
        .some(visible);
      const failure = group.querySelector('[data-message-error], [data-testid="message-error"]');
      const answer = answerBody || assistant;
      turns.push({
        key: "assistant:" + rawKey,
        role: "assistant",
        parentUserTurnKey: "user:" + rawKey,
        ...(lineageAnchor ? { lineageAnchor } : {}),
        // ChatGPT can expose copy/turn-action controls before generation is finished. The current
        // composer Stop control is the stronger in-progress signal and must dominate those actions.
        phase: failure ? "failed" : stopVisible ? "streaming" : complete ? "complete" : "thinking",
        // Body content and completion authority are independent. Historical action controls
        // can disappear during a new turn without changing the committed answer body.
        text: answerBody ? answerMarkdown(answerBody) : complete ? answerMarkdown(answer || assistant) : undefined,
        // Protocol receipts compare the rendered body, never its Markdown serialization.
        plainBodyText: answerBody ? text(answerBody) : complete ? text(answer || assistant) : undefined,
        // Identity uses the same owned body without presentation visibility. Never use page text.
        bodyProof: answerBody ? answerBodyProof(answerBody) : undefined,
        failureDetail: failure ? text(failure) : undefined,
        publicProgress,
        progressProbe: { linkedRegionCount, visibleLinkedRegionCount, containerPresent: !!progressRoot, anchorCount: progressAnchors.length, titleCount: progressTitleCount, descriptionCount: progressDescriptionCount, containerVisible: !!progressRoot && visible(progressRoot), markerCount: agentStarts.length, agentShellEligible: !!ownedAgentShell, shellSearchDepth, shellCandidateCount, visibleAnchorCount, controlCount, visibleControlCount, localLabelCount, visibleLabelCount,
          containerDisplay: progressStyle?.display === "none" ? "none" : progressStyle?.display === "contents" ? "contents" : "other",
          containerVisibilityHidden: progressStyle?.visibility === "hidden" || progressStyle?.visibility === "collapse",
          containerOpacityZero: progressStyle?.opacity === "0",
          containerHasRects: !!progressRoot && progressRoot.getClientRects().length > 0,
          ownedControlCount: ownedControls.length, ownedVisibleControlCount: ownedVisibleControls.length,
          ownedLocalLabelCount: ownedLabels.length, ownedVisibleLabelCount: ownedLabels.filter(visible).length },
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

const CLASSIFY_CONTEXT_PRELOAD_ARTIFACT = String.raw`function (argument) {
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
  if (composer.querySelectorAll(pillSelector).length !== 0) {
    return { owned: false, reason: "connector_present" };
  }
  const form = composer.closest("form[data-chatgpt-composer], form");
  if (!(form instanceof HTMLElement)) return { owned: false, reason: "form_missing" };
  const attachmentNames = () => {
    const result = new Set();
    const add = value => {
      const normalized = String(value || "").replace(/\s+/g, " ").trim();
      if (normalized && normalized.length <= 240 && !/[\r\n]/.test(normalized)) result.add(normalized);
    };
    for (const candidate of form.querySelectorAll('[data-composer-attachments] [role="group"], .composer-attachment-surface')) {
      if (!(candidate instanceof HTMLElement) || !visible(candidate)) continue;
      add(candidate.getAttribute("aria-label"));
      const labelledBy = candidate.getAttribute("aria-labelledby");
      if (labelledBy) add(document.getElementById(labelledBy)?.textContent);
    }
    for (const root of form.querySelectorAll('[data-composer-attachments]')) {
      if (!(root instanceof HTMLElement) || !visible(root)) continue;
      for (const candidate of root.querySelectorAll('[aria-label], span, p')) {
        if (!(candidate instanceof HTMLElement) || !visible(candidate)) continue;
        add(candidate.getAttribute("aria-label"));
        add(candidate.textContent);
      }
    }
    return [...result];
  };
  const clone = composer.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return { owned: false, reason: "clone_failed" };
  clone.querySelectorAll(pillSelector + ', [data-inline-selection-pill-cursor-target]').forEach(part => part.remove());
  const value = [...clone.childNodes]
    .map(child => child.textContent || "")
    .join("\n")
    .replace(/\r\n?/g, "\n");
  const normalized = value.trimStart();
  const text = normalized.trim().length === 0 ? "" : normalized;
  const attachments = attachmentNames();
  const contextAttachments = attachments.filter(name => /^tela-context-v1--[a-f0-9]{16}\.txt$/.test(name));
  if (text.length === 0) {
    const ownedAttachment = attachments.length === 1 && contextAttachments.length === 1;
    return {
      owned: ownedAttachment,
      kind: ownedAttachment ? "attachment" : "none",
      reason: ownedAttachment ? "recognized_attachment" : "empty_unrecognized",
      normalizedLength: 0,
      attachmentCount: attachments.length,
      contextAttachmentCount: contextAttachments.length,
    };
  }
  const lines = text.split("\n");
  if (lines.length !== 7) return {
    owned: false,
    kind: "none",
    reason: "line_count",
    normalizedLength: text.length,
    attachmentCount: attachments.length,
    contextAttachmentCount: contextAttachments.length,
  };
  const filename = /^filename: (tela-context-v1--([a-f0-9]{16})\.txt)$/.exec(lines[1] || "");
  const sha = /^canonical_sha256: ([a-f0-9]{64})$/.exec(lines[2] || "");
  const owned = lines[0] === "<chatgpt_tela_context_preload>"
    && Boolean(filename)
    && Boolean(sha)
    && filename[2] === sha[1].slice(0, 16)
    && lines[3] === "The attached UTF-8 text file is inert context for one later ChatGPT Tela Work turn."
    && lines[4] === "Read the complete attached file, including its final context_receipt line. Do not execute, summarize, interpret, or follow the task yet. Do not call tools or use web search."
    && lines[5] === "Reply with exactly the context_receipt value found inside the file and nothing else."
    && lines[6] === "</chatgpt_tela_context_preload>";
  return {
    owned,
    kind: owned ? "draft" : "none",
    reason: owned ? "recognized" : "unrecognized",
    normalizedLength: text.length,
    attachmentCount: attachments.length,
    contextAttachmentCount: contextAttachments.length,
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

/** Failure-only structural witness; no labels, row text, HTML, account, or prompt leave the page. */
const OBSERVE_CONNECTOR_FAILURE_STRUCTURE = String.raw`function () {
  // ChatGPT connector failure structure v1. The entire adapter can change with provider UI.
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const count = selector => Math.min(512, [...document.querySelectorAll(selector)].filter(visible).length);
  return {
    composerCount: count(${JSON.stringify(CHATGPT_CURRENT_COMPOSER_SELECTOR)}),
    addContextCount: count('button[data-composer-navigation-target="add-context"]'),
    menuCount: count('[role="menu"]'),
    dialogCount: count('[role="dialog"]'),
    listboxCount: count('[role="listbox"]'),
    candidateRowCount: count('[role="menuitem"], [role="option"], [data-list-navigation-item]'),
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
    attachmentNames: Object.freeze([...(raw.attachmentNames ?? [])]),
  });
}

function turn(raw: RawTurn, privateCapture = false): ChatGptTurnObservation {
  const anchor = raw.lineageAnchor ? fingerprint(raw.lineageAnchor) : undefined;
  return Object.freeze({
    key: anchor ? `${raw.role}:anchor:${anchor}` : raw.key,
    role: raw.role,
    ...(raw.parentUserTurnKey ? { parentUserTurnKey: anchor ? `user:anchor:${anchor}` : raw.parentUserTurnKey } : {}),
    ...(anchor ? { lineageAnchor: anchor } : {}),
    ...(raw.contentText !== undefined ? { contentFingerprint: fingerprint(raw.contentText) } : {}),
    ...(raw.candidateTexts?.length === 2 ? { candidateFingerprints: Object.freeze(raw.candidateTexts.map(fingerprint)) } : {}),
    ...(raw.userPayloadReason ? { userPayloadReason: raw.userPayloadReason } : {}),
    ...(raw.userPayloadStructure ? { userPayloadStructure: raw.userPayloadStructure } : {}),
    ...(raw.bodyProof ? { bodyProof: raw.bodyProof.value !== undefined
      ? { version: raw.bodyProof.version, digest: fingerprint(raw.bodyProof.value) }
      : { version: raw.bodyProof.version, reason: raw.bodyProof.reason ?? "body_unavailable" } } : {}),
    ...(privateCapture && raw.bodyProof?.value !== undefined ? { privateBodyEvidence: {
      chunks: raw.bodyProof.value.slice(0, 65536).match(/[\s\S]{1,8192}/g) ?? [],
      complete: raw.bodyProof.value.length <= 65536,
    } } : {}),
    ...(raw.plainBodyText !== undefined ? {
      plainBodyFingerprint: fingerprint(raw.plainBodyText.trim()),
      ...(raw.role === "assistant" ? { plainBodyText: raw.plainBodyText } : {}),
    } : {}),
    ...(raw.phase ? { phase: raw.phase } : {}),
    ...(raw.text !== undefined ? { text: raw.text } : {}),
    ...(raw.failureDetail ? { failureDetail: raw.failureDetail } : {}),
    ...(raw.publicProgress?.length ? { publicProgress: Object.freeze(raw.publicProgress.slice(0, 64)) } : {}),
  });
}

/**
 * Concrete current-ChatGPT DOM adapter over a product-neutral browser page executor.
 * The page script reads only structure needed for semantic proof and converts user text to hashes
 * before exposing the snapshot to the provider/runtime boundary.
 */
export class ChatGptDomSurfaceDriver implements ChatGptSurfaceDriver {
  #activatedApprovalCardKey: string | undefined;
  #lastObstructionRevision: string | undefined;
  #progressProbeTurnKey: string | undefined;
  readonly #progressProbeStates = new Set<string>();
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
    let phase = "surface_read";
    try {
      const raw = await this.page.evaluate<undefined, RawSnapshot>(OBSERVE_CHATGPT_SURFACE, undefined, signal);
      phase = "approval_read";
      const card = await this.page.evaluate<undefined, {
        cardCount: number; denyCount: number; allowCount: number; allowOnceCount: number;
        allowConversationCount?: number;
        alwaysAllowCount: number; unknownCount: number; requiresManualReview?: boolean;
        reviewReason?: "tool_description_policy_directive" | "suspicious_instruction" | "provider_warning" | null;
        cardKey: string | null; proofKey: string | null;
        inputReceived?: boolean;
        receipt?: { cardKey: string; proofKey: string } | null;
      }>(INSPECT_APPROVAL_CARD, undefined, signal);
      phase = "snapshot_projection";
      // Observe only existing reads. Deduplicate bounded structural states, never prose/token
      // changes. Report streaming exclusions too; a settled-only probe misses their cause.
      const settled = raw.turns.filter(item => item.role === "assistant").at(-1);
      if (settled?.progressProbe) {
        if (this.#progressProbeTurnKey !== settled.key) {
          this.#progressProbeTurnKey = settled.key;
          this.#progressProbeStates.clear();
        }
        const signature = fingerprint(JSON.stringify([settled.phase, settled.progressProbe]));
        if (!this.#progressProbeStates.has(signature) && this.#progressProbeStates.size < 32) {
          this.#progressProbeStates.add(signature);
          const probe = settled.progressProbe;
          emitDiagnosticEvent("chatgpt_tela_work", "web_public_progress_extraction", {
            assistant_phase: settled.phase ?? "unknown",
            progress_container_present: probe.containerPresent,
            progress_container_visible: probe.containerVisible,
            progress_container_display: probe.containerDisplay,
            progress_container_visibility_hidden: probe.containerVisibilityHidden,
            progress_container_opacity_zero: probe.containerOpacityZero,
            progress_container_has_rects: probe.containerHasRects,
            progress_owned_control_count: probe.ownedControlCount,
            progress_owned_visible_control_count: probe.ownedVisibleControlCount,
            progress_owned_local_label_count: probe.ownedLocalLabelCount,
            progress_owned_visible_label_count: probe.ownedVisibleLabelCount,
            progress_anchor_count: probe.anchorCount,
            progress_visible_anchor_count: probe.visibleAnchorCount,
            progress_marker_count: probe.markerCount,
            progress_agent_shell_eligible: probe.agentShellEligible,
            progress_shell_search_depth: probe.shellSearchDepth ?? 0,
            progress_shell_candidate_count: probe.shellCandidateCount ?? 0,
            progress_control_count: probe.controlCount,
            progress_visible_control_count: probe.visibleControlCount,
            progress_local_label_count: probe.localLabelCount,
            progress_visible_label_count: probe.visibleLabelCount,
            progress_description_count: probe.descriptionCount,
            progress_linked_region_count: probe.linkedRegionCount ?? 0,
            progress_visible_linked_region_count: probe.visibleLinkedRegionCount ?? 0,
            progress_title_count: probe.titleCount,
            public_progress_part_count: settled.publicProgress?.length ?? 0,
          });
        }
      }
      const approval = card.cardCount > 0 ? Object.freeze({
        cardCount: card.cardCount, denyCount: card.denyCount, allowCount: card.allowCount,
        allowOnceCount: card.allowOnceCount, allowConversationCount: card.allowConversationCount ?? 0,
        alwaysAllowCount: card.alwaysAllowCount,
        unknownCount: card.unknownCount, requiresManualReview: card.requiresManualReview === true,
        ...(card.requiresManualReview && card.reviewReason ? { reviewReason: card.reviewReason } : {}),
        revisionFingerprint: fingerprint(JSON.stringify([card.cardKey, card.proofKey])),
        ...(card.cardCount === 1 && card.cardKey ? { cardFingerprint: diagnosticFingerprint(card.cardKey) } : {}),
        inputReceived: card.inputReceived === true,
      }) : undefined;
      const captureRoot = configuredDiagnosticRoot();
      const privateCapture = !!captureRoot && privateDiagnosticCaptureEnabled(captureRoot);
      const snapshot = {
        ...(approval ? { approval } : {}),
        ...(card.receipt ? { approvalInputReceipt: Object.freeze({
          cardFingerprint: diagnosticFingerprint(card.receipt.cardKey),
          revisionFingerprint: fingerprint(JSON.stringify([card.receipt.cardKey, card.receipt.proofKey])),
        }) } : {}),
        url: raw.url,
        composers: Object.freeze(raw.composers.map(composer)),
        sendControls: Object.freeze(raw.sendControls.map((control): ChatGptSendObservation => Object.freeze({ ...control }))),
        turns: Object.freeze(raw.turns.map(item => turn(item, privateCapture))),
      };
      return Object.freeze({ revision: semanticRevision(snapshot), ...snapshot });
    } catch (error) {
      emitDiagnosticEvent("chatgpt_tela_work", "web_dom_observation_failed", {
        phase,
        reason_class: signal?.aborted ? "aborted" : error instanceof TypeError ? "type_error"
          : error instanceof SyntaxError ? "syntax_error" : "observation_error",
      });
      throw error;
    }
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

  async recoverContextPreloadArtifact(composerKey: string, signal?: AbortSignal): Promise<boolean> {
    const classification = await this.page.evaluate<
      { readonly composerKey: string },
      {
        readonly owned: boolean;
        readonly kind?: "draft" | "attachment" | "none";
        readonly reason: string;
        readonly normalizedLength?: number;
        readonly attachmentCount?: number;
        readonly contextAttachmentCount?: number;
      }
    >(CLASSIFY_CONTEXT_PRELOAD_ARTIFACT, { composerKey }, signal);
    emitDiagnosticEvent("chatgpt_tela_work", classification.owned
      ? "context_attachment_draft_recovered"
      : "context_attachment_draft_not_owned", {
      reason: classification.reason,
      artifact_kind: classification.kind ?? "unknown",
      normalized_length: classification.normalizedLength ?? -1,
      attachment_count: classification.attachmentCount ?? -1,
      context_attachment_count: classification.contextAttachmentCount ?? -1,
    });
    if (!classification.owned) return false;
    if (classification.kind === "attachment") {
      await this.page.evaluate(FOCUS_COMPOSER, { composerKey }, signal);
      await this.page.pressKey("Backspace", signal);
      await this.#settleUi(signal);
      const after = await this.page.evaluate<
        { readonly composerKey: string },
        {
          readonly owned: boolean;
          readonly kind?: "draft" | "attachment" | "none";
          readonly reason: string;
          readonly normalizedLength?: number;
          readonly attachmentCount?: number;
          readonly contextAttachmentCount?: number;
        }
      >(CLASSIFY_CONTEXT_PRELOAD_ARTIFACT, { composerKey }, signal);
      if ((after.attachmentCount ?? -1) === 0 && (after.normalizedLength ?? -1) === 0) {
        emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_stale_file_recovered", {
          removal: "composer_backspace",
        });
        return true;
      }
      emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_stale_file_recovery_failed", {
        attachment_count: after.attachmentCount ?? -1,
        context_attachment_count: after.contextAttachmentCount ?? -1,
        normalized_length: after.normalizedLength ?? -1,
      });
      return false;
    }
    await this.page.evaluate(FOCUS_COMPOSER, { composerKey }, signal);
    await this.page.clearFocusedEditable(signal);
    return true;
  }

  async #prepareApprovalCard(
    mode: ChatGptApprovalAutomationMode,
    signal: AbortSignal,
    delayMs: number,
    expected?: { readonly cardFingerprint: string; readonly revisionFingerprint: string },
  ) {
    type ApprovalObservation = {
      readonly targetState?: "unprepared" | "changed" | "outside_viewport" | "occluded" | "ready";
      readonly obstruction?: {
        readonly kind: string;
        readonly inCard: boolean;
        readonly pointerEventsNone: boolean;
        readonly inert: boolean;
        readonly documentHidden: boolean;
      };
      readonly cardCount: number;
      readonly denyCount: number;
      readonly allowCount: number;
      readonly allowOnceCount: number;
      readonly allowConversationCount?: number;
      readonly alwaysAllowCount: number;
      readonly unknownCount: number;
      readonly requiresManualReview?: boolean;
      readonly allowPoint: { readonly x: number; readonly y: number } | null;
      readonly allowOncePoint: { readonly x: number; readonly y: number } | null;
      readonly allowConversationPoint?: { readonly x: number; readonly y: number } | null;
      readonly optionsDisclosureCount?: number;
      readonly optionsExpanded?: boolean;
      readonly optionsPoint?: { readonly x: number; readonly y: number } | null;
      readonly optionsAnchorStable?: boolean | null;
      readonly optionsAttempted?: boolean;
      readonly cardKey: string | null;
      readonly proofKey: string | null;
    };
    const inspect = () => this.page.evaluate<undefined, ApprovalObservation>(INSPECT_APPROVAL_CARD, undefined, signal);
    let observed = await inspect();
    if (expected && (!observed.cardKey || diagnosticFingerprint(observed.cardKey) !== expected.cardFingerprint
      || fingerprint(JSON.stringify([observed.cardKey, observed.proofKey])) !== expected.revisionFingerprint)) {
      this.#diagnostic("approval_changed_before_activation", { reason_class: "observed_card_changed" });
      return Object.freeze({ status: "none" as const, reason: "card_changed" });
    }
    // An unverified menu-open outcome consumes this card's one-use
    // automation opportunity. Never turn the next observation into a
    // second chance to approve a possibly replaced tool request.
    if (observed.cardKey && observed.optionsAttempted) {
      return Object.freeze({ status: "none" as const, reason: "options_already_attempted" });
    }
    // A conversation-only option may be hidden under an explicit card-local
    // disclosure. Open that one menu at most once per exact card, then re-prove
    // the unchanged card and its freshly linked choices before any approval.
    // Never open a dropdown on a warned, unknown or ambiguous card.
    if (mode === "recognized_conversation" && observed.cardCount === 1
      && !observed.requiresManualReview && observed.denyCount === 1
      && observed.allowCount === 0 && observed.allowOnceCount === 1
      && observed.allowConversationCount === 0 && observed.alwaysAllowCount === 0
      && observed.unknownCount === 0 && observed.optionsDisclosureCount === 1
      && !observed.optionsExpanded && observed.optionsPoint
      && observed.cardKey && observed.proofKey) {
      const opening = await this.page.evaluate<{ cardKey: string; proofKey: string; choice: string }, ApprovalObservation>(
        INSPECT_APPROVAL_CARD, { cardKey: observed.cardKey, proofKey: observed.proofKey,
          choice: "open_options" }, signal,
      );
      if (opening.cardKey !== observed.cardKey || opening.proofKey !== observed.proofKey
        || opening.requiresManualReview || opening.targetState !== "ready" || !opening.optionsPoint) {
        this.#diagnostic("approval_options_open_withheld", { reason_class: "target_unverified" });
        return Object.freeze({ status: "none" as const, reason: "options_unverified" });
      }
      const cardKey = observed.cardKey;
      this.#diagnostic("approval_options_open_started", { card_fingerprint: diagnosticFingerprint(cardKey) });
      try {
        await this.page.pointerClick(opening.optionsPoint, signal);
      } catch (error) {
        this.#diagnostic("approval_options_open_failed", {
          reason_class: signal.aborted ? "owner_cancelled" : "dispatch_indeterminate",
          automatic_retry: false,
        });
        throw error;
      }
      signal.throwIfAborted();
      observed = await inspect();
      if (observed.cardKey !== cardKey || observed.optionsAnchorStable !== true
        || observed.optionsExpanded !== true || observed.optionsDisclosureCount !== 1
        || observed.cardCount !== 1 || observed.denyCount !== 1 || observed.allowCount !== 0
        || observed.allowOnceCount !== 1 || observed.allowConversationCount !== 1
        || observed.alwaysAllowCount !== 0 || observed.unknownCount !== 0 || observed.requiresManualReview) {
        this.#diagnostic("approval_options_open_withheld", { reason_class: "menu_unverified" });
        return Object.freeze({ status: "none" as const, reason: "options_unverified" });
      }
      this.#diagnostic("approval_options_open_verified", {
        card_fingerprint: diagnosticFingerprint(cardKey),
      });
    }
    const decision = decideChatGptApproval(mode, observed);
    if (observed.cardCount > 0) this.#diagnostic("approval_policy", {
      mode,
      action: decision.action,
      requires_manual_review: observed.requiresManualReview === true,
      card_count: observed.cardCount,
      deny_count: observed.denyCount,
      allow_count: observed.allowCount,
      allow_once_count: observed.allowOnceCount,
      always_allow_count: observed.alwaysAllowCount,
      unknown_count: observed.unknownCount,
    });
    if (decision.action === "none") {
      return Object.freeze({ status: "none" as const, reason: decision.reason });
    }
    const scoped = decision.action === "approve_conversation";
    if (!observed.cardKey || !observed.proofKey
      || !(scoped ? observed.allowConversationPoint : observed.allowOncePoint)) {
      return Object.freeze({ status: "none" as const, reason: "target_missing" });
    }
    if (observed.cardKey === this.#activatedApprovalCardKey) {
      this.#diagnostic("approval_activation_withheld", { reason_class: "already_activated",
        card_fingerprint: diagnosticFingerprint(observed.cardKey), proof_fingerprint: diagnosticFingerprint(observed.proofKey ?? "") });
      return Object.freeze({ status: "none" as const, reason: "already_activated" });
    }
    if (delayMs > 0) {
      const cardKey = observed.cardKey;
      const proofKey = observed.proofKey;
      await waitForDelay(delayMs, undefined, { signal });
      observed = await inspect();
      if (observed.cardKey !== cardKey || observed.proofKey !== proofKey
        || (observed.optionsAttempted && observed.optionsAnchorStable !== true)
        || decideChatGptApproval(mode, observed).action !== decision.action) {
        this.#diagnostic("approval_changed_before_activation");
        return Object.freeze({ status: "none" as const, reason: "card_changed" });
      }
    }
    this.#diagnostic("approval_preparation_target", {
      card_fingerprint: diagnosticFingerprint(observed.cardKey!),
      proof_fingerprint: diagnosticFingerprint(observed.proofKey!),
    });
    const prepared = await this.page.evaluate<{ cardKey: string; proofKey: string; choice: string }, ApprovalObservation>(
      INSPECT_APPROVAL_CARD, { cardKey: observed.cardKey!, proofKey: observed.proofKey!,
        choice: decision.preferredChoice }, signal,
    );
    if (prepared.cardKey !== observed.cardKey || prepared.proofKey !== observed.proofKey
      || (prepared.optionsAttempted && prepared.optionsAnchorStable !== true)
      || decideChatGptApproval(mode, prepared).action !== decision.action) {
      this.#diagnostic("approval_changed_before_activation");
      return Object.freeze({ status: "none" as const, reason: "card_changed" });
    }
    observed = prepared;
    const target = scoped ? observed.allowConversationPoint : observed.allowOncePoint;
    if (!target) {
      const obstruction = observed.obstruction;
      const revision = fingerprint(JSON.stringify([observed.cardKey, observed.proofKey]));
      if (observed.targetState === "occluded" && obstruction && revision !== this.#lastObstructionRevision) {
        // One retained revision, no growing history or retry loop. Only new revisions
        // produce another canonical incident while the same target stays obstructed.
        this.#lastObstructionRevision = revision;
        this.#diagnostic("approval_target_failed", {
          reason_class: "occluded", dispatch_started: false,
          card_fingerprint: diagnosticFingerprint(observed.cardKey!),
          proof_fingerprint: diagnosticFingerprint(observed.proofKey!),
          target_kind: ["none", "document", "dialog", "control", "other"].includes(obstruction.kind)
            ? obstruction.kind : "unknown",
          hit_in_card: obstruction.inCard === true,
          target_pointer_events_none: obstruction.pointerEventsNone === true,
          target_inert: obstruction.inert === true,
          document_hidden: obstruction.documentHidden === true,
        });
      }
      this.#diagnostic("approval_target_missing", { preferred: decision.preferredChoice,
        reason_class: observed.targetState ?? "target_missing" });
      return Object.freeze({ status: "none" as const, reason: "target_missing" });
    }
    if (observed.cardKey === this.#activatedApprovalCardKey) {
      this.#diagnostic("approval_activation_withheld", { reason_class: "already_activated",
        card_fingerprint: diagnosticFingerprint(observed.cardKey), proof_fingerprint: diagnosticFingerprint(observed.proofKey ?? "") });
      return Object.freeze({ status: "none" as const, reason: "already_activated" });
    }
    return { status: "ready" as const, target, cardKey: observed.cardKey!, proofKey: observed.proofKey!,
      choice: decision.preferredChoice };
  }

  async processApprovalCard(
    mode: ChatGptApprovalAutomationMode,
    signal?: AbortSignal,
    delayMs = 0,
    expected?: { readonly cardFingerprint: string; readonly revisionFingerprint: string },
  ): ReturnType<NonNullable<ChatGptSurfaceDriver["processApprovalCard"]>> {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 15_000) {
      throw new Error("ChatGPT approval delay must be 0-15000ms");
    }
    const started = performance.now();
    this.#diagnostic("approval_preparation_started", { consent_delay_ms: delayMs });
    const prepare = (scope: AbortSignal) => this.#prepareApprovalCard(mode, scope, delayMs, expected);
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepareApprovalWithinDeadline(
        prepare, signal, delayMs,
      );
      signal?.throwIfAborted();
      this.#diagnostic("approval_preparation_settled", {
        outcome: prepared.status, duration_ms: Math.max(0, Math.round(performance.now() - started)),
      });
    } catch (error) {
      this.#diagnostic("approval_preparation_failed", {
        reason_class: signal?.aborted ? "owner_cancelled"
          : error instanceof DOMException && error.name === "TimeoutError" ? "preparation_timeout" : "preparation_failed",
        duration_ms: Math.max(0, Math.round(performance.now() - started)), dispatch_started: false,
      });
      throw error;
    }
    if (prepared.status !== "ready") return prepared;
    // A concurrent preparation must still respect the single activation fence.
    if (prepared.cardKey === this.#activatedApprovalCardKey) {
      this.#diagnostic("approval_activation_withheld", { reason_class: "already_activated" });
      return Object.freeze({ status: "none" as const, reason: "already_activated" });
    }
    // An ambiguous activation must never be retried against the same card.
    this.#activatedApprovalCardKey = prepared.cardKey;
    this.#diagnostic("approval_dispatch_started", { card_fingerprint: diagnosticFingerprint(prepared.cardKey) });
    try {
      await this.page.pointerClick(prepared.target, signal);
    } catch (error) {
      this.#diagnostic("approval_dispatch_failed", {
        reason_class: signal?.aborted ? "owner_cancelled" : "dispatch_indeterminate",
        card_fingerprint: diagnosticFingerprint(prepared.cardKey),
        proof_fingerprint: diagnosticFingerprint(prepared.proofKey),
        automatic_retry: false,
      });
      throw error;
    }
    this.#diagnostic("approval_activated", { choice: prepared.choice,
      card_fingerprint: diagnosticFingerprint(prepared.cardKey), proof_fingerprint: diagnosticFingerprint(prepared.proofKey) });
    return Object.freeze({ status: "dispatched" as const, reason: prepared.choice,
      cardFingerprint: diagnosticFingerprint(prepared.cardKey),
      revisionFingerprint: fingerprint(JSON.stringify([prepared.cardKey, prepared.proofKey])) });
  }

  async replaceComposerText(composerKey: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.page.evaluate(REPLACE_COMPOSER_TEXT, { composerKey, text }, signal);
  }

  /** Nonmutating focus of the exact current composer for trusted Electron typing. */
  async focusComposer(composerKey: string, signal?: AbortSignal): Promise<void> {
    await this.page.evaluate(FOCUS_COMPOSER, { composerKey }, signal);
  }

  async clearComposerText(composerKey: string, signal?: AbortSignal): Promise<void> {
    await this.page.evaluate(FOCUS_COMPOSER, { composerKey }, signal);
    await this.page.clearFocusedEditable(signal);
  }

  async appendComposerText(composerKey: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.page.evaluate(APPEND_COMPOSER_TEXT, { composerKey, text }, signal);
  }

  async attachFiles(
    composerKey: string,
    files: readonly import("@chatgpt-tela/browser-host").BrowserMemoryFile[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (composerKey !== "composer:primary") throw new Error("ChatGPT attachment composer is not uniquely addressable");
    if (!this.page.setFileInputFiles) throw new Error("browser surface does not support memory-backed file input");
    const before = await this.observe(signal);
    const composer = before.composers.find(item => item.key === composerKey);
    if (!composer || !composer.visible || !composer.editable || !composer.ownedByChatGptForm) {
      throw new Error("ChatGPT attachment composer is not ready");
    }
    if (composer.attachmentNames.length !== 0) {
      throw new Error("ChatGPT attachment preload requires an empty composer attachment surface");
    }
    type UploadSurface = {
      readonly ready: boolean;
      readonly reason: string;
      readonly targetKind?: string;
      readonly composerCount: number;
      readonly fileInputCount: number;
      readonly formFileInputCount?: number;
      readonly genericInputCount?: number;
      readonly imageOnlyInputCount?: number;
      readonly addContextCount: number;
      readonly inputSummaries?: readonly {
        readonly index: number;
        readonly inForm: boolean;
        readonly multiple: boolean;
        readonly disabled: boolean;
        readonly acceptKind: string;
        readonly testIdKind: string;
        readonly selected: boolean;
      }[];
    };
    let upload = await this.page.evaluate<undefined, UploadSurface>(PREPARE_CONTEXT_UPLOAD_INPUT, undefined, signal);
    emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_upload_surface", {
      phase: "initial",
      ready: upload.ready,
      reason: upload.reason,
      target_kind: upload.targetKind ?? "none",
      file_input_count: upload.fileInputCount,
      form_file_input_count: upload.formFileInputCount ?? -1,
      generic_input_count: upload.genericInputCount ?? -1,
      image_only_input_count: upload.imageOnlyInputCount ?? -1,
      add_context_count: upload.addContextCount,
    });
    for (const item of upload.inputSummaries ?? []) {
      emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_input_candidate", {
        phase: "initial",
        input_index: item.index,
        in_form: item.inForm,
        multiple: item.multiple,
        disabled: item.disabled,
        accept_kind: item.acceptKind,
        testid_kind: item.testIdKind,
        selected: item.selected,
      });
    }
    if (upload.addContextCount === 1) {
      if (!this.page.setFileChooserFiles) {
        throw new Error("ChatGPT add-context upload requires browser file chooser interception");
      }
      let uploadActionPoint: { readonly x: number; readonly y: number } | undefined;
      let lastUploadObservation: {
        readonly rowCount: number;
        readonly semanticCount: number;
        readonly highlightedCount: number;
        readonly targetKind: string;
        readonly targetIndex?: number;
        readonly genericAttributeShapes: readonly string[];
        readonly point?: { readonly x: number; readonly y: number };
      } | undefined;
      const observeUploadAction = async (timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        let revision = await this.page.mutationRevision(signal);
        for (;;) {
          const observed = await this.page.evaluate<undefined, NonNullable<typeof lastUploadObservation>>(
            OBSERVE_ACTIVE_ADD_CONTEXT_UPLOAD_ACTION,
            undefined,
            signal,
          );
          lastUploadObservation = observed;
          if (observed.semanticCount > 1) {
            throw new Error("ChatGPT add-context upload action is ambiguous");
          }
          if (observed.point) {
            uploadActionPoint = observed.point;
            return true;
          }
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) return false;
          const timeout = AbortSignal.timeout(remainingMs);
          const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
          try {
            revision = await this.page.waitForDomMutation(revision, combined);
          } catch (error) {
            if (signal?.aborted) throw signal.reason ?? error;
            return false;
          }
        }
      };

      for (const activation of ["pointer", "keyboard", "dom"] as const) {
        if (activation !== "pointer") {
          await this.dismissTransientUi(signal).catch(() => {});
          await this.#settleUi(signal);
        }
        if (activation === "pointer") {
          const addContextPoint = await this.page.evaluate<undefined, { readonly x: number; readonly y: number }>(
            LOCATE_ADD_CONTEXT_CONTROL,
            undefined,
            signal,
          );
          await this.page.pointerClick(addContextPoint, signal);
        } else if (activation === "keyboard") {
          await this.page.evaluate(FOCUS_ADD_CONTEXT_CONTROL, undefined, signal);
          await this.page.pressKey("Enter", signal);
        } else {
          await this.page.evaluate(ACTIVATE_ADD_CONTEXT_CONTROL, undefined, signal);
        }
        await this.#settleUi(signal);
        emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_add_context_activation", {
          activation,
        });
        if (await observeUploadAction(2_000)) {
          emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_add_context_opened", {
            activation,
          });
          break;
        }
      }
      if (!uploadActionPoint) {
        emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_upload_action_unavailable", {
          row_count: lastUploadObservation?.rowCount ?? -1,
          semantic_count: lastUploadObservation?.semanticCount ?? -1,
          highlighted_count: lastUploadObservation?.highlightedCount ?? -1,
          target_kind: lastUploadObservation?.targetKind ?? "unknown",
          target_index: lastUploadObservation?.targetIndex ?? -1,
          generic_attribute_shapes: lastUploadObservation?.genericAttributeShapes.join("|") ?? "",
        });
        throw new Error("ChatGPT add-context upload action did not become uniquely observable");
      }
      emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_upload_action_ready", {
        row_count: lastUploadObservation?.rowCount ?? -1,
        target_kind: lastUploadObservation?.targetKind ?? "unknown",
        target_index: lastUploadObservation?.targetIndex ?? -1,
      });
      try {
        await this.page.setFileChooserFiles(uploadActionPoint, files, signal);
        emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_file_chooser_injected");
      } catch (error) {
        await this.dismissTransientUi(signal).catch(() => {});
        throw error;
      }
    } else {
      if (!upload.ready) {
        throw new Error("ChatGPT generic memory-backed attachment input is unavailable");
      }
      try {
        await this.page.setFileInputFiles(CHATGPT_MEMORY_UPLOAD_TARGET_SELECTOR, files, signal);
      } finally {
        await this.page.evaluate(CLEAR_CONTEXT_UPLOAD_INPUT_MARKER, undefined, signal).catch(() => {});
      }
    }
    let snapshot = await this.observe(signal);
    const observeExpectedIdentity = () => this.page.evaluate<
      { readonly names: readonly string[] },
      {
        readonly composerCount: number;
        readonly matchedCount: number;
        readonly fileInputMatchCount: number;
        readonly visibleOutsideComposerMatchCount: number;
        readonly attachmentRootCount: number;
        readonly outsideGroupCount: number;
        readonly progressCount: number;
      }
    >(OBSERVE_EXPECTED_ATTACHMENT_IDENTITY, { names: files.map(file => file.name) }, signal);
    const firstComposer = snapshot.composers.find(item => item.key === composerKey);
    const firstSends = snapshot.sendControls.filter(control => control.composerKey === composerKey && control.visible);
    const firstIdentity = await observeExpectedIdentity();
    let exactIdentityObserved = firstIdentity.matchedCount === files.length;
    emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_post_upload", {
      composer_present: firstComposer !== undefined,
      composer_length: firstComposer?.textLength ?? -1,
      connector_count: firstComposer?.connectorFingerprints.length ?? -1,
      attachment_count: firstComposer?.attachmentNames.length ?? -1,
      expected_attachment_count: firstComposer
        ? files.filter(file => firstComposer.attachmentNames.includes(file.name)).length
        : -1,
      expected_attachment_visible: Boolean(firstComposer && files.every(file => firstComposer.attachmentNames.includes(file.name))),
      identity_match_count: firstIdentity.matchedCount,
      file_input_match_count: firstIdentity.fileInputMatchCount,
      outside_match_count: firstIdentity.visibleOutsideComposerMatchCount,
      attachment_root_count: firstIdentity.attachmentRootCount,
      outside_group_count: firstIdentity.outsideGroupCount,
      progress_count: firstIdentity.progressCount,
      send_count: firstSends.length,
      send_enabled: firstSends.length === 1 && firstSends[0]!.enabled,
    });
    let lastWaitState = "";
    for (;;) {
      const current = snapshot.composers.find(item => item.key === composerKey);
      const exactIdentityVisible = Boolean(current && files.every(file => current.attachmentNames.includes(file.name)));
      const sends = snapshot.sendControls.filter(control => control.composerKey === composerKey && control.visible);
      const identity = await observeExpectedIdentity();
      exactIdentityObserved ||= exactIdentityVisible || identity.matchedCount === files.length;
      // ChatGPT's current attachment renderer exposes the exact filename while upload is in
      // progress, then may collapse the settled chip to a generic attachment label. Preserve the
      // exact observation as causal identity proof and require the same composer to retain an
      // attachment surface after progress settles and Send becomes enabled. The preload receipt
      // subsequently proves the actual uploaded bytes before any real Work turn is authorized.
      const settled = Boolean(current)
        && exactIdentityObserved
        && current!.attachmentNames.length > 0
        && identity.progressCount === 0
        && sends.length === 1
        && sends[0]!.enabled;
      if (settled) return;
      const waitState = [
        current ? "composer" : "missing",
        current?.textLength ?? -1,
        current?.connectorFingerprints.length ?? -1,
        current?.attachmentNames.length ?? -1,
        exactIdentityVisible ? 1 : 0,
        exactIdentityObserved ? 1 : 0,
        identity.matchedCount,
        identity.fileInputMatchCount,
        identity.visibleOutsideComposerMatchCount,
        identity.attachmentRootCount,
        identity.outsideGroupCount,
        identity.progressCount,
        sends.length,
        sends.length === 1 && sends[0]!.enabled ? 1 : 0,
      ].join(":");
      if (waitState !== lastWaitState) {
        lastWaitState = waitState;
        emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_wait_state", {
          composer_present: current !== undefined,
          composer_length: current?.textLength ?? -1,
          connector_count: current?.connectorFingerprints.length ?? -1,
          attachment_count: current?.attachmentNames.length ?? -1,
          expected_attachment_visible: exactIdentityVisible,
          expected_attachment_observed: exactIdentityObserved,
          identity_match_count: identity.matchedCount,
          file_input_match_count: identity.fileInputMatchCount,
          outside_match_count: identity.visibleOutsideComposerMatchCount,
          attachment_root_count: identity.attachmentRootCount,
          outside_group_count: identity.outsideGroupCount,
          progress_count: identity.progressCount,
          send_count: sends.length,
          send_enabled: sends.length === 1 && sends[0]!.enabled,
        });
      }
      try {
        snapshot = await this.waitForChange(snapshot.revision, signal);
      } catch (error) {
        emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_wait_failed", {
          composer_present: current !== undefined,
          composer_length: current?.textLength ?? -1,
          connector_count: current?.connectorFingerprints.length ?? -1,
          attachment_count: current?.attachmentNames.length ?? -1,
          expected_attachment_visible: exactIdentityVisible,
          expected_attachment_observed: exactIdentityObserved,
          identity_match_count: identity.matchedCount,
          file_input_match_count: identity.fileInputMatchCount,
          outside_match_count: identity.visibleOutsideComposerMatchCount,
          attachment_root_count: identity.attachmentRootCount,
          outside_group_count: identity.outsideGroupCount,
          progress_count: identity.progressCount,
          send_count: sends.length,
          send_enabled: sends.length === 1 && sends[0]!.enabled,
        });
        throw error;
      }
    }
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
      // The first-start failure previously retained only an attempt count.
      // Take one bounded read when the selection has actually failed, before
      // cleanup closes the transient menu. This witness cannot approve, retry,
      // or change the original failure outcome.
      let structure: {
        readonly composerCount: number;
        readonly addContextCount: number;
        readonly menuCount: number;
        readonly dialogCount: number;
        readonly listboxCount: number;
        readonly candidateRowCount: number;
      } | undefined;
      if (!signal?.aborted) {
        try { structure = await this.page.evaluate(OBSERVE_CONNECTOR_FAILURE_STRUCTURE, undefined, signal); }
        catch { /* Unavailable diagnostic evidence never overrides the first failure. */ }
      }
      this.#diagnostic("selection_failed", {
        reason_class: fallbackError instanceof ChatGptConnectorCatalogUnavailableError
          ? "catalog_unavailable" : "selection_unproven",
        structure_observed: structure !== undefined,
        ...(structure ? {
          visible_composers: structure.composerCount,
          visible_add_context_controls: structure.addContextCount,
          visible_menus: structure.menuCount,
          visible_dialogs: structure.dialogCount,
          visible_listboxes: structure.listboxCount,
          visible_candidate_rows: structure.candidateRowCount,
        } : {}),
      });
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
