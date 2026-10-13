import { expect, test } from "bun:test";
import { BROWSER_PAGE_AUTOMATION, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { exerciseSavedChatCreateAndDelete } from "./saved-history-acceptance";

function previousUserContent(url: string, text: string) {
  const events: string[] = [];
  const page = {
    async evaluate(source: string) {
      if (source.includes("inspectApproval(")) {
        return { cardCount: 0, denyCount: 0, allowCount: 0, allowOnceCount: 0,
          alwaysAllowCount: 0, unknownCount: 0, cardKey: null, proofKey: null };
      }
      events.push("read-structure");
      return { url, composers: [{ key: "composer:primary", visible: true, editable: true,
        ownedByChatGptForm: true, text, connectorNames: [], attachmentNames: [] }],
      sendControls: [], turns: [] };
    },
  };
  const surface = {
    capability(capability: unknown) { return capability === BROWSER_PAGE_AUTOMATION ? page : undefined; },
    async navigate() { events.push("navigate"); },
  } as unknown as BrowserSurfaceLease;
  return { surface, events };
}

test("saved chat acceptance never navigates or sends over a pre-existing composer draft", async () => {
  const { surface, events } = previousUserContent("https://chatgpt.com/", "unsent personal draft");
  await expect(exerciseSavedChatCreateAndDelete(surface)).rejects.toThrow("unsent draft");
  expect(events).toEqual(["read-structure"]);
});

test("saved chat acceptance never opens or modifies an existing personal conversation", async () => {
  const { surface, events } = previousUserContent("https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "");
  await expect(exerciseSavedChatCreateAndDelete(surface)).rejects.toThrow("Existing account-browser conversation");
  expect(events).toEqual(["read-structure"]);
});

test("saved chat acceptance requires the owned Electron page capability", async () => {
  const surface = { capability() { return undefined; } } as unknown as BrowserSurfaceLease;
  await expect(exerciseSavedChatCreateAndDelete(surface)).rejects.toThrow("Owned Electron page capability");
});
