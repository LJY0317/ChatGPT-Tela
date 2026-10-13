import { BROWSER_PAGE_AUTOMATION, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";

/** Only a newly created, unique synthetic ChatGPT test turn may be deleted. The
 * exact path/marker are held privately in this process and never logged or returned.
 * A caller must independently establish that this is its own freshly submitted chat.
 */
export interface SyntheticSavedChatWitness {
  readonly path: string;
  readonly exactUserMessage: string;
}

export interface SyntheticSavedChatDeleteReceipt {
  readonly contractVersion: 1;
  readonly menuOpened: true;
  readonly officialDeleteSelected: true;
  readonly officialConfirmationDispatched: true;
  readonly historyAbsentAfterReload: true;
}

type Step = "menu" | "delete" | "confirm" | "absent";
interface TargetProbe {
  readonly ready: boolean;
  readonly reason: string;
  readonly point?: { readonly x: number; readonly y: number };
  readonly historyLinkCount?: number;
}

const INSPECT_EXACT_TEST_CHAT = String.raw`function (argument) {
  if (location.origin !== "https://chatgpt.com") throw Error("ChatGPT origin required");
  const { path, exactUserMessage, step } = argument;
  if (!/^\/c\/[a-zA-Z0-9_-]{8,128}$/.test(path)
    || !/^TELA-SAVED-DELETE-TEST:[a-f0-9]{32}$/.test(exactUserMessage)
    || !["menu","delete","confirm","absent"].includes(step)) throw Error("Invalid test ownership");
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).opacity !== "0"
    && element.getClientRects().length > 0;
  const normalized = node => String(node?.getAttribute("aria-label") || node?.innerText || "")
    .replace(/\s+/g, " ").trim().toLowerCase();
  const isDelete = label => /^(delete|delete chat|delete conversation|삭제|채팅 삭제|대화 삭제)$/.test(label);
  const isCancel = label => /^(cancel|취소)$/.test(label);
  const point = element => {
    if (!visible(element)) return null;
    const r = element.getBoundingClientRect();
    if (!r.width || !r.height || !Number.isFinite(r.left) || !Number.isFinite(r.top)) return null;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) return null;
    return { x, y };
  };
  const links = [...document.querySelectorAll("a[href]")].filter(link => {
    try { const url = new URL(link.getAttribute("href"), location.href);
      return url.origin === location.origin && url.pathname === path;
    } catch { return false; }
  });
  const allHistory = [...document.querySelectorAll('a[href^="/c/"]')];
  if (step === "absent") {
    if (location.pathname !== "/" || !document.querySelector('[contenteditable="true"]')
      || allHistory.length < 1 || links.length) return { ready: false, reason: "history_not_rehydrated_or_present" };
    return { ready: true, reason: "history_absent_after_navigation", historyLinkCount: Math.min(allHistory.length,500) };
  }
  if (location.pathname !== path || links.length !== 1) return { ready: false, reason: "route_or_link_not_unique" };
  // Only inspect the currently open conversation, never private neighbors in the sidebar.
  const userBubbles = [...document.querySelectorAll('[data-message-author-role="user"]')];
  if (userBubbles.length !== 1
    || String(userBubbles[0].innerText || "").trim() !== exactUserMessage) {
    return { ready: false, reason: "synthetic_message_not_proven" };
  }
  if (step === "menu") {
    if ([...document.querySelectorAll('[role="menu"],[role="dialog"],[role="alertdialog"]')].some(visible)) {
      return { ready: false, reason: "competing_popup" };
    }
    const link = links[0];
    const row = link.closest("li,[role=listitem],[data-testid*=history]") || link.parentElement?.parentElement;
    if (!row || [...row.querySelectorAll('a[href^="/c/"]')].length !== 1) {
      return { ready: false, reason: "history_row_not_unique" };
    }
    const candidates = [...row.querySelectorAll('button,[role="button"]')]
      .filter(button => button.getAttribute("aria-haspopup") === "menu"
        || button.getAttribute("data-state") === "closed"
        || button.getAttribute("data-testid") === "history-item-more-button");
    if (candidates.length !== 1) return { ready: false, reason: "history_menu_not_unique" };
    const target = point(candidates[0]);
    return target ? { ready: true, reason: "exact_synthetic_history_row", point: target }
      : { ready: false, reason: "menu_not_visible_or_hittable" };
  }
  if (step === "delete") {
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(visible);
    if (menus.length !== 1 || [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(visible)) {
      return { ready: false, reason: "menu_not_unique" };
    }
    const options = [...menus[0].querySelectorAll('[role="menuitem"],button')].filter(visible);
    const actions = options.filter(el => isDelete(normalized(el)));
    if (actions.length !== 1) return { ready: false, reason: "delete_action_not_unique" };
    const target = point(actions[0]);
    return target ? { ready: true, reason: "official_delete_menu_item", point: target }
      : { ready: false, reason: "delete_menu_item_unhittable" };
  }
  const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible);
  if (dialogs.length !== 1) return { ready: false, reason: "confirmation_dialog_not_unique" };
  const buttons = [...dialogs[0].querySelectorAll('button,[role="button"]')].filter(visible);
  const destructive = buttons.filter(el => isDelete(normalized(el)));
  const cancel = buttons.filter(el => isCancel(normalized(el)));
  if (destructive.length !== 1 || cancel.length !== 1
    || !/delete|삭제/i.test(String(dialogs[0].innerText || ""))) {
    return { ready: false, reason: "official_delete_dialog_not_proven" };
  }
  const target = point(destructive[0]);
  return target ? { ready: true, reason: "official_delete_confirmation", point: target }
    : { ready: false, reason: "confirmation_unhittable" };
}`;

function validateWitness(witness: SyntheticSavedChatWitness): void {
  if (!/^\/c\/[a-zA-Z0-9_-]{8,128}$/.test(witness.path)
    || !/^TELA-SAVED-DELETE-TEST:[a-f0-9]{32}$/.test(witness.exactUserMessage)) {
    throw new Error("A strictly synthetic exact saved-chat witness is required");
  }
}

/** A deletion operation, not a retryable command. From the first click onward
 * uncertain failures MUST be inspected manually; never repeat a destructive click.
 * The caller must first prove that the marker was minted for a NEW chat in this exact
 * owned session, and that its conversation id was absent in the pre-send baseline.
 */
export async function deleteOwnedSyntheticSavedChat(
  surface: BrowserSurfaceLease,
  witness: SyntheticSavedChatWitness,
  signal?: AbortSignal,
): Promise<SyntheticSavedChatDeleteReceipt> {
  validateWitness(witness);
  const page = surface.capability(BROWSER_PAGE_AUTOMATION);
  if (!page) throw new Error("Official chat UI input is not available in the owned browser");
  const receipt = { contractVersion: 1 as const, menuOpened: false,
    officialDeleteSelected: false, officialConfirmationDispatched: false,
    historyAbsentAfterReload: false };

  // Bounded event-driven waits; do not infer a missing chat from a loading sidebar.
  const observe = async (step: Step): Promise<TargetProbe> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted();
      const before = await page.mutationRevision(signal);
      const row = await page.evaluate<{ path: string; exactUserMessage: string; step: Step }, TargetProbe>(
        INSPECT_EXACT_TEST_CHAT, { ...witness, step }, signal);
      if (row.ready) return row;
      if (attempt === 3) throw new Error("Exact synthetic chat UI proof unavailable: " + row.reason);
      await page.waitForDomMutation(before, AbortSignal.any([
        signal ?? new AbortController().signal, AbortSignal.timeout(4_000),
      ]));
    }
    throw new Error("Synthetic chat UI did not become ready");
  };
  const click = async (step: "menu" | "delete" | "confirm"): Promise<void> => {
    const proof = await observe(step);
    if (!proof.point || !Number.isFinite(proof.point.x) || !Number.isFinite(proof.point.y)) {
      throw new Error("Official test-chat action did not have a unique verified hit target");
    }
    // A click can succeed despite an aborted/failed transport. Never retry the same step.
    await page.pointerClick(proof.point, signal);
  };
  await click("menu");
  receipt.menuOpened = true;
  await click("delete");
  receipt.officialDeleteSelected = true;
  await click("confirm");
  receipt.officialConfirmationDispatched = true;
  // Use an actual owner-bound navigation to force the history UI to rehydrate;
  // disappearance from the optimistic DOM alone is not deletion confirmation.
  await surface.navigate("https://chatgpt.com/");
  const absent = await observe("absent");
  receipt.historyAbsentAfterReload = absent.ready && (absent.historyLinkCount ?? 0) >= 1;
  if (!receipt.historyAbsentAfterReload) throw new Error("Saved test chat absence was not proven after navigation");
  return Object.freeze({
    contractVersion: 1, menuOpened: true, officialDeleteSelected: true,
    officialConfirmationDispatched: true, historyAbsentAfterReload: true,
  });
}
