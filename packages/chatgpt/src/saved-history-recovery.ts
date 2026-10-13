import { createHash } from "node:crypto";
import { BROWSER_PAGE_AUTOMATION, type BrowserPageAutomation, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { ChatGptDomSurfaceDriver } from "./dom-driver";
import { deleteOwnedSyntheticSavedChat, type SyntheticSavedChatDeleteReceipt } from "./saved-history-delete";
import { CHATGPT_SAVED_CHAT_URL } from "./session";

export interface SyntheticSavedChatRecoveryReceipt {
  readonly contractVersion: 1;
  readonly syntheticConversationProven: true;
  readonly officialDelete: SyntheticSavedChatDeleteReceipt;
}

type RecoveryCandidate = {
  readonly matchCount: number;
  readonly historyLinkCount: number;
  readonly path?: string;
  readonly exactUserMessage?: string;
};

/** This is intentionally a *current-page-only* witness. If a previous
 * synthetic Send was interrupted while its new conversation remained open,
 * the ChatGPT-generated sidebar title is not assumed to contain the marker.
 * A personal chat or extra user turn is never a valid recovery candidate.
 */
const FIND_OPEN_SYNTHETIC_CHAT = String.raw`function () {
  if (location.origin !== "https://chatgpt.com"
    || !/^\/c\/[a-zA-Z0-9_-]{8,128}$/.test(location.pathname)
    || location.search || location.hash) {
    return { matchCount: 0, historyLinkCount: 0 };
  }
  const userBubbles = [...document.querySelectorAll('[data-user-message-bubble]')];
  if (userBubbles.length !== 1) return { matchCount: 0, historyLinkCount: 0 };
  const authorRoots = [...userBubbles[0].querySelectorAll('[data-search-result-target]')];
  if (authorRoots.length !== 1) return { matchCount: 0, historyLinkCount: 0 };
  const candidate = String(authorRoots[0].textContent || "").replace(/\r\n?/g, "\n");
  if (!/^TELA-SAVED-DELETE-TEST:[a-f0-9]{32}$/.test(candidate)) {
    return { matchCount: 0, historyLinkCount: 0 };
  }
  const all = [...document.querySelectorAll('a[href^="/c/"]')];
  const matching = all.filter(link => {
    try { const url = new URL(link.getAttribute("href"),location.href);
      return url.origin === location.origin && url.pathname === location.pathname; }
    catch { return false; }
  });
  const visible = link => link instanceof HTMLElement && link.getClientRects().length > 0
    && getComputedStyle(link).visibility !== "hidden"
    && getComputedStyle(link).display !== "none";
  if (matching.filter(visible).length !== 1) {
    return { matchCount: 0, historyLinkCount: Math.min(500,all.length) };
  }
  return { matchCount: 1, historyLinkCount: Math.min(500,all.length),
    path: location.pathname, exactUserMessage: candidate };
}`;

const FIND_ONE_SYNTHETIC_CHAT = String.raw`function () {
  if (location.origin !== "https://chatgpt.com" || location.pathname !== "/") {
    throw Error("Expected exact owner ChatGPT home");
  }
  const links = [...document.querySelectorAll('a[href^="/c/"]')];
  if (links.length > 500) throw Error("Saved history exceeds a bounded scan");
  const found = new Map();
  for (const link of links) {
    const url = new URL(link.getAttribute("href"), location.href);
    if (url.origin !== location.origin || !/^\/c\/[a-zA-Z0-9_-]{8,128}$/.test(url.pathname)) continue;
    // This marker was generated solely by Tela. Do not return or record
    // personal chat titles, other conversation IDs or snippets.
    const matches = String(link.innerText || "").match(/TELA-SAVED-DELETE-TEST:[a-f0-9]{32}/g) || [];
    for (const marker of matches) {
      const previous = found.get(url.pathname);
      if (previous && previous !== marker) throw Error("Ambiguous synthetic chat identity");
      found.set(url.pathname, marker);
    }
  }
  if (found.size !== 1) return { matchCount: found.size, historyLinkCount: links.length };
  const [path, exactUserMessage] = [...found.entries()][0];
  return { matchCount: 1, historyLinkCount: links.length, path, exactUserMessage };
}`;

/** Official ChatGPT UI search can locate chat *message* text even when the
 * auto-generated title does not contain the synthetic message. Only the exact
 * reserved marker prefix is entered; no private history is exported.
 */
const LOCATE_HISTORY_SEARCH_BUTTON = String.raw`function () {
  if (location.origin !== "https://chatgpt.com" || location.pathname !== "/") {
    return { ready: false, reason: "not_saved_home" };
  }
  const visible = el => el instanceof HTMLElement && el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== "hidden"
    && getComputedStyle(el).display !== "none";
  const options = [...document.querySelectorAll('button,[role="button"],a')].filter(visible)
    .filter(el => /^(search|search chats|search chat history|검색|채팅 검색|대화 검색)$/i.test(
      String(el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || "").trim()));
  if (options.length !== 1) {
    return { ready: false, reason: "search_button_not_unique" };
  }
  const rect = options[0].getBoundingClientRect();
  const x = rect.left + rect.width/2, y=rect.top + rect.height/2;
  const hit = document.elementFromPoint(x,y);
  if (!hit || (hit !== options[0] && !options[0].contains(hit))) {
    return { ready: false, reason: "search_button_unhittable" };
  }
  return { ready: true, reason: "official_search_button", point: { x,y } };
}`;

const FOCUS_EMPTY_HISTORY_SEARCH = String.raw`function () {
  if (location.origin !== "https://chatgpt.com") return { ready: false, reason: "wrong_origin" };
  const visible = el => el instanceof HTMLElement && el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== "hidden"
    && getComputedStyle(el).display !== "none";
  const visibleFields = [...document.querySelectorAll('input,[role="searchbox"],[contenteditable="true"]')]
    .filter(visible);
  const searchLabel = el => /search|검색/i.test(
    String(el.getAttribute("placeholder") || "") + " "
    + String(el.getAttribute("aria-label") || "") + " "
    + String(el.getAttribute("data-testid") || ""));
  const options = visibleFields.filter(el =>
    (el instanceof HTMLInputElement && (el.type === "search" || searchLabel(el)))
    || (el.getAttribute("role") === "searchbox" && el.isContentEditable)
    || (el.isContentEditable && searchLabel(el) && !el.matches(
      '#prompt-textarea,[data-testid="prompt-textarea"]')));
  const diagnostics = { candidateCount: Math.min(options.length,20),
    visibleInputCount: Math.min(visibleFields.filter(el => el instanceof HTMLInputElement).length,20),
    visibleEditableCount: Math.min(visibleFields.filter(el => el.isContentEditable).length,20),
    visibleDialogCount: Math.min([...document.querySelectorAll('[role="dialog"]')].filter(visible).length,20) };
  if (options.length !== 1) return { ready: false, reason: "search_field_not_unique", ...diagnostics };
  const input = options[0];
  if (String(input instanceof HTMLInputElement ? input.value : input.textContent || "") !== "") {
    return { ready: false, reason: "existing_search_draft", ...diagnostics };
  }
  input.focus();
  return { ready: document.activeElement === input,
    reason: "official_search_input_focus", ...diagnostics };
}`;

const FIND_SYNTHETIC_SEARCH_RESULT = String.raw`function () {
  if (location.origin !== "https://chatgpt.com") throw Error("Wrong search origin");
  const inputs = [...document.querySelectorAll('input,[role="searchbox"],[contenteditable="true"]')].filter(el =>
    (el instanceof HTMLInputElement && (
      el.type === "search" || /search|검색/i.test(
        String(el.getAttribute("placeholder") || "") + String(el.getAttribute("aria-label") || ""))))
    || (el instanceof HTMLElement && el.isContentEditable && (
      el.getAttribute("role") === "searchbox" || /search|검색/i.test(
        String(el.getAttribute("data-testid") || "") + String(el.getAttribute("aria-label") || "")))));
  if (!inputs.some(el => String(el instanceof HTMLInputElement ? el.value : el.textContent || "")
    === "TELA-SAVED-DELETE-TEST:")) {
    return { matchCount: 0, historyLinkCount: 0, searchActive: false };
  }
  const found = new Map();
  const links = [...document.querySelectorAll('a[href^="/c/"]')].slice(0,500);
  for (const link of links) {
    const url = new URL(link.getAttribute("href"), location.href);
    if (url.origin !== location.origin || !/^\/c\/[a-zA-Z0-9_-]{8,128}$/.test(url.pathname)) continue;
    const row = link.closest('li,[role="listitem"],[role="option"],[data-testid*="search"]') || link;
    const candidates = String(row.innerText || "").match(/TELA-SAVED-DELETE-TEST:[a-f0-9]{32}/g) || [];
    for (const marker of candidates) {
      if (found.has(url.pathname) && found.get(url.pathname) !== marker) {
        throw Error("Multiple test markers at one search path");
      }
      found.set(url.pathname, marker);
    }
  }
  if (found.size !== 1) return { matchCount: found.size, historyLinkCount: links.length, searchActive: true };
  const [path, exactUserMessage] = [...found.entries()][0];
  return { matchCount: 1, historyLinkCount: links.length, searchActive: true, path, exactUserMessage };
}`;

async function discoverViaOfficialHistorySearch(
  page: BrowserPageAutomation,
  signal: AbortSignal,
): Promise<RecoveryCandidate | undefined> {
  if (page.pressPrimaryShortcut) {
    // Official ChatGPT Search accelerator; avoids a hover-sensitive sidebar
    // button in a hidden owner Electron window. Never re-press after ambiguity.
    await page.pressPrimaryShortcut("k", signal);
  } else {
    const button = await page.evaluate<null, { ready: boolean; reason: string; point?: {x: number; y: number} }>(
      LOCATE_HISTORY_SEARCH_BUTTON, null, signal);
    if (!button.ready || !button.point) {
      emitDiagnosticEvent("chatgpt_tela_work", "saved_cleanup_search_blocked", { reason_class: button.reason });
      return undefined;
    }
    // Older browser host: one unique hit-tested Search button, never Delete.
    await page.pointerClick(button.point, signal);
  }
  let field: {ready:boolean;reason:string;candidateCount?:number;visibleInputCount?:number;
    visibleEditableCount?:number;visibleDialogCount?:number} | undefined;
  for (let attempt=0; attempt<12; attempt++) {
    signal.throwIfAborted();
    field = await page.evaluate<null, NonNullable<typeof field>>(FOCUS_EMPTY_HISTORY_SEARCH, null, signal);
    if (field.ready || field.reason === "existing_search_draft") break;
    if (attempt < 11) await new Promise<void>(resolve => setTimeout(resolve, 250));
  }
  if (!field) throw Error("Search UI inspection returned no result");
  if (!field.ready) {
    emitDiagnosticEvent("chatgpt_tela_work", "saved_cleanup_search_blocked", {
      reason_class: field.reason,
      candidate_count: field.candidateCount ?? 0,
      visible_input_count: field.visibleInputCount ?? 0,
      visible_editable_count: field.visibleEditableCount ?? 0,
      visible_dialog_count: field.visibleDialogCount ?? 0,
    });
    return undefined;
  }
  await page.typeFocusedEditable("TELA-SAVED-DELETE-TEST:", signal);
  for (let attempt=0; attempt<8; attempt++) {
    signal.throwIfAborted();
    const candidate = await page.evaluate<null, RecoveryCandidate & {searchActive:boolean}>(
      FIND_SYNTHETIC_SEARCH_RESULT, null, signal);
    if (!candidate.searchActive) throw Error("Exact synthetic search was not accepted");
    if (candidate.matchCount > 1) throw Error("Multiple synthetic search hits are not safe cleanup targets");
    if (candidate.matchCount === 1) return candidate;
    if (attempt < 7) await new Promise<void>(resolve => setTimeout(resolve, 350));
  }
  emitDiagnosticEvent("chatgpt_tela_work", "saved_cleanup_search_blocked", { reason_class: "no_full_marker_in_official_results" });
  return undefined;
}

/** Delete only a previously submitted synthetic test chat, never Send.
 * The already-open conversation can be used only when its single user bubble
 * exactly equals the 128-bit synthetic marker. Otherwise a home-page sidebar
 * entry with the complete marker may identify one candidate. Never open a
 * personal conversation merely to search for a potential test message.
 */
export async function recoverAndDeleteSyntheticSavedChat(
  surface: BrowserSurfaceLease, signal?: AbortSignal,
): Promise<SyntheticSavedChatRecoveryReceipt> {
  const page = surface.capability(BROWSER_PAGE_AUTOMATION);
  if (!page) throw Error("Owned account browser page automation is unavailable");
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(80_000)]) : AbortSignal.timeout(80_000);
  const driver = new ChatGptDomSurfaceDriver(page);
  const opened = await driver.observe(bounded);
  const origin = new URL(opened.url);
  if (origin.origin !== "https://chatgpt.com"
    || opened.composers.some(c => c.textLength || c.attachmentNames.length || c.connectorFingerprints.length)) {
    throw Error("Existing conversation or personal draft blocks synthetic cleanup discovery");
  }
  let candidate: RecoveryCandidate | undefined;
  if (/^\/c\/[a-zA-Z0-9_-]{8,128}$/.test(origin.pathname) && !origin.search && !origin.hash) {
    // The page currently visible to the owner must prove itself synthetic.
    // If it is a private conversation, fail closed without any navigation.
    candidate = await page.evaluate<null, RecoveryCandidate>(FIND_OPEN_SYNTHETIC_CHAT, null, bounded);
    if (candidate.matchCount !== 1) {
      throw Error("Currently open conversation is not uniquely synthetic; no cleanup permitted");
    }
  } else if (origin.pathname === "/" && opened.turns.length === 0) {
    await surface.navigate(CHATGPT_SAVED_CHAT_URL);
    for (let attempt = 0; attempt < 7; attempt++) {
      bounded.throwIfAborted();
      candidate = await page.evaluate<null, RecoveryCandidate>(FIND_ONE_SYNTHETIC_CHAT, null, bounded);
      if (candidate.matchCount > 1) throw Error("More than one synthetic conversation; no safe target");
      if (candidate.matchCount === 1) break;
      if (attempt < 6) await new Promise<void>(resolve => setTimeout(resolve, 250));
    }
    if (candidate?.matchCount === 0) {
      // The title may be generated by ChatGPT and omit the test marker;
      // official in-product search can match the *message* instead.
      candidate = await discoverViaOfficialHistorySearch(page, bounded);
    }
  } else {
    throw Error("Owner browser must show a strictly synthetic saved conversation or an empty ChatGPT home");
  }
  emitDiagnosticEvent("chatgpt_tela_work", "saved_cleanup_recovery_discovery", {
    unique_synthetic_candidate: candidate?.matchCount === 1,
    bounded_history_links: Math.min(500,candidate?.historyLinkCount ?? 0),
  });
  if (candidate?.matchCount !== 1 || !candidate.path || !candidate.exactUserMessage
    || !/^\/c\/[a-zA-Z0-9_-]{8,128}$/.test(candidate.path)
    || !/^TELA-SAVED-DELETE-TEST:[a-f0-9]{32}$/.test(candidate.exactUserMessage)) {
    throw Error("No unambiguous saved Tela synthetic conversation in this profile's history");
  }
  const target = new URL(candidate.path, "https://chatgpt.com").href;
  if (opened.url !== target) await surface.navigate(target);
  const digest = createHash("sha256").update(candidate.exactUserMessage).digest("base64url");
  let verified = false;
  let sawPersonalContent = false;
  for (let attempt = 0; attempt < 28; attempt++) {
    bounded.throwIfAborted();
    const observed = await driver.observe(bounded);
    const user = observed.turns.filter(turn => turn.role === "user");
    if (observed.url === target && user.length > 1) {
      sawPersonalContent = true;
      break;
    }
    if (observed.url === target && user.length === 1 && user[0]?.contentFingerprint === digest) {
      verified = true;
      break;
    }
    if (attempt < 27) await new Promise<void>(resolve => setTimeout(resolve, 300));
  }
  if (!verified || sawPersonalContent) throw Error("The selected chat was not proven to be the exact synthetic test conversation");
  emitDiagnosticEvent("chatgpt_tela_work", "saved_cleanup_recovery_user_proven", { exact_synthetic_author: true });
  const officialDelete = await deleteOwnedSyntheticSavedChat(surface, {
    path: candidate.path, exactUserMessage: candidate.exactUserMessage,
  }, bounded);
  return Object.freeze({ contractVersion: 1, syntheticConversationProven: true, officialDelete });
}
