import { expect, test } from "bun:test";
import { BROWSER_PAGE_AUTOMATION, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { deleteOwnedSyntheticSavedChat, type SyntheticSavedChatWitness } from "./saved-history-delete";

const witness: SyntheticSavedChatWitness = {
  path: "/c/12345678-1234-1234-1234-123456789abc",
  exactUserMessage: "TELA-SAVED-DELETE-TEST:" + "a".repeat(32),
};

function fixture(options: { failAt?: "menu" | "delete" | "confirm" | "absent"; }
  = {}) {
  const events: string[] = [];
  const stages = ["menu", "delete", "confirm", "absent"];
  let step = 0;
  const page = {
    async evaluate(source: string, argument: { readonly path: string; readonly exactUserMessage: string; readonly step: string }) {
      expect(source).toContain('location.origin !== "https://chatgpt.com"');
      expect(source).not.toContain("fetch(");
      expect(source).not.toContain(".click(");
      expect(argument.path).toBe(witness.path);
      expect(argument.exactUserMessage).toBe(witness.exactUserMessage);
      expect(argument.step).toBe(stages[step]!);
      events.push("prove:" + argument.step);
      if (options.failAt === argument.step) {
        return { ready: false, reason: "unknown_or_changed_real_UI" };
      }
      return { ready: true, reason: "verified", ...(argument.step === "absent"
        ? { historyLinkCount: 2 } : { point: { x: 50, y: 20 } }) };
    },
    async mutationRevision() { return 0; },
    async waitForDomMutation() { throw new Error("no safe DOM proof"); },
    async pointerClick(point: { readonly x: number; readonly y: number }) {
      expect(point).toEqual({ x: 50, y: 20 });
      events.push("trusted-click:" + stages[step]);
      step++;
    },
  };
  const surface = {
    capability(capability: unknown) { return capability === BROWSER_PAGE_AUTOMATION ? page : undefined; },
    async navigate(url: string) {
      expect(url).toBe("https://chatgpt.com/");
      events.push("owner-navigation");
      expect(step).toBe(3);
    },
  } as unknown as BrowserSurfaceLease;
  return { surface, events };
}

test("verified synthetic chat Delete uses exactly three official UI clicks and reloads owner history", async () => {
  const { surface, events } = fixture();
  expect(await deleteOwnedSyntheticSavedChat(surface, witness)).toEqual({
    contractVersion: 1, menuOpened: true, officialDeleteSelected: true,
    officialConfirmationDispatched: true, historyAbsentAfterReload: true,
  });
  expect(events).toEqual(["prove:menu", "trusted-click:menu", "prove:delete",
    "trusted-click:delete", "prove:confirm", "trusted-click:confirm",
    "owner-navigation", "prove:absent"]);
});

for (const failAt of ["menu", "delete", "confirm", "absent"] as const) {
  test("missing exact owner UI proof at " + failAt + " never blindly retries Delete", async () => {
    const { surface, events } = fixture({ failAt });
    await expect(deleteOwnedSyntheticSavedChat(surface, witness)).rejects.toThrow();
    expect(events.filter(event => event === "trusted-click:confirm").length).toBe(failAt === "absent" ? 1 : 0);
    expect(events.filter(event => event === "trusted-click:delete").length).toBe(
      failAt === "menu" || failAt === "delete" ? 0 : 1);
  });
}

test("an ordinary or guessed personal-chat path cannot be used as synthetic ownership", async () => {
  const { surface, events } = fixture();
  await expect(deleteOwnedSyntheticSavedChat(surface, {
    path: "/c/personal-conversation", exactUserMessage: "hello",
  })).rejects.toThrow("strictly synthetic");
  await expect(deleteOwnedSyntheticSavedChat(surface, {
    path: "/c/personal-conversation", exactUserMessage: "TELA-SAVED-DELETE-TEST:short",
  })).rejects.toThrow("strictly synthetic");
  expect(events).toEqual([]);
});
