import { BROWSER_PAGE_AUTOMATION, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";

/** Content-free, on-demand inspection of the official ChatGPT saved-chat history UI.
 * Never returns chat titles, hrefs, ids, DOM fragments, account data or screenshots.
 * This is a preflight observation, NOT a deletion or proof that deletion is possible.
 */
export interface ChatGptHistoryUiReadiness {
  readonly contractVersion: 1;
  readonly route: "home" | "conversation" | "other";
  readonly historyLinkCount: number;
  readonly visibleHistoryLinkCount: number;
  readonly nearbyActionRowCount: number;
  readonly nearbyMenuRowCount: number;
  readonly visibleMenuCount: number;
  readonly visibleDialogCount: number;
}

const INSPECT_SAVED_HISTORY = String.raw`function () {
  if (location.origin !== "https://chatgpt.com") {
    throw new Error("Saved chat history inspection requires the ChatGPT origin");
  }
  const bounded = number => Math.max(0, Math.min(500, number));
  const visible = element => element instanceof HTMLElement
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
    && element.getClientRects().length > 0;
  const isHistoryLink = link => {
    try {
      const href = new URL(link.getAttribute("href"), location.href);
      return href.origin === location.origin && /^\/c\/[A-Za-z0-9_-]{8,128}$/.test(href.pathname);
    } catch { return false; }
  };
  const history = [...document.querySelectorAll("a[href]")].filter(isHistoryLink).slice(0, 500);
  const menuRows = new Set();
  const actionRows = new Set();
  for (const link of history) {
    // A chat row can render its actions on hover. This checks structure only;
    // do not open a menu in a personal conversation to infer behavior.
    const row = link.closest("li,[role=listitem],[data-testid*=history]") || link.parentElement?.parentElement;
    if (!row) continue;
    const actions = [...row.querySelectorAll('button,[role="button"]')];
    if (actions.length > 0) actionRows.add(link);
    if (actions.some(button => button.getAttribute("aria-haspopup") === "menu"
      || button.getAttribute("data-state") === "closed")) menuRows.add(link);
  }
  return {
    contractVersion: 1,
    route: location.pathname === "/" ? "home"
      : /^\/c\/[A-Za-z0-9_-]{8,128}$/.test(location.pathname) ? "conversation" : "other",
    historyLinkCount: bounded(history.length),
    visibleHistoryLinkCount: bounded(history.filter(visible).length),
    nearbyActionRowCount: bounded(actionRows.size),
    nearbyMenuRowCount: bounded(menuRows.size),
    visibleMenuCount: bounded([...document.querySelectorAll('[role="menu"]')].filter(visible).length),
    visibleDialogCount: bounded([...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible).length),
  };
}`;

export function parseChatGptHistoryUiReadiness(input: unknown): ChatGptHistoryUiReadiness {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("ChatGPT history UI observation must be a compact object");
  }
  const row = input as Record<string, unknown>;
  const keys = ["contractVersion", "route", "historyLinkCount", "visibleHistoryLinkCount",
    "nearbyActionRowCount", "nearbyMenuRowCount", "visibleMenuCount", "visibleDialogCount"];
  if (Object.keys(row).some(key => !keys.includes(key)) || row.contractVersion !== 1
    || !["home", "conversation", "other"].includes(row.route as string)) {
    throw new Error("Unexpected ChatGPT history UI inspection fields");
  }
  for (const key of keys.slice(2)) {
    if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key])
      || (row[key] as number) < 0 || (row[key] as number) > 500) {
      throw new Error("Invalid bounded ChatGPT history UI count");
    }
  }
  if ((row.visibleHistoryLinkCount as number) > (row.historyLinkCount as number)
    || (row.nearbyActionRowCount as number) > (row.historyLinkCount as number)
    || (row.nearbyMenuRowCount as number) > (row.nearbyActionRowCount as number)) {
    throw new Error("Inconsistent ChatGPT history UI inspection counts");
  }
  return Object.freeze({
    contractVersion: 1,
    route: row.route as ChatGptHistoryUiReadiness["route"],
    historyLinkCount: row.historyLinkCount as number,
    visibleHistoryLinkCount: row.visibleHistoryLinkCount as number,
    nearbyActionRowCount: row.nearbyActionRowCount as number,
    nearbyMenuRowCount: row.nearbyMenuRowCount as number,
    visibleMenuCount: row.visibleMenuCount as number,
    visibleDialogCount: row.visibleDialogCount as number,
  });
}

export async function observeChatGptHistoryUi(
  surface: BrowserSurfaceLease, signal?: AbortSignal,
): Promise<ChatGptHistoryUiReadiness> {
  const page = surface.capability(BROWSER_PAGE_AUTOMATION);
  if (!page) throw new Error("Owned account browser lacks official UI inspection capability");
  return parseChatGptHistoryUiReadiness(await page.evaluate(INSPECT_SAVED_HISTORY, null, signal));
}
