import { expect, test } from "bun:test";
import { BROWSER_PAGE_AUTOMATION, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { observeChatGptHistoryUi, parseChatGptHistoryUiReadiness } from "./history-ui";

const safe = Object.freeze({
  contractVersion: 1 as const, route: "home" as const, historyLinkCount: 3,
  visibleHistoryLinkCount: 2, nearbyActionRowCount: 2,
  nearbyMenuRowCount: 1, visibleMenuCount: 0, visibleDialogCount: 0,
});

test("saved history preflight observes the owned browser without clicking, sending or leaking chat data", async () => {
  let called = 0;
  const page = {
    async evaluate(source: string, argument: unknown) {
      called += 1;
      expect(argument).toBeNull();
      expect(source).toContain('location.origin !== "https://chatgpt.com"');
      expect(source).toContain('document.querySelectorAll("a[href]")');
      expect(source).not.toContain("fetch(");
      expect(source).not.toContain(".click(");
      expect(source).not.toContain(".textContent");
      return safe;
    },
  };
  const surface = { capability(capability: unknown) {
    return capability === BROWSER_PAGE_AUTOMATION ? page : undefined;
  } } as BrowserSurfaceLease;
  expect(await observeChatGptHistoryUi(surface)).toEqual(safe);
  expect(called).toBe(1);
});

test("saved history preflight never returns titles, URLs or incompatible counts", () => {
  expect(parseChatGptHistoryUiReadiness(safe)).toEqual(safe);
  expect(() => parseChatGptHistoryUiReadiness({ ...safe, title: "someone's chat" })).toThrow("fields");
  expect(() => parseChatGptHistoryUiReadiness({ ...safe, href: "/c/private-id" })).toThrow("fields");
  expect(() => parseChatGptHistoryUiReadiness({ ...safe, historyLinkCount: 501 })).toThrow("count");
  expect(() => parseChatGptHistoryUiReadiness({ ...safe, visibleHistoryLinkCount: 4 })).toThrow("count");
  expect(() => parseChatGptHistoryUiReadiness({ ...safe, nearbyMenuRowCount: 3 })).toThrow("count");
  expect(() => parseChatGptHistoryUiReadiness({ ...safe, route: "/c/private-id" })).toThrow("fields");
});

test("saved history preflight requires a browser automation capability", async () => {
  const surface = { capability() { return undefined; } } as unknown as BrowserSurfaceLease;
  await expect(observeChatGptHistoryUi(surface)).rejects.toThrow("inspection capability");
});
