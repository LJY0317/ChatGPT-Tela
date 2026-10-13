import { expect, test } from "bun:test";
import { BROWSER_PAGE_AUTOMATION, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { recoverAndDeleteSyntheticSavedChat } from "./saved-history-recovery";

const marker = "TELA-SAVED-DELETE-TEST:" + "c".repeat(32);
const path = "/c/12345678-1234-1234-1234-123456789abc";
const origin = "https://chatgpt.com";

function mockHistory(options: {
  initialUrl?: string; candidateCount?: number; currentUser?: string;
  searchCandidate?: boolean; noSearchButton?: boolean;
} = {}) {
  let currentUrl = options.initialUrl ?? origin + "/";
  let step = 0;
  const actions: string[] = [];
  const page = {
    async evaluate(source: string, argument: unknown) {
      if (source.includes("inspectApproval(")) {
        return { cardCount: 0, denyCount: 0, allowCount: 0, allowOnceCount: 0,
          alwaysAllowCount: 0, unknownCount: 0, cardKey: null, proofKey: null };
      }
      if (source.includes("const requestPayload =")) {
        return {
          url: currentUrl,
          composers: [{ key: "composer:primary", visible: true, editable: true,
            ownedByChatGptForm: true, text: "", connectorNames: [], attachmentNames: [] }],
          sendControls: [],
          turns: currentUrl.endsWith(path) ? [{ key: "user:new", role: "user",
            contentText: options.currentUser ?? marker, userPayloadReason: "author_payload" }] : [],
        };
      }
      if (source.includes("const inputs = [...document.querySelectorAll")) {
        return options.searchCandidate === false
          ? { matchCount: 0, historyLinkCount: 2, searchActive: true }
          : { matchCount: 1, historyLinkCount: 2, searchActive: true, path, exactUserMessage: marker };
      }
      if (source.includes("const found = new Map()")) {
        expect(currentUrl).toBe(origin + "/");
        return options.candidateCount === 2
          ? { matchCount: 2, historyLinkCount: 3 }
          : options.candidateCount === 0
            ? { matchCount: 0, historyLinkCount: 3 }
            : { matchCount: 1, historyLinkCount: 3, path, exactUserMessage: marker };
      }
      if (source.includes('const options = [...document.querySelectorAll(\'button,[role="button"],a\')')) {
        return options.noSearchButton
          ? { ready: false, reason: "search_button_not_unique" }
          : { ready: true, reason: "official_search_button", point: { x: 60, y: 10 } };
      }
      if (source.includes('const options = [...document.querySelectorAll(\'input,[role="searchbox"]\')')) {
        return { ready: true, reason: "official_search_input_focus" };
      }
      if (source.includes("const authorRoots = [...userBubbles[0]")) {
        return currentUrl !== origin + path
          || (options.currentUser && options.currentUser !== marker)
          ? { matchCount: 0, historyLinkCount: 3 }
          : { matchCount: 1, historyLinkCount: 3, path, exactUserMessage: marker };
      }
      if (source.includes("const { path, exactUserMessage, step }")) {
        const arg = argument as { path: string; exactUserMessage: string; step: string };
        expect(arg.path).toBe(path);
        expect(arg.exactUserMessage).toBe(marker);
        if (arg.step === "absent") {
          expect(currentUrl).toBe(origin + "/");
          return { ready: true, reason: "absent", historyLinkCount: 2 };
        }
        expect(arg.step).toBe(["menu", "delete", "confirm"][step]!);
        return { ready: true, reason: "exact_synthetic", point: { x: 15, y: 25 } };
      }
      throw Error("No other page action permitted in synthetic cleanup fixture");
    },
    async pointerClick(point: { x: number; y: number }) {
      if (point.x === 60 && point.y === 10) {
        actions.push("official-search");
        return;
      }
      expect(point).toEqual({ x: 15, y: 25 });
      actions.push(["menu", "delete", "confirm"][step]!);
      step++;
    },
    async mutationRevision() { return 0; },
    async waitForDomMutation() { return 1; },
    async typeFocusedEditable(text: string) {
      expect(text).toBe("TELA-SAVED-DELETE-TEST:");
      actions.push("synthetic-search-query");
    },
  };
  const surface = {
    capability(name: unknown) { return name === BROWSER_PAGE_AUTOMATION ? page : undefined; },
    async navigate(url: string) { actions.push("navigate:" + (url === origin + "/" ? "home" : "synthetic")); currentUrl = url; },
  } as unknown as BrowserSurfaceLease;
  return { surface, actions };
}

test("recover one uniquely proven synthetic saved conversation and only click its official UI controls", async () => {
  const { surface, actions } = mockHistory();
  const receipt = await recoverAndDeleteSyntheticSavedChat(surface);
  expect(receipt).toEqual({
    contractVersion: 1, syntheticConversationProven: true,
    officialDelete: { contractVersion: 1, menuOpened: true,
      officialDeleteSelected: true, officialConfirmationDispatched: true,
      historyAbsentAfterReload: true },
  });
  expect(actions).toEqual(["navigate:home", "navigate:synthetic",
    "menu", "delete", "confirm", "navigate:home"]);
});

test("recover a still-open exact synthetic conversation without assuming that its auto-title contains the marker", async () => {
  const { surface, actions } = mockHistory({ initialUrl: origin + path });
  const done = await recoverAndDeleteSyntheticSavedChat(surface);
  expect(done.syntheticConversationProven).toBe(true);
  expect(done.officialDelete.historyAbsentAfterReload).toBe(true);
  expect(actions).toEqual(["menu", "delete", "confirm", "navigate:home"]);
});

test("official in-product Search can locate the exact marked message without a matching auto-title", async () => {
  const { surface, actions } = mockHistory({ candidateCount: 0 });
  const recovered = await recoverAndDeleteSyntheticSavedChat(surface);
  expect(recovered.officialDelete.historyAbsentAfterReload).toBe(true);
  expect(actions).toEqual([
    "navigate:home", "official-search", "synthetic-search-query",
    "navigate:synthetic", "menu", "delete", "confirm", "navigate:home",
  ]);
});

test("missing unique official Search UI permits no opening or deleting a personal conversation", async () => {
  const { surface, actions } = mockHistory({ candidateCount: 0, noSearchButton: true });
  await expect(recoverAndDeleteSyntheticSavedChat(surface)).rejects.toThrow("No unambiguous saved Tela synthetic");
  expect(actions).toEqual(["navigate:home"]);
});

test("a currently open personal chat cannot be used as a synthetic cleanup witness", async () => {
  const { surface, actions } = mockHistory({
    initialUrl: origin + path, currentUser: "An unrelated personal message",
  });
  await expect(recoverAndDeleteSyntheticSavedChat(surface)).rejects.toThrow("not uniquely synthetic");
  expect(actions).toEqual([]);
});

test("cleanup does not open or modify a personal chat that was already open", async () => {
  const { surface, actions } = mockHistory({ initialUrl: origin + "/c/personal-chat" });
  await expect(recoverAndDeleteSyntheticSavedChat(surface)).rejects.toThrow("not uniquely synthetic");
  expect(actions).toEqual([]);
});

test("cleanup never inspects a private chat when more than one synthetic title matches", async () => {
  const { surface, actions } = mockHistory({ candidateCount: 2 });
  await expect(recoverAndDeleteSyntheticSavedChat(surface)).rejects.toThrow("More than one synthetic");
  expect(actions).toEqual(["navigate:home"]);
});

test("a synthetic title without a matching exact user message authorizes no Delete click", async () => {
  const { surface, actions } = mockHistory({ currentUser: "unrelated personal message" });
  await expect(recoverAndDeleteSyntheticSavedChat(surface, AbortSignal.timeout(350))).rejects.toThrow();
  expect(actions).toEqual(["navigate:home", "navigate:synthetic"]);
});
