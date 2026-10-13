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

test("the actual owner-page predicate permits a duplicate exact href only when one hit-tested official menu row exists", async () => {
  class Element {
    readonly attributes = new Map<string, string>();
    readonly children: Record<string, Element[]> = {};
    readonly x: number;
    readonly textContent: string;
    row?: Element;
    constructor(x = 0, textContent = "") { this.x = x; this.textContent = textContent; }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    getClientRects() { return [1]; }
    getBoundingClientRect() { return { left: this.x, top: 5, width: 10, height: 10 }; }
    contains(other: Element) { return this === other; }
    closest() { return this.row ?? null; }
    querySelectorAll(selector: string): Element[] { return this.children[selector] ?? []; }
  }
  const author = new Element(0, witness.exactUserMessage);
  const bubble = new Element();
  bubble.children['[data-search-result-target]'] = [author];
  const firstLink = new Element(), secondLink = new Element();
  firstLink.attributes.set("href", witness.path);
  secondLink.attributes.set("href", witness.path);
  const firstRow = new Element(), secondRow = new Element();
  firstLink.row = firstRow;
  secondLink.row = secondRow;
  firstRow.children['a[href^="/c/"]'] = [firstLink];
  secondRow.children['a[href^="/c/"]'] = [secondLink];
  const firstMenu = new Element(10), secondMenu = new Element(30);
  firstMenu.attributes.set("aria-haspopup", "menu");
  secondMenu.attributes.set("aria-haspopup", "menu");
  firstRow.children['button,[role="button"]'] = [firstMenu];
  secondRow.children['button,[role="button"]'] = [];
  const document = {
    querySelectorAll(selector: string) {
      if (selector === "a[href]" || selector === 'a[href^="/c/"]') return [firstLink, secondLink];
      if (selector === '[data-user-message-bubble]') return [bubble];
      return [];
    },
    elementFromPoint(x: number) { return x < 30 ? firstMenu : secondMenu; },
  };
  const location = { origin: "https://chatgpt.com", pathname: witness.path,
    href: "https://chatgpt.com" + witness.path };
  const observed = async () => {
    const proofs: Array<{ready: boolean; reason: string; point?: {x: number; y: number};
      visibleExactLinkCount?: number; qualifiedMenuRowCount?: number}> = [];
    const actions: string[] = [];
    const page = {
      async evaluate(source: string, argument: unknown) {
        // Evaluate the actual page predicate with synthetic DOM entities.
        const execute = new Function("argument", "document", "location", "HTMLElement",
          "getComputedStyle", "return (" + source + ")(argument);");
        const proof = execute(argument, document, location, Element,
          () => ({ visibility: "visible", display: "block", opacity: "1" }));
        proofs.push(proof);
        return proof;
      },
      async mutationRevision() { return 0; },
      async waitForDomMutation() { return 1; },
      async pointerClick() { actions.push("first-menu-click"); throw Error("fixture stops before UI mutation"); },
    };
    const surface = { capability(name: unknown) {
      return name === BROWSER_PAGE_AUTOMATION ? page : undefined;
    } } as unknown as BrowserSurfaceLease;
    await expect(deleteOwnedSyntheticSavedChat(surface, witness))
      .rejects.toThrow();
    return { proofs, actions };
  };
  // Identical links do not mean multiple chats. One uniquely actionable row
  // permits one menu click, but a second actionable row fails before clicking.
  const valid = await observed();
  expect(valid.proofs[0]).toEqual({ ready: true,
    reason: "unique_synthetic_history_menu_row", point: { x: 15, y: 10 } });
  expect(valid.actions).toEqual(["first-menu-click"]);
  secondRow.children['button,[role="button"]'] = [secondMenu];
  const ambiguous = await observed();
  expect(ambiguous.proofs[0]).toEqual({ready: false,
    reason: "exact_synthetic_history_menu_row_not_unique",
    visibleExactLinkCount: 2, qualifiedMenuRowCount: 2});
  expect(ambiguous.actions).toEqual([]);
});
