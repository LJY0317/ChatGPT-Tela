import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { ControlledBrowserHost, type BrowserMemoryFile } from "@chatgpt-tela/browser-host";
import { createChatGptContextAttachment } from "./context-attachment";
import {
  CHATGPT_SURFACE_DRIVER,
  type ChatGptSurfaceDriver,
  type ChatGptSurfaceSnapshot,
} from "./surface";
import { ChatGptSemanticProvider } from "./semantic-provider";
import type { WebTurnRequest } from "./index";

function fixture(name: string): ChatGptSurfaceSnapshot {
  const parsed = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as ChatGptSurfaceSnapshot;
  return {
    ...parsed,
    composers: parsed.composers.map(composer => ({
      ...composer,
      connectorFingerprints: composer.connectorFingerprints ?? [],
      attachmentNames: composer.attachmentNames ?? [],
    })),
  };
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

function request(): WebTurnRequest {
  return {
    nativeTaskId: "task-1",
    nativeTurnId: "turn-1",
    webEpochId: "epoch-1",
    physicalContext: {
      headRevisionId: "rev-1",
      activeRequestRevisionId: "rev-1",
      mode: "full",
      logicalTokens: 4,
      transferTokens: 4,
      segments: [{
        type: "revision",
        revisionId: "rev-1",
        kind: "user",
        content: "hello",
      }],
    },
  };
}

function toolRequest(): WebTurnRequest {
  return {
    ...request(),
    toolBridge: {
      protocol: "mcp",
      contract: "development",
      turnCapability: "turn-capability-0123456789abcdef",
    },
  };
}

class FixtureDriver implements ChatGptSurfaceDriver {
  current: ChatGptSurfaceSnapshot;
  readonly queued: ChatGptSurfaceSnapshot[] = [];
  activated: string[] = [];
  connectorSelections: string[] = [];
  appendedTexts: string[] = [];
  corruptReadback = false;
  sendAppearsWhenComposerNonEmpty = false;
  failConnectorSelection = false;
  recoverContextPreload = false;
  autoContextPreload = false;
  attachedFiles: string[] = [];
  contextAcknowledgement: string | undefined;

  constructor(initial: ChatGptSurfaceSnapshot) {
    this.current = structuredClone(initial);
  }

  async observe(): Promise<ChatGptSurfaceSnapshot> {
    return structuredClone(this.current);
  }

  async dismissTransientUi(): Promise<void> {}

  async recoverConnectorArtifact(composerKey: string, connectorName: string): Promise<boolean> {
    const composer = this.current.composers.find(item => item.key === composerKey);
    if (!composer) return false;
    const exactMention = `@${connectorName}`;
    const productMentions = [
      exactMention,
      `${exactMention} ${exactMention}`,
      `${exactMention} ${exactMention} ${exactMention}`,
    ];
    const plain = composer.connectorFingerprints.length === 0
      && productMentions.some(value => (
        composer.textLength === value.length && composer.textFingerprint === hash(value)
      ));
    const selected = composer.textLength === 0
      && composer.connectorFingerprints.length === 1
      && (composer.connectorFingerprints[0] === hash(connectorName)
        || (connectorName === "ChatGPT Tela"
          && composer.connectorFingerprints[0] === hash("ChatGPT Tela Development")));
    if (!plain && !selected) return false;
    await this.clearComposerText(composerKey);
    return true;
  }

  async recoverContextPreloadArtifact(composerKey: string): Promise<boolean> {
    if (!this.recoverContextPreload) return false;
    await this.clearComposerText(composerKey);
    return true;
  }

  async replaceComposerText(composerKey: string, text: string): Promise<void> {
    const composers = this.current.composers.map(composer => composer.key === composerKey
      ? {
          ...composer,
          textLength: text.length,
          textFingerprint: this.corruptReadback ? hash(`${text}!`) : hash(text),
          connectorFingerprints: [],
        }
      : composer);
    let sendControls = this.current.sendControls.map(control => control.composerKey === composerKey
      ? { ...control, enabled: true }
      : control);
    if (this.sendAppearsWhenComposerNonEmpty) {
      sendControls = text.length > 0
        ? [{
            key: "send-readiness-probe",
            composerKey,
            visible: true,
            enabled: true,
            semantic: "send" as const,
          }]
        : [];
    }
    this.current = {
      ...this.current,
      revision: `${this.current.revision}:filled`,
      composers,
      sendControls,
    };
  }

  async clearComposerText(composerKey: string): Promise<void> {
    await this.replaceComposerText(composerKey, "");
  }

  async appendComposerText(composerKey: string, text: string): Promise<void> {
    this.appendedTexts.push(text);
    const normalized = text.trimStart();
    const composers = this.current.composers.map(composer => composer.key === composerKey
      ? {
          ...composer,
          textLength: normalized.length,
          textFingerprint: this.corruptReadback ? hash(`${normalized}!`) : hash(normalized),
        }
      : composer);
    this.current = {
      ...this.current,
      revision: `${this.current.revision}:appended`,
      composers,
      sendControls: this.current.sendControls.map(control => control.composerKey === composerKey
        ? { ...control, enabled: true }
        : control),
    };
  }

  async attachFiles(composerKey: string, files: readonly BrowserMemoryFile[]): Promise<void> {
    this.attachedFiles.push(...files.map(file => file.name));
    for (const file of files) {
      const text = Buffer.from(file.bytes).toString("utf8");
      const match = text.match(/context_receipt: (TELA_CONTEXT_ACK ctxr_[a-f0-9]{32})/);
      if (match) this.contextAcknowledgement = match[1];
    }
    this.current = {
      ...this.current,
      revision: `${this.current.revision}:files`,
      composers: this.current.composers.map(composer => composer.key === composerKey
        ? { ...composer, attachmentNames: files.map(file => file.name) }
        : composer),
      sendControls: this.current.sendControls.map(control => control.composerKey === composerKey
        ? { ...control, enabled: true }
        : control),
    };
  }

  async selectConnector(composerKey: string, connectorName: string): Promise<void> {
    this.connectorSelections.push(connectorName);
    if (this.failConnectorSelection) {
      const mention = `@${connectorName}`;
      this.current = {
        ...this.current,
        revision: `${this.current.revision}:connector-failed`,
        composers: this.current.composers.map(composer => composer.key === composerKey
          ? {
              ...composer,
              textLength: mention.length,
              textFingerprint: hash(mention),
            }
          : composer),
      };
      throw new Error("fixture connector selection failed");
    }
    this.current = {
      ...this.current,
      revision: `${this.current.revision}:connector`,
      composers: this.current.composers.map(composer => composer.key === composerKey
        ? { ...composer, connectorFingerprints: [hash(connectorName)] }
        : composer),
    };
  }

  async activateSend(controlKey: string): Promise<void> {
    this.activated.push(controlKey);
    if (this.autoContextPreload && this.contextAcknowledgement) {
      const userKey = "user:context-preload";
      const accepted: ChatGptSurfaceSnapshot = {
        ...this.current,
        revision: `${this.current.revision}:accepted-preload`,
        composers: this.current.composers.map(composer => {
          const { textFingerprint: _textFingerprint, ...rest } = composer;
          return {
            ...rest,
            textLength: 0,
            connectorFingerprints: [],
            attachmentNames: [],
          };
        }),
        turns: [
          ...this.current.turns,
          { key: userKey, role: "user" },
        ],
      };
      const completed: ChatGptSurfaceSnapshot = {
        ...accepted,
        revision: `${accepted.revision}:assistant-complete`,
        turns: [
          ...accepted.turns,
          {
            key: "assistant:context-preload",
            role: "assistant",
            parentUserTurnKey: userKey,
            phase: "complete",
            text: this.contextAcknowledgement,
          },
        ],
      };
      this.current = structuredClone(accepted);
      this.queued.push(completed);
    }
  }

  async waitForChange(afterRevision: string): Promise<ChatGptSurfaceSnapshot> {
    if (this.current.revision !== afterRevision) return structuredClone(this.current);
    const next = this.queued.shift();
    if (!next) throw new Error("fixture driver has no queued browser change");
    this.current = structuredClone(next);
    return structuredClone(this.current);
  }
}

async function leaseFor(driver: FixtureDriver) {
  const host = new ControlledBrowserHost(async () => ({
    async navigate() {},
    async reveal() {},
    async hide() {},
    async close() {},
    capability(capability) {
      return capability === CHATGPT_SURFACE_DRIVER ? driver as never : undefined;
    },
  }));
  const lease = await host.acquire({ taskId: "task-1", epochId: "epoch-1" });
  return { host, lease };
}

function acceptedSnapshot(
  driver: FixtureDriver,
  userTurnKey = "user-turn-1",
  duplicate = false,
): ChatGptSurfaceSnapshot {
  const composer = driver.current.composers[0]!;
  const match = {
    key: userTurnKey,
    role: "user" as const,
    ...(composer.textFingerprint ? { contentFingerprint: composer.textFingerprint } : {}),
  };
  return {
    ...driver.current,
    revision: "accepted-1",
    turns: duplicate ? [match, { ...match, key: "user-turn-2" }] : [match],
  };
}

describe("ChatGPT semantic provider", () => {
  test("context attachment preload proves exact file-only receipt before execution is authorized", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.autoContextPreload = true;
    const { host, lease } = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({ connectorDraftPersistenceSettleMs: 0 });
    const attachment = createChatGptContextAttachment({
      headRevisionId: "r1",
      activeRequestRevisionId: "r1",
      mode: "full",
      logicalTokens: 4,
      transferTokens: 4,
      segments: [{ type: "revision", revisionId: "r1", kind: "user", content: "hello" }],
    });
    try {
      const result = await provider.preloadContextAttachment(lease, {
        nativeTaskId: "task-1",
        webEpochId: "epoch-1",
        attachment,
      });
      expect(result.state).toBe("proven");
      if (result.state === "proven") {
        expect(result.value).toMatchObject({
          attachmentName: attachment.name,
          attachmentSha256: attachment.sha256,
        });
      }
      expect(driver.attachedFiles).toEqual([attachment.name]);
      expect(driver.contextAcknowledgement).toMatch(/^TELA_CONTEXT_ACK ctxr_[a-f0-9]{32}$/);
      expect(driver.activated).toHaveLength(1);
      expect(driver.current.composers[0]?.attachmentNames).toEqual([]);
    } finally {
      await host.release(lease.leaseId);
      await host.close();
    }
  });

  test("context attachment preload clears only an exact driver-proven stale Tela preload draft before staging", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const staleDraft = "<chatgpt_tela_context_preload>fixture</chatgpt_tela_context_preload>";
    driver.current = {
      ...driver.current,
      composers: driver.current.composers.map(composer => ({
        ...composer,
        textLength: staleDraft.length,
        textFingerprint: hash(staleDraft),
        connectorFingerprints: [],
        attachmentNames: [],
      })),
    };
    driver.recoverContextPreload = true;
    driver.autoContextPreload = true;
    const { host, lease } = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({ connectorDraftPersistenceSettleMs: 0 });
    const attachment = createChatGptContextAttachment({
      headRevisionId: "r1",
      activeRequestRevisionId: "r1",
      mode: "full",
      logicalTokens: 4,
      transferTokens: 4,
      segments: [{ type: "revision", revisionId: "r1", kind: "user", content: "hello" }],
    });
    try {
      const result = await provider.preloadContextAttachment(lease, {
        nativeTaskId: "task-1",
        webEpochId: "epoch-1",
        attachment,
      });
      expect(result.state).toBe("proven");
      expect(driver.attachedFiles).toEqual([attachment.name]);
    } finally {
      await host.release(lease.leaseId);
      await host.close();
    }
  });

  test("proves capabilities only from one owned composer and one matching send control", async () => {
    const ready = new FixtureDriver(fixture("ready-new-chat"));
    const readySurface = await leaseFor(ready);
    const provider = new ChatGptSemanticProvider();
    try {
      const observed = await provider.observeCapabilities(readySurface.lease);
      expect(observed.state).toBe("proven");
      if (observed.state === "proven") {
        expect([...observed.value.observed]).toEqual(["composer", "send"]);
      }
    } finally {
      await readySurface.host.close();
    }

    const ambiguous = new FixtureDriver(fixture("ambiguous-composer"));
    const ambiguousSurface = await leaseFor(ambiguous);
    try {
      const observed = await provider.observeCapabilities(ambiguousSurface.lease);
      expect(observed.state).toBe("ambiguous");
    } finally {
      await ambiguousSurface.host.close();
    }
  });

  test("proves an empty ChatGPT composer whose send control appears only after inert text, then restores it", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.current = {
      ...driver.current,
      composers: driver.current.composers.map(composer => {
        const { textFingerprint: _textFingerprint, ...rest } = composer;
        return { ...rest, textLength: 0 };
      }),
      sendControls: [],
    };
    driver.sendAppearsWhenComposerNonEmpty = true;
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const observed = await provider.observeCapabilities(surface.lease);
      expect(observed.state).toBe("proven");
      if (observed.state === "proven") {
        expect([...observed.value.observed]).toEqual(["composer", "send"]);
      }
      expect(driver.current.composers[0]?.textLength).toBe(0);
      expect(driver.current.sendControls).toEqual([]);
      expect(driver.activated).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("waits on semantic DOM change for a composer that appears after page hydration", async () => {
    const ready = fixture("ready-new-chat");
    const driver = new FixtureDriver({
      ...ready,
      revision: "hydrating",
      composers: [],
      sendControls: [],
    });
    driver.queued.push(ready);
    const surface = await leaseFor(driver);
    try {
      const observed = await new ChatGptSemanticProvider().observeCapabilities(surface.lease);
      expect(observed.state).toBe("proven");
    } finally {
      await surface.host.close();
    }
  });

  test("waits for transient composer text to settle empty before readiness proof", async () => {
    const ready = fixture("ready-new-chat");
    const transient = {
      ...ready,
      revision: "hydrating-text",
      composers: ready.composers.map(composer => ({
        ...composer,
        textLength: 1,
        textFingerprint: hash("\u200b"),
      })),
      sendControls: [],
    };
    const driver = new FixtureDriver(transient);
    driver.queued.push({ ...ready, sendControls: [] });
    driver.sendAppearsWhenComposerNonEmpty = true;
    const surface = await leaseFor(driver);
    try {
      const observed = await new ChatGptSemanticProvider().observeCapabilities(surface.lease);
      expect(observed.state).toBe("proven");
      expect(driver.current.composers[0]?.textLength).toBe(0);
    } finally {
      await surface.host.close();
    }
  });

  test("readiness and submit both refuse a persistent non-empty composer draft", async () => {
    const ready = fixture("ready-new-chat");
    const draft = {
      ...ready,
      composers: ready.composers.map(composer => ({
        ...composer,
        textLength: 5,
        textFingerprint: hash("draft"),
      })),
    };
    const driver = new FixtureDriver(draft);
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const observed = await provider.observeCapabilities(surface.lease);
      expect(observed.state).toBe("probable");
      await expect(provider.submitTurn(surface.lease, request()))
        .rejects.toThrow("refuses to overwrite a non-empty composer draft");
      expect(driver.activated).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("submit proves exact composer readback and exactly one new stable user turn", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));

      const observed = await submitting;
      expect(observed.state).toBe("proven");
      if (observed.state === "proven") {
        expect(observed.value.providerTurnId).toBe("user-turn-1");
      }
      expect(driver.activated).toEqual(["send-main"]);
    } finally {
      await surface.host.close();
    }
  });

  test("tool bridge refuses submission without an explicit ChatGPT connector identity", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    try {
      await expect(new ChatGptSemanticProvider().submitTurn(surface.lease, toolRequest()))
        .rejects.toThrow("requires an explicit connector identity");
      expect(driver.connectorSelections).toEqual([]);
      expect(driver.activated).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("tool bridge selects one exact connector and appends payload without removing its pill", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({ connectorName: "ChatGPT Tela Development" });
    try {
      const submitting = provider.submitTurn(surface.lease, toolRequest());
      while (!driver.current.revision.includes(":appended")) await Promise.resolve();
      expect(driver.current.composers[0]?.connectorFingerprints)
        .toEqual([hash("ChatGPT Tela Development")]);
      expect(driver.appendedTexts).toHaveLength(1);
      expect(driver.appendedTexts[0]).toContain("<chatgpt_tela_transport_contract>");
      expect(driver.appendedTexts[0]).toContain("system context outranks developer context");
      expect(driver.appendedTexts[0]).toContain('"activeRequestRevisionId":"rev-1"');
      expect(driver.appendedTexts[0]).toContain("opaque per-turn routing metadata");
      expect(driver.appendedTexts[0]).toContain("turn-capability-0123456789abcdef");
      expect(driver.appendedTexts[0]).toContain("<chatgpt_tela_transport_resume>");
      driver.queued.push(acceptedSnapshot(driver));

      const observed = await submitting;
      expect(observed.state).toBe("proven");
      expect(driver.connectorSelections).toEqual(["ChatGPT Tela Development"]);
      expect(driver.activated).toEqual(["send-main"]);
    } finally {
      await surface.host.close();
    }
  });

  test("connector preflight proves exact selection without submitting and restores the empty composer", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({
      connectorName: "ChatGPT Tela",
      connectorDraftPersistenceSettleMs: 0,
    });
    try {
      const observed = await provider.probeConnector(surface.lease);
      expect(observed).toEqual({
        connectorName: "ChatGPT Tela",
        connectorFingerprint: hash("ChatGPT Tela"),
        routingMode: "explicit",
      });
      expect(driver.connectorSelections).toEqual(["ChatGPT Tela"]);
      expect(driver.activated).toEqual([]);
      expect(driver.current.composers[0]?.textLength).toBe(0);
      expect(driver.current.composers[0]?.connectorFingerprints).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("connector preflight fails before any send when the connector cannot be selected", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.failConnectorSelection = true;
    const surface = await leaseFor(driver);
    try {
      await expect(new ChatGptSemanticProvider({
        connectorName: "ChatGPT Tela",
        connectorDraftPersistenceSettleMs: 0,
      })
        .probeConnector(surface.lease))
        .rejects.toThrow("fixture connector selection failed");
      expect(driver.activated).toEqual([]);
      expect(driver.current.composers[0]?.textLength).toBe(0);
      expect(driver.current.composers[0]?.connectorFingerprints).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("connector artifact recovery clears only the exact stale Tela mention", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const mention = "@ChatGPT Tela";
    driver.current = {
      ...driver.current,
      composers: driver.current.composers.map(composer => ({
        ...composer,
        textLength: mention.length,
        textFingerprint: hash(mention),
        connectorFingerprints: [],
      })),
    };
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({
      connectorName: "ChatGPT Tela",
      connectorDraftPersistenceSettleMs: 0,
    });
    try {
      expect(await provider.recoverConnectorProbeArtifact(surface.lease)).toBe(true);
      expect(driver.current.composers[0]?.textLength).toBe(0);
      expect(driver.current.composers[0]?.connectorFingerprints).toEqual([]);
      expect(driver.activated).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("connector artifact recovery clears only bounded repeated Tela mention artifacts", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const mention = "@ChatGPT Tela @ChatGPT Tela";
    driver.current = {
      ...driver.current,
      composers: driver.current.composers.map(composer => ({
        ...composer,
        textLength: mention.length,
        textFingerprint: hash(mention),
        connectorFingerprints: [],
      })),
    };
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({
      connectorName: "ChatGPT Tela",
      connectorDraftPersistenceSettleMs: 0,
    });
    try {
      expect(await provider.recoverConnectorProbeArtifact(surface.lease)).toBe(true);
      expect(driver.current.composers[0]?.textLength).toBe(0);
      expect(driver.current.composers[0]?.connectorFingerprints).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("connector artifact recovery clears the legacy Tela Development pill but not foreign connectors", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.current = {
      ...driver.current,
      composers: driver.current.composers.map(composer => ({
        ...composer,
        textLength: 0,
        connectorFingerprints: [hash("ChatGPT Tela Development")],
      })),
    };
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({
      connectorName: "ChatGPT Tela",
      connectorDraftPersistenceSettleMs: 0,
    });
    try {
      expect(await provider.recoverConnectorProbeArtifact(surface.lease)).toBe(true);
      expect(driver.current.composers[0]?.connectorFingerprints).toEqual([]);
      driver.current = {
        ...driver.current,
        composers: driver.current.composers.map(composer => ({
          ...composer,
          connectorFingerprints: [hash("Unrelated Connector")],
        })),
      };
      expect(await provider.recoverConnectorProbeArtifact(surface.lease)).toBe(false);
      expect(driver.current.composers[0]?.connectorFingerprints).toEqual([hash("Unrelated Connector")]);
      expect(await provider.recoverConnectorProbeArtifact(
        surface.lease,
        undefined,
        { allowUnknownSelectedConnector: true },
      )).toBe(true);
      expect(driver.current.composers[0]?.connectorFingerprints).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("startup artifact recovery clears only a driver-proven Tela context preload draft", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const draft = "<chatgpt_tela_context_preload>fixture</chatgpt_tela_context_preload>";
    driver.current = {
      ...driver.current,
      composers: driver.current.composers.map(composer => ({
        ...composer,
        textLength: draft.length,
        textFingerprint: hash(draft),
        connectorFingerprints: [],
        attachmentNames: [],
      })),
    };
    driver.recoverContextPreload = true;
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({
      connectorName: "ChatGPT Tela",
      connectorDraftPersistenceSettleMs: 0,
    });
    try {
      expect(await provider.recoverConnectorProbeArtifact(surface.lease)).toBe(true);
      expect(driver.current.composers[0]?.textLength).toBe(0);
      expect(driver.current.composers[0]?.attachmentNames).toEqual([]);
      expect(driver.activated).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("connector artifact recovery preserves a non-matching user draft", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const draft = "keep this draft";
    driver.current = {
      ...driver.current,
      composers: driver.current.composers.map(composer => ({
        ...composer,
        textLength: draft.length,
        textFingerprint: hash(draft),
        connectorFingerprints: [],
      })),
    };
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({
      connectorName: "ChatGPT Tela",
      connectorDraftPersistenceSettleMs: 0,
    });
    try {
      expect(await provider.recoverConnectorProbeArtifact(surface.lease)).toBe(false);
      expect(driver.current.composers[0]?.textLength).toBe(draft.length);
      expect(driver.current.composers[0]?.textFingerprint).toBe(hash(draft));
    } finally {
      await surface.host.close();
    }
  });

  test("connector preflight preserves an existing unknown attachment instead of guessing ownership", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.current = {
      ...driver.current,
      composers: driver.current.composers.map(composer => ({
        ...composer,
        textLength: 0,
        connectorFingerprints: [],
        attachmentNames: ["user-document.txt"],
      })),
    };
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({
      connectorName: "ChatGPT Tela",
      connectorDraftPersistenceSettleMs: 0,
    });
    try {
      await expect(provider.probeConnector(surface.lease)).rejects.toThrow(
        "existing attachment; Tela preserved it instead of guessing ownership",
      );
      expect(driver.current.composers[0]?.attachmentNames).toEqual(["user-document.txt"]);
      expect(driver.activated).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("connector selection failure restores the empty composer before send activation", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.failConnectorSelection = true;
    const surface = await leaseFor(driver);
    try {
      await expect(new ChatGptSemanticProvider({ connectorName: "ChatGPT Tela Development" })
        .submitTurn(surface.lease, toolRequest()))
        .rejects.toThrow("fixture connector selection failed");
      expect(driver.activated).toEqual([]);
      expect(driver.current.composers[0]?.textLength).toBe(0);
      expect(driver.current.composers[0]?.connectorFingerprints).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("tool payload readback failure cleans the selected connector and draft before returning probable", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.corruptReadback = true;
    const surface = await leaseFor(driver);
    try {
      const observed = await new ChatGptSemanticProvider({ connectorName: "ChatGPT Tela Development" })
        .submitTurn(surface.lease, toolRequest());
      expect(observed.state).toBe("probable");
      expect(driver.activated).toEqual([]);
      expect(driver.current.composers[0]?.textLength).toBe(0);
      expect(driver.current.composers[0]?.connectorFingerprints).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("tool-free submission refuses a connector retained from browser state", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.current = {
      ...driver.current,
      composers: driver.current.composers.map(composer => ({
        ...composer,
        connectorFingerprints: [hash("Some Connector")],
      })),
    };
    const surface = await leaseFor(driver);
    try {
      await expect(new ChatGptSemanticProvider().submitTurn(surface.lease, request()))
        .rejects.toThrow("tool-free ChatGPT semantic submit refuses a selected connector");
      expect(driver.activated).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("submit accepts one new stable user turn even when ChatGPT renderer normalizes its displayed text", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      const accepted = acceptedSnapshot(driver);
      driver.queued.push({
        ...accepted,
        turns: accepted.turns.map(turn => turn.role === "user"
          ? { ...turn, contentFingerprint: hash("renderer-normalized") }
          : turn),
      });

      const observed = await submitting;
      expect(observed.state).toBe("proven");
      if (observed.state === "proven") {
        expect(observed.value.providerTurnId).toBe("user-turn-1");
        expect(observed.evidence).toEqual([
          "one new stable user turn acknowledges the exact pre-send composer readback and send activation",
        ]);
      }
      expect(driver.activated).toEqual(["send-main"]);
    } finally {
      await surface.host.close();
    }
  });

  test("accepted turn survives ChatGPT provisional-key hydration without changing provider identity", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver, "provisional-user-turn"));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("expected proven submit fixture");

      driver.queued.push({
        ...driver.current,
        revision: "hydrated-complete",
        turns: [{
          key: "assistant-stable",
          role: "assistant",
          parentUserTurnKey: "stable-user-turn",
          phase: "complete",
          text: "hydrated-final",
        }],
      });
      const completed = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(completed).toEqual({
        state: "proven",
        value: {
          kind: "completed",
          providerTurnId: "provisional-user-turn",
          answer: "hydrated-final",
        },
        evidence: ["one assistant descendant reached complete state"],
      });
    } finally {
      await surface.host.close();
    }
  });

  test("renderer rekey fails closed when more than one new assistant lineage appears", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver, "provisional-user-turn"));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("expected proven submit fixture");

      driver.queued.push({
        ...driver.current,
        revision: "ambiguous-hydration",
        turns: [
          { key: "assistant-a", role: "assistant", parentUserTurnKey: "stable-user-a", phase: "thinking" },
          { key: "assistant-b", role: "assistant", parentUserTurnKey: "stable-user-b", phase: "thinking" },
        ],
      });
      const observed = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(observed.state).toBe("ambiguous");
      if (observed.state === "ambiguous") expect(observed.candidates).toHaveLength(2);
    } finally {
      await surface.host.close();
    }
  });

  test("submit allows ChatGPT to create its send control only after exact payload fill", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.current = { ...driver.current, sendControls: [] };
    driver.sendAppearsWhenComposerNonEmpty = true;
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const observed = await submitting;
      expect(observed.state).toBe("proven");
      expect(driver.activated).toEqual(["send-readiness-probe"]);
    } finally {
      await surface.host.close();
    }
  });

  test("composer readback mismatch does not activate send", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.corruptReadback = true;
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const observed = await provider.submitTurn(surface.lease, request());
      expect(observed.state).toBe("probable");
      expect(driver.activated).toEqual([]);
    } finally {
      await surface.host.close();
    }
  });

  test("duplicate new user turns make submission ambiguous instead of guessing", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver, "user-turn-1", true));

      const observed = await submitting;
      expect(observed.state).toBe("ambiguous");
      if (observed.state === "ambiguous") expect(observed.candidates).toHaveLength(2);
    } finally {
      await surface.host.close();
    }
  });

  test("exact MCP result handoff must be armed before post-tool continuation is proven", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("expected proven submit fixture");

      const armed = await provider.armToolContinuation(surface.lease, submitted.value, "call-1");
      expect(armed).toEqual({
        state: "proven",
        value: { providerTurnId: "user-turn-1", callId: "call-1" },
        evidence: ["captured exact assistant state before MCP result handoff"],
      });
      driver.queued.push({
        ...driver.current,
        revision: "continued",
        turns: [
          ...driver.current.turns,
          { key: "assistant-1", role: "assistant", parentUserTurnKey: "user-turn-1", phase: "streaming" },
        ],
      });

      const continuing = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(continuing).toEqual({
        state: "proven",
        value: { kind: "continuing", providerTurnId: "user-turn-1" },
        evidence: ["assistant state changed after exact MCP result handoff for call-1"],
      });

      driver.queued.push({
        ...driver.current,
        revision: "complete",
        turns: [
          ...driver.current.turns.filter(turn => turn.role !== "assistant"),
          {
            key: "assistant-1",
            role: "assistant",
            parentUserTurnKey: "user-turn-1",
            phase: "complete",
            text: "finished",
          },
        ],
      });
      const completed = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(completed.state).toBe("proven");
      if (completed.state === "proven") {
        expect(completed.value).toEqual({
          kind: "completed",
          providerTurnId: "user-turn-1",
          answer: "finished",
        });
      }
    } finally {
      await surface.host.close();
    }
  });

  test("tool continuation rebinds a hydrated renderer key before arming the Native result", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver, "provisional-user-turn"));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("expected proven submit fixture");

      driver.current = {
        ...driver.current,
        revision: "hydrated-tool-wait",
        turns: [{
          key: "assistant-stable",
          role: "assistant",
          parentUserTurnKey: "stable-user-turn",
          phase: "tool-wait",
        }],
      };
      const armed = await provider.armToolContinuation(surface.lease, submitted.value, "call-rekeyed");
      expect(armed).toEqual({
        state: "proven",
        value: { providerTurnId: "provisional-user-turn", callId: "call-rekeyed" },
        evidence: ["captured exact assistant state before MCP result handoff"],
      });

      driver.queued.push({
        ...driver.current,
        revision: "hydrated-complete",
        turns: [{
          key: "assistant-stable",
          role: "assistant",
          parentUserTurnKey: "stable-user-turn",
          phase: "complete",
          text: "finished-after-rekey",
        }],
      });
      const continuing = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(continuing.state).toBe("proven");
      if (continuing.state === "proven") expect(continuing.value.kind).toBe("continuing");

      const completed = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(completed).toEqual({
        state: "proven",
        value: {
          kind: "completed",
          providerTurnId: "provisional-user-turn",
          answer: "finished-after-rekey",
        },
        evidence: ["assistant completion followed a proven post-tool continuation boundary"],
      });
    } finally {
      await surface.host.close();
    }
  });

  test("cannot arm a tool result after the assistant already completed", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("expected proven submit fixture");
      driver.current = {
        ...driver.current,
        revision: "already-complete",
        turns: [
          ...driver.current.turns,
          {
            key: "assistant-1",
            role: "assistant",
            parentUserTurnKey: "user-turn-1",
            phase: "complete",
            text: "too early",
          },
        ],
      };

      const armed = await provider.armToolContinuation(surface.lease, submitted.value, "call-1");
      expect(armed.state).toBe("probable");
    } finally {
      await surface.host.close();
    }
  });
});
