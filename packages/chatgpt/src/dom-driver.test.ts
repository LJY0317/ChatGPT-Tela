import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  BROWSER_PAGE_AUTOMATION,
  ControlledBrowserHost,
  type BrowserPageAutomation,
} from "@chatgpt-tela/browser-host";
import {
  CHATGPT_CURRENT_COMPOSER_SELECTOR,
  ChatGptDomSurfaceDriver,
} from "./dom-driver";
import { ChatGptSemanticProvider } from "./semantic-provider";

type RawSnapshot = {
  url: string;
  composers: Array<{
    key: string;
    visible: boolean;
    editable: boolean;
    ownedByChatGptForm: boolean;
    text: string;
    connectorNames: string[];
  }>;
  sendControls: Array<{
    key: string;
    composerKey: string;
    visible: boolean;
    enabled: boolean;
    semantic: "send";
  }>;
  turns: Array<Record<string, unknown>>;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

class FakePage implements BrowserPageAutomation {
  raw: RawSnapshot = {
    url: "https://chatgpt.com/",
    composers: [{
      key: "composer:primary",
      visible: true,
      editable: true,
      ownedByChatGptForm: true,
      text: "draft secret",
      connectorNames: [],
    }],
    sendControls: [{
      key: "send:composer:primary",
      composerKey: "composer:primary",
      visible: true,
      enabled: true,
      semantic: "send",
    }],
    turns: [{
      key: "user:t1",
      role: "user",
      contentText: "private user content",
    }],
  };
  readonly mutations: Array<() => void> = [];
  readonly actions: string[] = [];
  lastObserveSource = "";
  pendingConnectorName: string | undefined;
  #mutationRevision = 0;

  async evaluate<Argument, Result>(source: string, argument: Argument): Promise<Result> {
    if (source.includes("return { url: location.href, composers, sendControls, turns }")) {
      this.lastObserveSource = source;
      return structuredClone(this.raw) as Result;
    }
    if (source.includes("ChatGPT composer rejected plain-text insertion")) {
      const input = argument as { composerKey: string; text: string };
      this.actions.push(`fill:${input.composerKey}`);
      this.raw = {
        ...this.raw,
        composers: this.raw.composers.map(composer => composer.key === input.composerKey
          ? { ...composer, text: input.text }
          : composer),
      };
      return undefined as Result;
    }
    if (source.includes("ChatGPT composer rejected appended plain text")) {
      const input = argument as { composerKey: string; text: string };
      this.actions.push(`append:${input.composerKey}`);
      const normalized = input.text.trimStart();
      this.raw = {
        ...this.raw,
        composers: this.raw.composers.map(composer => composer.key === input.composerKey
          ? { ...composer, text: normalized }
          : composer),
      };
      return undefined as Result;
    }
    if (source.includes("ChatGPT connector target lookup timed out")) {
      const input = argument as { composerKey: string; connectorName: string };
      this.actions.push(`connector:${input.connectorName}`);
      const composer = this.raw.composers.find(item => item.key === input.composerKey);
      if (composer?.connectorNames[0] === input.connectorName) return null as Result;
      this.pendingConnectorName = input.connectorName;
      return { x: 25, y: 40 } as Result;
    }
    if (source.includes("ChatGPT connector activation timed out")) {
      const input = argument as { composerKey: string; connectorName: string };
      const composer = this.raw.composers.find(item => item.key === input.composerKey);
      if (composer?.connectorNames[0] !== input.connectorName) {
        throw new Error("fixture connector was not activated");
      }
      return undefined as Result;
    }
    if (source.includes("send.click()")) {
      const input = argument as { controlKey: string };
      this.actions.push(`send:${input.controlKey}`);
      return undefined as Result;
    }
    if (source.includes("composers[0].focus();")) {
      return undefined as Result;
    }
    throw new Error("unexpected fixture page operation");
  }

  async pointerClick(point: { readonly x: number; readonly y: number }): Promise<void> {
    this.actions.push(`pointer:${point.x},${point.y}`);
    const connectorName = this.pendingConnectorName;
    if (!connectorName) throw new Error("fixture has no pending connector target");
    this.raw = {
      ...this.raw,
      composers: this.raw.composers.map(composer => composer.key === "composer:primary"
        ? { ...composer, connectorNames: [connectorName] }
        : composer),
    };
    this.pendingConnectorName = undefined;
  }

  async clearFocusedEditable(): Promise<void> {
    this.actions.push("clear-focused");
    this.raw = {
      ...this.raw,
      composers: this.raw.composers.map(composer => ({ ...composer, text: "", connectorNames: [] })),
    };
  }

  async mutationRevision(): Promise<number> {
    return this.#mutationRevision;
  }

  async waitForDomMutation(afterRevision: number): Promise<number> {
    if (this.#mutationRevision > afterRevision) return this.#mutationRevision;
    const mutation = this.mutations.shift();
    if (!mutation) throw new Error("fixture has no queued DOM mutation");
    mutation();
    this.#mutationRevision += 1;
    return this.#mutationRevision;
  }
}

describe("current ChatGPT DOM surface driver", () => {
  test("recognizes current ChatGPT composer renderer variants without broad page-wide textbox matching", () => {
    expect(CHATGPT_CURRENT_COMPOSER_SELECTOR).toContain('[data-testid="prompt-textarea"]');
    expect(CHATGPT_CURRENT_COMPOSER_SELECTOR).toContain('#prompt-textarea');
    expect(CHATGPT_CURRENT_COMPOSER_SELECTOR).toContain('[data-lexical-editor="true"]');
    expect(CHATGPT_CURRENT_COMPOSER_SELECTOR).toContain('[data-composer-body]');
    expect(CHATGPT_CURRENT_COMPOSER_SELECTOR).not.toContain('[role="textbox"]:not');
  });

  test("projects user/composer text to fingerprints before exposing semantic snapshots", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);
    const snapshot = await driver.observe();

    expect(snapshot.composers[0]).toEqual({
      key: "composer:primary",
      visible: true,
      editable: true,
      ownedByChatGptForm: true,
      textLength: "draft secret".length,
      textFingerprint: digest("draft secret"),
      connectorFingerprints: [],
    });
    expect(snapshot.turns[0]).toEqual({
      key: "user:t1",
      role: "user",
      contentFingerprint: digest("private user content"),
    });
    expect(JSON.stringify(snapshot)).not.toContain("private user content");
    expect(JSON.stringify(snapshot)).not.toContain("draft secret");
  });

  test("assistant answer extraction prioritizes message body over the accessibility role heading", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);
    await driver.observe();

    expect(page.lastObserveSource).toContain(
      "group.querySelector('[data-markdown-text-style=\"assistant-message\"]')",
    );
    expect(page.lastObserveSource).toContain(
      "|| group.querySelector('[data-message-author-role=\"assistant\"] .markdown')",
    );
    expect(page.lastObserveSource).toContain("|| assistant");
    expect(page.lastObserveSource).not.toContain(
      "[data-markdown-text-style=\"assistant-message\"], [data-message-author-role=\"assistant\"] .markdown, [data-conversation-role=\"assistant\"]",
    );
  });

  test("keeps a turn streaming while the current composer still exposes Stop", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);
    await driver.observe();

    expect(page.lastObserveSource).toContain("const stopVisible = composerElements.some");
    expect(page.lastObserveSource).toContain(
      'phase: failure ? "failed" : stopVisible ? "streaming" : complete ? "complete" : "thinking"',
    );
    expect(page.lastObserveSource).toContain(
      "form.querySelectorAll('[data-testid=\"stop-button\"], button[aria-label=\"Stop\"]')",
    );
  });

  test("uses narrow fill/send actions and waits on DOM mutations instead of polling", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);
    const before = await driver.observe();
    await driver.replaceComposerText("composer:primary", "new prompt");
    await driver.activateSend("send:composer:primary");
    expect(page.actions).toEqual([
      "fill:composer:primary",
      "send:send:composer:primary",
    ]);

    const unchanged = structuredClone(page.raw);
    page.mutations.push(() => { page.raw = structuredClone(unchanged); });
    page.mutations.push(() => {
      page.raw = {
        ...page.raw,
        turns: [...page.raw.turns, { key: "assistant:t1", role: "assistant", parentUserTurnKey: "user:t1", phase: "streaming" }],
      };
    });
    const changed = await driver.waitForChange((await driver.observe()).revision);
    expect(changed.turns.at(-1)).toEqual({
      key: "assistant:t1",
      role: "assistant",
      parentUserTurnKey: "user:t1",
      phase: "streaming",
    });
    expect(changed.revision).not.toBe(before.revision);
  });

  test("clears one exact composer through trusted focused keyboard input", async () => {
    const page = new FakePage();
    const driver = new ChatGptDomSurfaceDriver(page);

    await driver.clearComposerText("composer:primary");

    expect(page.actions).toEqual(["clear-focused"]);
    expect(page.raw.composers[0]?.text).toBe("");
  });

  test("connector action is exact-name scoped and prompt append preserves the selected connector identity", async () => {
    const page = new FakePage();
    page.raw.composers[0]!.text = "";
    const driver = new ChatGptDomSurfaceDriver(page);

    await driver.selectConnector("composer:primary", "ChatGPT Tela Development");
    await driver.appendComposerText("composer:primary", " payload");
    const snapshot = await driver.observe();

    expect(page.actions).toEqual([
      "connector:ChatGPT Tela Development",
      "pointer:25,40",
      "append:composer:primary",
    ]);
    expect(snapshot.composers[0]?.connectorFingerprints)
      .toEqual([digest("ChatGPT Tela Development")]);
    expect(snapshot.composers[0]?.textFingerprint).toBe(digest("payload"));
  });

  test("semantic provider can derive its product driver from generic page automation", async () => {
    const page = new FakePage();
    page.raw.composers[0]!.text = "";
    page.raw.turns = [];
    const host = new ControlledBrowserHost(async () => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() {},
      capability(capability) {
        return capability === BROWSER_PAGE_AUTOMATION ? page as never : undefined;
      },
    }));
    const lease = await host.acquire({ taskId: "task-1", epochId: "epoch-1" });
    try {
      const observation = await new ChatGptSemanticProvider().observeCapabilities(lease);
      expect(observation.state).toBe("proven");
    } finally {
      await host.close();
    }
  });
});
