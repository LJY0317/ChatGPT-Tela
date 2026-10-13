import { createHash, randomBytes } from "node:crypto";
import { BROWSER_PAGE_AUTOMATION, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { ChatGptDomSurfaceDriver } from "./dom-driver";
import { deleteOwnedSyntheticSavedChat, type SyntheticSavedChatDeleteReceipt } from "./saved-history-delete";
import { CHATGPT_SAVED_CHAT_URL } from "./session";
import type { ChatGptSurfaceSnapshot } from "./surface";

export interface SavedChatCleanupAcceptanceReceipt {
  readonly contractVersion: 1;
  readonly newlyAccepted: true;
  readonly modelReplyCompleted: boolean;
  readonly officialDelete: SyntheticSavedChatDeleteReceipt;
}

const HISTORY_BASELINE = String.raw`async function (salt) {
  if (location.origin !== "https://chatgpt.com" || location.pathname !== "/" || location.search)
    throw Error("Saved ChatGPT home document is required");
  const links = [...document.querySelectorAll('a[href^="/c/"]')];
  if (links.length > 500) throw Error("Sidebar history exceeds bounded ownership baseline");
  const digests = [];
  for (const link of links) {
    const path = new URL(link.getAttribute("href"), location.href).pathname;
    if (!/^\/c\/[A-Za-z0-9_-]{8,128}$/.test(path)) continue;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + path));
    digests.push(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,"0")).join(""));
  }
  return digests;
}`;

const savedChatRoute = (urlString: string): string | undefined => {
  try {
    const url = new URL(urlString);
    if (url.origin !== "https://chatgpt.com" || url.search || url.hash
      || !/^\/c\/[A-Za-z0-9_-]{8,128}$/.test(url.pathname)) return undefined;
    return url.pathname;
  } catch { return undefined; }
};

/**
 * An explicit ONE-SHOT experiment performed only in the currently owned
 * account-browser lease. It creates one random synthetic saved ChatGPT chat
 * on the official UI, proves an exact new user turn, and attempts official UI
 * deletion. It never reads a pre-existing conversation or resubmits a send.
 *
 * Failure after Send may leave exactly one test conversation. The caller MUST
 * keep the account browser open for correct-profile manual cleanup, and must
 * never retry this command automatically.
 */
export async function exerciseSavedChatCreateAndDelete(
  surface: BrowserSurfaceLease, signal?: AbortSignal,
): Promise<SavedChatCleanupAcceptanceReceipt> {
  const page = surface.capability(BROWSER_PAGE_AUTOMATION);
  if (!page) throw new Error("Owned Electron page capability is unavailable for saved-chat acceptance");
  const driver = new ChatGptDomSurfaceDriver(page);
  const marker = `TELA-SAVED-DELETE-TEST:${randomBytes(16).toString("hex")}`;
  const markerDigest = createHash("sha256").update(marker).digest("base64url");
  const baselineSalt = randomBytes(16).toString("hex");
  const deadline = AbortSignal.timeout(90_000);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const stage = (phase: string): void => emitDiagnosticEvent("chatgpt_tela_work",
    "saved_delete_acceptance_phase", { phase });

  stage("inspect_start_surface");
  const alreadyOpen = await driver.observe(bounded);
  const initial = new URL(alreadyOpen.url);
  if (initial.origin !== "https://chatgpt.com" || initial.pathname !== "/"
    || alreadyOpen.turns.length !== 0
    || alreadyOpen.composers.some(c => c.textLength || c.attachmentNames.length || c.connectorFingerprints.length)) {
    throw new Error("Existing account-browser conversation or unsent draft must not be changed");
  }
  stage("navigate_saved_home");
  // Even if the Work browser used the standard Temporary Chat URL, this
  // explicit test alone navigates to the normal saved ChatGPT home.
  await surface.navigate(CHATGPT_SAVED_CHAT_URL);
  stage("observe_saved_home");
  let home: ChatGptSurfaceSnapshot | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    bounded.throwIfAborted();
    home = await driver.observe(bounded);
    if (home.url === CHATGPT_SAVED_CHAT_URL && home.turns.length === 0
      && home.composers.length === 1 && home.composers[0]!.editable
      && home.composers[0]!.ownedByChatGptForm) break;
    const rev = await page.mutationRevision(bounded);
    await page.waitForDomMutation(rev, bounded);
  }
  if (!home || home.url !== CHATGPT_SAVED_CHAT_URL || home.turns.length
    || home.composers.length !== 1) throw new Error("New saved ChatGPT composer was not proven");
  const composer = home.composers[0]!;
  if (composer.textLength || composer.attachmentNames.length || composer.connectorFingerprints.length) {
    throw new Error("Saved ChatGPT composer is not empty");
  }
  stage("read_history_baseline");
  const historyHashes = await page.evaluate<string, string[]>(HISTORY_BASELINE, baselineSalt, bounded);
  if (!Array.isArray(historyHashes) || historyHashes.length > 500
    || historyHashes.some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("Prior saved-chat history inventory could not be bounded");
  }

  // All preparatory work above is non-sending. Do not retry Send after this
  // exact activation boundary, even if the browser returns an error.
  stage("prepare_test_message");
  // Experimental saved-chat input uses *trusted* Electron keyboard events
  // rather than execCommand; ordinary Tela Work composer behavior is unchanged.
  await driver.focusComposer(composer.key, bounded);
  await page.typeFocusedEditable(marker, bounded);
  stage("composer_trusted_input_returned");
  let filled = await driver.observe(bounded);
  stage("composer_dom_readback_completed");
  let expected = filled.composers.filter(c => c.key === composer.key && c.visible && c.editable
    && c.ownedByChatGptForm && c.textLength === marker.length && c.textFingerprint === markerDigest
    && c.attachmentNames.length === 0 && c.connectorFingerprints.length === 0);
  let controls = filled.sendControls.filter(s => s.composerKey === composer.key && s.visible && s.enabled);
  if (expected.length !== 1 || controls.length !== 1) {
    emitDiagnosticEvent("chatgpt_tela_work", "saved_delete_composer_rejected", {
      exact_text_proven: expected.length === 1,
      matching_composer_count: expected.length,
      enabled_send_count: controls.length,
      observed_composer_count: filled.composers.length,
    });
    // Preserve unrelated drafts. This exact synthetic marker was prepared
    // by us in the same lease and can be cleared when not submitted.
    if (expected.length === 1) await driver.clearComposerText(composer.key, bounded);
    throw new Error("Exact synthetic saved-chat send control could not be proven");
  }
  stage("activate_send_once");
  await driver.activateSend(controls[0]!.key, bounded);
  stage("observe_new_test_user");
  let acceptedPath: string | undefined;
  let modelReplyCompleted = false;
  let replyDeadline: AbortSignal | undefined;
  let previous = filled.revision;
  for (;;) {
    bounded.throwIfAborted();
    const observing = replyDeadline ? AbortSignal.any([bounded, replyDeadline]) : bounded;
    let seen: ChatGptSurfaceSnapshot;
    try {
      seen = await driver.waitForChange(previous, observing);
    } catch (error) {
      // A model can be slow or unavailable. Once we have already proven the
      // *new* saved test user turn and exact route, prioritize deleting it.
      if (acceptedPath && replyDeadline?.aborted && !bounded.aborted) break;
      throw error;
    }
    previous = seen.revision;
    const userTurns = seen.turns.filter(t => t.role === "user");
    if (userTurns.length > 1) throw new Error("Unexpected extra user turn after test send");
    const path = savedChatRoute(seen.url);
    if (path && userTurns.length === 1 && userTurns[0]!.contentFingerprint === markerDigest) {
      if (historyHashes.includes(createHash("sha256").update(baselineSalt + path).digest("hex"))) {
        throw new Error("New synthetic test route was present before the send");
      }
      acceptedPath = path;
      stage("new_user_and_route_proven");
      replyDeadline ??= AbortSignal.timeout(20_000);
      modelReplyCompleted = seen.turns.some(t => t.role === "assistant" && t.phase === "complete");
      if (modelReplyCompleted || seen.turns.some(t => t.role === "assistant" && t.phase === "failed")) break;
    }
  }
  if (!acceptedPath) throw new Error("The new saved chat identity was not proven after Send");
  stage("official_ui_delete_start");
  // The only trusted deletion authority is the freshly submitted marker,
  // matching the exact new conversation path on the SAME owner surface.
  const officialDelete = await deleteOwnedSyntheticSavedChat(surface, {
    path: acceptedPath, exactUserMessage: marker,
  }, bounded);
  stage("official_ui_delete_absence_proven");
  return Object.freeze({ contractVersion: 1, newlyAccepted: true,
    modelReplyCompleted, officialDelete });
}
