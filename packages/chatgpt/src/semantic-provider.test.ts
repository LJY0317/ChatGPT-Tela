import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { ControlledBrowserHost, type BrowserMemoryFile } from "@chatgpt-tela/browser-host";
import { nativeEvidenceRef, setPrivateDiagnosticCapture } from "@chatgpt-tela/core";
import { createChatGptContextAttachment } from "./context-attachment";
import {
  CHATGPT_SURFACE_DRIVER,
  ChatGptConnectorCatalogUnavailableError,
  type ChatGptSurfaceDriver,
  type ChatGptSurfaceSnapshot,
} from "./surface";
import { ChatGptSemanticProvider } from "./semantic-provider";
import { webEvidenceFilename } from "./turn-media";
import { CHATGPT_TEMPORARY_CHAT_URL } from "./session";
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

const recognizedApproval = { cardCount: 1, denyCount: 1, allowCount: 0, allowOnceCount: 1,
  alwaysAllowCount: 0, unknownCount: 0, revisionFingerprint: "approval-proof",
  cardFingerprint: "a".repeat(24), inputReceived: false };

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
  normalizeAttachmentLabelAfterAttach = false;
  attachedFiles: string[] = [];
  contextAcknowledgement: string | undefined;
  contextReplyOverride: string | undefined;
  escapeContextReceiptMarkdown = false;
  contextPlainReplyOverride: string | undefined;
  omitContextPlainFingerprint = false;
  connectorCatalogUnavailable = false;
  approvalCalls = 0;
  approvalDelays: number[] = [];
  approveRecognizedCard = false;

  constructor(initial: ChatGptSurfaceSnapshot) {
    this.current = structuredClone(initial);
  }

  // Synthetic bodies in this state-machine fixture have no DOM. DOM/body integration is tested separately.
  private observation(): ChatGptSurfaceSnapshot {
    const snapshot = structuredClone(this.current);
    return { ...snapshot, turns: snapshot.turns.map(turn => turn.role === "assistant" && turn.bodyProof === undefined && turn.text !== undefined
      ? { ...turn, bodyProof: { version: 1, digest: turn.contentFingerprint ?? hash(turn.text) } } : turn) };
  }

  async observe(): Promise<ChatGptSurfaceSnapshot> {
    return this.observation();
  }

  async dismissTransientUi(): Promise<void> {}

  async processApprovalCard(_mode: unknown, _signal?: AbortSignal, delayMs = 0, expected?: { cardFingerprint: string; revisionFingerprint: string }): ReturnType<NonNullable<ChatGptSurfaceDriver["processApprovalCard"]>> {
    this.approvalCalls += 1;
    this.approvalDelays.push(delayMs);
    return this.approveRecognizedCard
      ? { status: "dispatched", reason: "allow_once", cardFingerprint: expected!.cardFingerprint }
      : { status: "none", reason: "absent" };
  }

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
        ? { ...composer, attachmentNames: this.normalizeAttachmentLabelAfterAttach ? ["attachment"] : files.map(file => file.name) }
        : composer),
      sendControls: this.current.sendControls.map(control => control.composerKey === composerKey
        ? { ...control, enabled: true }
        : control),
    };
  }

  async selectConnector(composerKey: string, connectorName: string): Promise<void> {
    this.connectorSelections.push(connectorName);
    if (this.connectorCatalogUnavailable) {
      throw new ChatGptConnectorCatalogUnavailableError();
    }
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
            text: this.contextReplyOverride ?? (this.escapeContextReceiptMarkdown
              ? this.contextAcknowledgement.replaceAll("_", "\\_") : this.contextAcknowledgement),
            ...(!this.omitContextPlainFingerprint ? {
              plainBodyFingerprint: hash(this.contextPlainReplyOverride ?? this.contextReplyOverride ?? this.contextAcknowledgement),
            } : {}),
          },
        ],
      };
      this.current = structuredClone(accepted);
      this.queued.push(completed);
    }
  }

  async waitForChange(afterRevision: string): Promise<ChatGptSurfaceSnapshot> {
    if (this.current.revision !== afterRevision) return this.observation();
    const next = this.queued.shift();
    if (!next) throw new Error("fixture driver has no queued browser change");
    this.current = structuredClone(next);
    return this.observation();
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

describe("terminal assistant tool handoff", () => {
  for (const phase of ["complete", "failed"] as const) {
    for (const approval of [false, true]) {
      if (phase === "complete" && approval) continue;
      test(`${phase} remains unproven with approval=${approval}`, async () => {
        const driver = new FixtureDriver(fixture("ready-new-chat"));
        const surface = await leaseFor(driver);
        const provider = new ChatGptSemanticProvider({approvalAutomationMode:"off"});
        try {
          const submitting=provider.submitTurn(surface.lease,request());
          while(driver.current.revision==="r1")await Promise.resolve();
          driver.queued.push(acceptedSnapshot(driver));
          const submitted=await submitting;
          if(submitted.state!=="proven")throw Error("expected proven fixture submit");
          driver.current={...driver.current,revision:"terminal-before-handoff",
            ...(approval?{approval:recognizedApproval}:{}),
            turns:[...driver.current.turns,{key:"assistant",role:"assistant",parentUserTurnKey:"user-turn-1",phase,text:"Synthetic terminal reply"}]};
          const observation=await provider.observeTurn(surface.lease,submitted.value);
          expect(observation.state==="proven"&&observation.value.phase).toBe(phase==="complete"?"completed":"failed");
          expect((await provider.armToolContinuation(surface.lease,submitted.value,"call-terminal")).state).toBe("probable");
          expect(driver.approvalCalls).toBe(0);
        } finally {await surface.host.close();}
      });
    }
  }
});

describe("ChatGPT semantic provider", () => {
  function withMedia(): WebTurnRequest {
    const bytes=Buffer.from("89504e470d0a1a0a00000000","hex");
    const sha256=createHash("sha256").update(bytes).digest("hex");
    const evidence=nativeEvidenceRef({
      threadId:"task-1",itemKey:"user:0",partKey:"0",kind:"image",
      origin:"current-user",source:"native_request",sha256,bytes:bytes.length,
    });
    const original=request();
    return {
      ...original,
      physicalContext:{
        ...original.physicalContext,
        segments:[{type:"revision",revisionId:"rev-1",kind:"user",
          content:`Look at this image\n${JSON.stringify(evidence)}`,evidence:[evidence] }],
      },
      media:[{revisionId:"rev-1",evidence,file:{
        name:webEvidenceFilename(sha256,"image/png"),mimeType:"image/png",bytes,
      }}],
    };
  }

  test("current Native image is structurally attached to the same exact Web submission, never sent twice", async () => {
    const driver=new FixtureDriver(fixture("ready-new-chat"));
    const surface=await leaseFor(driver);
    const provider=new ChatGptSemanticProvider();
    try {
      const payload=withMedia();
      const pending=provider.submitTurn(surface.lease,payload);
      while(driver.activated.length===0) await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const accepted=await pending;
      expect(accepted.state).toBe("proven");
      expect(driver.attachedFiles).toEqual([payload.media![0]!.file.name]);
      expect(driver.activated).toHaveLength(1);
      expect(driver.current.composers[0]?.attachmentNames).toEqual([payload.media![0]!.file.name]);
    }finally{await surface.host.close();}
  });

  test("file upload error does not send the Native task or retry the file", async () => {
    const driver=new FixtureDriver(fixture("ready-new-chat"));
    let uploads=0;
    driver.attachFiles=async()=>{uploads++;throw new Error("fixture attachment unavailable");};
    const surface=await leaseFor(driver);
    try{
      await expect(new ChatGptSemanticProvider().submitTurn(surface.lease,withMedia()))
        .rejects.toThrow("fixture attachment unavailable");
      expect(uploads).toBe(1);
      expect(driver.activated).toEqual([]);
    }finally{await surface.host.close();}
  });

  test("cancellation during media attachment never activates the Web send control", async () => {
    const driver=new FixtureDriver(fixture("ready-new-chat"));
    const abort=new AbortController();
    const originalAttach=driver.attachFiles.bind(driver);
    driver.attachFiles=async(key,files)=>{
      await originalAttach(key,files);
      abort.abort(new Error("fixture cancelled exact Native owner"));
    };
    const surface=await leaseFor(driver);
    try{
      await expect(new ChatGptSemanticProvider().submitTurn(surface.lease,withMedia(),abort.signal))
        .rejects.toThrow();
      expect(abort.signal.aborted).toBe(true);
      expect(driver.attachedFiles).toHaveLength(1);
      expect(driver.activated).toEqual([]);
    }finally{await surface.host.close();}
  });
  test.each(["absent", "parentless", "matched", "ambiguous"] as const)(
    "failure snapshot separates %s assistant linkage without payload evidence", async mode => {
      const scratch = mkdtempSync(join(tmpdir(), "tela-semantic-evidence-"));
      const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      const file = join(scratch, "events.jsonl"); process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
      const driver = new FixtureDriver(fixture("ready-new-chat"));
      const { host, lease } = await leaseFor(driver); const provider = new ChatGptSemanticProvider();
      try {
        const pending = provider.submitTurn(lease, request());
        while (driver.current.revision === "r1") await Promise.resolve();
        driver.queued.push(acceptedSnapshot(driver));
        const submitted = await pending;
        if (submitted.state !== "proven") throw Error("fixture submit failed");
        await provider.armToolContinuation(lease, submitted.value, "SYNTHETIC_PRIVATE_CALL");
        const assistant = { key: "SYNTHETIC_PRIVATE_KEY", role: "assistant" as const, phase: "complete" as const, text: "SYNTHETIC_PRIVATE_TEXT" };
        const additions = mode === "absent" ? [] : mode === "parentless" ? [assistant]
          : mode === "matched" ? [{ ...assistant, parentUserTurnKey: "user-turn-1" }]
          : [{ ...assistant, parentUserTurnKey: "SYNTHETIC_PRIVATE_PARENT_A" }, { ...assistant, key: "other", parentUserTurnKey: "SYNTHETIC_PRIVATE_PARENT_B" }];
        driver.current = { ...driver.current, revision: "failure-snapshot", turns: [...driver.current.turns, ...additions] };
        const state = await provider.observeTurn(lease, submitted.value);
        expect(state.state).toBe(mode === "ambiguous" ? "ambiguous" : "proven");
        const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(rows.find(row => row.stage === "web_tool_continuation_armed")).toMatchObject({ assistant_count: 0, continuation_pending: true });
        expect(rows.find(row => row.stage === "web_semantic_state_observed")).toMatchObject({
          assistant_count: additions.length, parentless_assistant_count: mode === "parentless" ? 1 : 0,
          matched_assistant_count: mode === "matched" ? 1 : 0, complete_assistant_count: additions.length,
          continuation_pending: true, accepted_user_present: true,
        });
        expect(readFileSync(file, "utf8")).not.toContain("SYNTHETIC_PRIVATE");
      } finally {
        await host.close();
        if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE; else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
  test("submission waits for an author payload instead of borrowing composer proof for an empty bubble", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      const accepted = acceptedSnapshot(driver);
      driver.queued.push({ ...accepted, revision: "author-not-mounted", turns: accepted.turns.map(turn => {
        const { contentFingerprint: _proof, ...unavailable } = turn; return unavailable;
      }) }, { ...accepted, revision: "author-restored" });
      expect((await submitting).state).toBe("proven");
      expect(driver.current.revision).toBe("author-restored");
      expect(driver.activated).toHaveLength(1);
    } finally { await surface.host.close(); }
  });
  test.each(["preserved", "presentation-change", "semantic-change", "missing", "changed-answer", "changed-lineage", "unreadable-answer", "committed-body-unavailable", "observed-body-unavailable", "untrusted-body-reason"] as const)(
    "retained submission proves prior semantic answer when conversation is %s", async mode => {
      const driver = new FixtureDriver(fixture("ready-new-chat"));
      const {host, lease} = await leaseFor(driver);
      const provider = new ChatGptSemanticProvider();
      const scratch = mkdtempSync(join(tmpdir(), "tela-retained-proof-"));
      const file = join(scratch, "events.jsonl");
      const priorDiagnosticFile = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
      try {
        const submitting = provider.submitTurn(lease, request());
        while (driver.current.revision === "r1") await Promise.resolve();
        const accepted = acceptedSnapshot(driver);
        driver.queued.push(accepted);
        const submitted = await submitting;
        expect(submitted.state).toBe("proven");
        if (submitted.state !== "proven") throw new Error("fixture acceptance");
        driver.queued.push({ ...accepted, revision: "complete", turns: [
          ...accepted.turns, { key: "answer-1", role: "assistant", parentUserTurnKey: "user-turn-1", phase: "complete", text: "Exact prior answer", contentFingerprint: hash("Exact prior answer"),
            ...(mode === "committed-body-unavailable" ? { bodyProof: { version: 1 as const, reason: "unsupported_node" } } : {}) },
        ] });
        expect((await provider.waitForTurnEvent(lease, submitted.value)).state).toBe("proven");
        driver.current = { ...driver.current, revision: "next-ready",
          composers: driver.current.composers.map(({textFingerprint: _unused,...composer}) => ({...composer,textLength:0})),
          turns: mode === "missing" ? [] : driver.current.turns.map(turn => {
            if (turn.role !== "assistant") return turn;
            const { text: priorAnswer, ...identity } = turn;
            return {
              ...identity, ...(mode === "changed-answer" || mode === "semantic-change" ? {contentFingerprint: hash("Other answer")} : {}), phase: "streaming" as const, // global page activity must not change prefix identity
              ...(mode === "observed-body-unavailable" || mode === "untrusted-body-reason"
                ? { bodyProof: { version: 1 as const, reason: mode === "untrusted-body-reason" ? "SYNTHETIC_PRIVATE_BROWSER_TEXT" : "unsupported_node" } } : {}),
              ...(mode === "unreadable-answer" ? {} : { text: mode === "changed-answer" ? "Other answer" : mode === "presentation-change" ? "**Exact prior answer**" : priorAnswer! }),
              parentUserTurnKey: mode === "changed-lineage" ? "other-user" : turn.parentUserTurnKey!,
            };
          }),
        };
        const retained = { ...request(), nativeTurnId: "turn-2", physicalContext: { ...request().physicalContext, mode: "retained-delta" as const, baseRevisionId: "rev-1" } };
        if (mode === "preserved" || mode === "presentation-change") {
          const continuing = provider.submitTurn(lease, retained);
          while (driver.activated.length < 2) await Promise.resolve();
          driver.queued.push({ ...driver.current, revision: "accepted-2", turns: [...driver.current.turns, {key:"user-turn-next",role:"user",contentFingerprint: driver.current.composers[0]!.textFingerprint!}] });
          expect((await continuing).state).toBe("proven");
        } else {
          await expect(provider.submitTurn(lease, retained)).rejects.toMatchObject({
            code: "tela_web_retained_context_unproven", retryable: false,
            reason: mode === "committed-body-unavailable" ? "committed_semantic_unavailable"
              : mode === "observed-body-unavailable" || mode === "untrusted-body-reason" ? "observed_body_incomplete"
              : mode === "missing" || mode === "changed-lineage" ? "lineage_not_unique"
              : mode === "unreadable-answer" ? "observed_body_missing" : "semantic_digest_mismatch",
          });
          expect(driver.activated).toHaveLength(1);
          if (mode === "committed-body-unavailable" || mode === "observed-body-unavailable" || mode === "untrusted-body-reason") {
            const log = readFileSync(file, "utf8");
            const rejected = log.trim().split("\n").map(line => JSON.parse(line)).find(row => row.stage === "web_retained_anchor_rejected");
            expect(rejected).toMatchObject({ committed_semantic_available: mode !== "committed-body-unavailable",
              observed_semantic_available: false, presentation_matches: true,
              phase: mode === "untrusted-body-reason" ? "unclassified" : "unsupported_node" });
            expect(log).not.toMatch(/SYNTHETIC_PRIVATE_BROWSER_TEXT|Exact prior answer/);
          }
        }
      } finally {
        await host.close();
        if (priorDiagnosticFile === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
        else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = priorDiagnosticFile;
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

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

  test.each(["escaped-markdown", "wrong-plain-body", "missing-plain-body"] as const)(
    "context receipt uses exact plain-body proof independently of display Markdown: %s", async (kind) => {
      const driver = new FixtureDriver(fixture("ready-new-chat"));
      driver.autoContextPreload = true;
      driver.escapeContextReceiptMarkdown = true;
      if (kind === "wrong-plain-body") driver.contextPlainReplyOverride = "different receipt";
      if (kind === "missing-plain-body") driver.omitContextPlainFingerprint = true;
      const { host, lease } = await leaseFor(driver);
      try {
        const provider = new ChatGptSemanticProvider({ connectorDraftPersistenceSettleMs: 0 });
        const result = await provider.preloadContextAttachment(lease, {
          nativeTaskId: "task-1", webEpochId: "epoch-1",
          attachment: createChatGptContextAttachment(request().physicalContext),
        });
        expect(result.state).toBe(kind === "escaped-markdown" ? "proven" : "probable");
        expect(driver.activated).toHaveLength(1);
        expect(driver.current.turns.at(-1)?.text).toContain("\\_");
      } finally { await host.release(lease.leaseId); await host.close(); }
    },
  );

  test.each([false, true])("upload failure preserves the first cause and captures privately before surface release, opt-in=%s", async (enabled) => {
    const root = mkdtempSync(join(tmpdir(), "tela-upload-failure-"));
    const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = join(root, "events.jsonl");
    const diagnosticRoot = join(root, "diagnostics");
    if (enabled) setPrivateDiagnosticCapture(diagnosticRoot, 1);
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const original = new Error("fixture-private-upload-detail");
    driver.attachFiles = async () => { throw original; };
    const { host, lease } = await leaseFor(driver);
    try {
      const provider = new ChatGptSemanticProvider({ connectorDraftPersistenceSettleMs: 0 });
      await expect(provider.preloadContextAttachment(lease, { nativeTaskId: "task-1", webEpochId: "epoch-1",
        attachment: createChatGptContextAttachment(request().physicalContext) })).rejects.toBe(original);
      expect(driver.activated).toHaveLength(0);
      const routine = readFileSync(join(root, "events.jsonl"), "utf8");
      expect(routine).toContain('"phase":"file_upload"');
      expect(routine).toContain('"stage":"context_attachment_preload_failed"');
      expect(routine).not.toContain(original.message);
      const artifacts = existsSync(join(diagnosticRoot, "private")) ? readdirSync(join(diagnosticRoot, "private")).filter(name => name.endsWith(".json") && !name.endsWith(".meta.json")) : [];
      expect(artifacts).toHaveLength(enabled ? 1 : 0);
      if (enabled) {
        const capture = JSON.parse(readFileSync(join(diagnosticRoot, "private", artifacts[0]!), "utf8"));
        expect(capture.value.phase).toBe("file_upload"); expect(capture.value.errorMessage).toBe(original.message);
      }
    } finally {
      await host.release(lease.leaseId); await host.close();
      if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE; else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([false, true])("receipt mismatch remains unproven and private failure evidence respects opt-in=%s", async (enabled) => {
    const root = mkdtempSync(join(tmpdir(), "tela-preload-failure-"));
    const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = join(root, "events.jsonl");
    const diagnosticRoot = join(root, "diagnostics");
    if (enabled) setPrivateDiagnosticCapture(diagnosticRoot, 1);
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.autoContextPreload = true;
    driver.contextReplyOverride = "fixture-private-mismatching-answer";
    const { host, lease } = await leaseFor(driver);
    try {
      const provider = new ChatGptSemanticProvider({ connectorDraftPersistenceSettleMs: 0 });
      const attachment = createChatGptContextAttachment(request().physicalContext);
      const result = await provider.preloadContextAttachment(lease, {
        nativeTaskId: "task-1", webEpochId: "epoch-1", attachment,
      });
      expect(result.state).toBe("probable");
      expect(driver.activated).toHaveLength(1);
      const routine = readFileSync(join(root, "events.jsonl"), "utf8");
      expect(routine).toContain('"receipt_present":false');
      expect(routine).not.toContain(driver.contextReplyOverride);
      expect(routine).not.toContain(driver.contextAcknowledgement!);
      const artifacts = existsSync(join(diagnosticRoot, "private"))
        ? readdirSync(join(diagnosticRoot, "private")).filter(name => name.endsWith(".json") && !name.endsWith(".meta.json")) : [];
      expect(artifacts).toHaveLength(enabled ? 1 : 0);
      if (enabled) {
        const capture = JSON.parse(readFileSync(join(diagnosticRoot, "private", artifacts[0]!), "utf8"));
        expect(capture.phase).toBe("context_preload_failure");
        expect(capture.value.expectedReceipt).toBe(driver.contextAcknowledgement);
        expect(capture.value.assistantText).toBe(driver.contextReplyOverride);
        expect(capture.value.parentMatches).toBe(true);
      }
    } finally {
      await host.release(lease.leaseId);
      await host.close();
      if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("context attachment preload trusts a driver-proven upload when the settled UI normalizes the filename label", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.autoContextPreload = true;
    driver.normalizeAttachmentLabelAfterAttach = true;
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
      expect(driver.activated).toHaveLength(1);
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

  test("Work send requires a fresh Temporary Chat and rechecks the surface before activation", async () => {
    const saved = new FixtureDriver(fixture("ready-new-chat"));
    const savedSurface = await leaseFor(saved);
    const provider = new ChatGptSemanticProvider({ requireTemporaryChat: true });
    try {
      await expect(provider.submitTurn(savedSurface.lease, request()))
        .rejects.toThrow("verified Temporary Chat surface");
      expect(saved.activated).toEqual([]);
    } finally {
      await savedSurface.host.close();
    }

    const redirected = new FixtureDriver({
      ...fixture("ready-new-chat"), url: CHATGPT_TEMPORARY_CHAT_URL,
    });
    const originalFill = redirected.replaceComposerText.bind(redirected);
    redirected.replaceComposerText = async (key, value) => {
      await originalFill(key, value);
      redirected.current = { ...redirected.current, url: "https://chatgpt.com/" };
    };
    const redirectedSurface = await leaseFor(redirected);
    try {
      await expect(provider.submitTurn(redirectedSurface.lease, request()))
        .rejects.toThrow("verified Temporary Chat surface");
      expect(redirected.activated).toEqual([]);
    } finally {
      await redirectedSurface.host.close();
    }
  });

  test("Work send starts from Temporary Chat and continues after conversation URL promotion", async () => {
    const driver = new FixtureDriver({
      ...fixture("ready-new-chat"), url: CHATGPT_TEMPORARY_CHAT_URL,
    });
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({ requireTemporaryChat: true });
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      expect((await submitting).state).toBe("proven");
      driver.current = {
        ...driver.current,
        revision: "second-ready",
        url: "https://chatgpt.com/c/temporary-conversation",
        composers: driver.current.composers.map(composer => {
          const { textFingerprint: _fingerprint, ...rest } = composer;
          return { ...rest, textLength: 0 };
        }),
      };
      const continuing = provider.submitTurn(surface.lease, {
        ...request(), nativeTurnId: "turn-2",
      });
      while (driver.current.revision === "second-ready") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver, "user-turn-2"));
      expect((await continuing).state).toBe("proven");
      expect(driver.activated).toEqual(["send-main", "send-main"]);
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

  test("connector artifact recovery preserves a Tela mention beside an unknown attachment", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const mention = "@ChatGPT Tela ";
    driver.current = {
      ...driver.current,
      composers: driver.current.composers.map(composer => ({
        ...composer,
        textLength: mention.length,
        textFingerprint: hash(mention),
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
      expect(await provider.recoverConnectorProbeArtifact(surface.lease)).toBe(false);
      expect(driver.current.composers[0]).toMatchObject({
        textLength: mention.length,
        textFingerprint: hash(mention),
        connectorFingerprints: [],
        attachmentNames: ["user-document.txt"],
      });
      expect(driver.activated).toEqual([]);
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

  test("missing configured connector fails closed instead of submitting through automatic app routing", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.connectorCatalogUnavailable = true;
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({
      connectorName: "ChatGPT Tela",
      connectorDraftPersistenceSettleMs: 0,
    });
    try {
      await expect(provider.probeConnector(surface.lease))
        .rejects.toThrow("integration catalog does not expose the configured connector");
      await expect(provider.submitTurn(surface.lease, toolRequest()))
        .rejects.toThrow("integration catalog does not expose the configured connector");
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

  test("completed owned body keeps Markdown presentation separate from its unformatted text", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture");
      const user = driver.current.turns.find(turn=>turn.role === "user")!;
      driver.queued.push({...driver.current,revision:"owned-complete",turns:[user,{
        key:"owned-assistant",role:"assistant",parentUserTurnKey:user.key,phase:"complete",
        text:"**file\\_name** `value`",plainBodyText:"file_name value",
      }]});
      const result = await provider.waitForTurnEvent(surface.lease,submitted.value);
      expect(result.state === "proven" && result.value).toMatchObject({
        kind:"completed",answer:"**file\\_name** `value`",plainAnswer:"file_name value",
      });
    } finally { await surface.host.close(); }
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
        turns: [{ ...driver.current.turns.find(turn => turn.role === "user")!, key: "stable-user-turn" }, {
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

  test.each(["other-conversation", "other-request", "missing-user", "same-parent-missing-user", "same-key-other-request", "same-request-other-conversation"] as const)(
    "unrelated answer cannot complete an accepted request: %s", async mode => {
      const driver = new FixtureDriver(fixture("ready-new-chat"));
      const surface = await leaseFor(driver);
      const provider = new ChatGptSemanticProvider();
      try {
        const submitting = provider.submitTurn(surface.lease, request());
        while (driver.current.revision === "r1") await Promise.resolve();
        driver.queued.push({ ...acceptedSnapshot(driver), url: "https://chatgpt.com/c/accepted" });
        const submitted = await submitting;
        if (submitted.state !== "proven") throw new Error("fixture");
        const user = driver.current.turns.find(turn => turn.role === "user")!;
        driver.queued.push({ ...driver.current, revision: "foreign-final",
          url: mode.includes("other-conversation") ? "https://chatgpt.com/c/other" : driver.current.url,
          turns: [ ...(mode.includes("missing-user") ? [] : [{ ...user,
            key: mode === "same-key-other-request" || mode === "same-request-other-conversation" ? user.key : "foreign-user",
            contentFingerprint: mode === "same-request-other-conversation" ? user.contentFingerprint! : hash("different request") }]),
            { key: "foreign-assistant", role: "assistant",
              parentUserTurnKey: mode.startsWith("same-") ? user.key : "foreign-user", phase: "complete", text: "wrong answer" } ],
        });
        if (mode.includes("missing-user")) {
          driver.queued.push({ ...driver.current, revision: "identity-restored", turns: [user, {
            key: "owned-assistant", role: "assistant", parentUserTurnKey: user.key,
            phase: "complete", text: "verified answer",
          }] });
          const result = await provider.waitForTurnEvent(surface.lease, submitted.value);
          expect(result.state === "proven" && result.value).toMatchObject({ kind: "completed", answer: "verified answer" });
        } else {
          await expect(provider.waitForTurnEvent(surface.lease, submitted.value)).rejects.toThrow(/identity|conversation/);
        }
      } finally { await surface.host.close(); }
    },
  );

  test.each(['same-anchor', 'different-document', 'different-conversation', 'changed-user'] as const)(
    "accepted logical lineage remains scoped when user is unrendered: %s", async mode => {
      const driver = new FixtureDriver(fixture('ready-new-chat'));
      const surface = await leaseFor(driver);
      const provider = new ChatGptSemanticProvider();
      try {
        const submitting = provider.submitTurn(surface.lease, request());
        while (driver.current.revision === 'r1') await Promise.resolve();
        const accepted = acceptedSnapshot(driver, 'user:logical');
        const anchor = hash('synthetic-document/logical-turn');
        driver.queued.push({ ...accepted, turns: accepted.turns.map(turn => ({ ...turn, lineageAnchor: anchor })),
          url: 'https://chatgpt.com/c/accepted' });
        const submitted = await submitting;
        if (submitted.state !== 'proven') throw Error('fixture submission');
        const user = driver.current.turns.find(turn => turn.role === 'user')!;
        const assistant = { key: 'assistant:logical', role: 'assistant' as const, parentUserTurnKey: user.key,
          lineageAnchor: mode === 'different-document' ? hash('other-document/logical-turn') : anchor,
          phase: 'complete' as const, text: 'synthetic owned answer' };
        driver.queued.push({ ...driver.current, revision: 'hydrated',
          url: mode === 'different-conversation' ? 'https://chatgpt.com/c/foreign' : driver.current.url,
          turns: mode === 'changed-user' ? [{ ...user, contentFingerprint: hash('foreign request') }, assistant] : [assistant],
        });
        if (mode === 'different-conversation' || mode === 'changed-user') {
          await expect(provider.waitForTurnEvent(surface.lease, submitted.value)).rejects.toThrow(/conversation|identity/);
        } else {
          if (mode === 'different-document') driver.queued.push({ ...driver.current, revision: 'restored',
            turns: [user, { ...assistant, lineageAnchor: anchor, text: 'restored owned answer' }] });
          const completed = await provider.waitForTurnEvent(surface.lease, submitted.value);
          expect(completed.state === 'proven' && completed.value).toMatchObject({ kind: 'completed',
            answer: mode === 'same-anchor' ? 'synthetic owned answer' : 'restored owned answer' });
        }
      } finally { await surface.host.close(); }
    },
  );

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

  test("same-document navigation cannot arm a tool handoff or deliver a buffered completion", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push({ ...acceptedSnapshot(driver), url: "https://chatgpt.com/c/accepted" });
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture");
      await provider.armToolContinuation(surface.lease, submitted.value, "fixture-call");
      driver.queued.push({ ...driver.current, revision: "complete-after-handoff", turns: [...driver.current.turns,
        { key: "assistant", role: "assistant", parentUserTurnKey: "user-turn-1", phase: "complete", text: "correct buffered answer" }],
      });
      const continuing = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(continuing.state === "proven" && continuing.value.kind).toBe("continuing");
      driver.current = { ...driver.current, url: "https://chatgpt.com/c/foreign" };
      await expect(provider.armToolContinuation(surface.lease, submitted.value, "wrong-call")).rejects.toThrow("conversation changed");
      await expect(provider.waitForTurnEvent(surface.lease, submitted.value)).rejects.toThrow("conversation changed");
    } finally { await surface.host.close(); }
  });

  test("one accepted request can acquire its canonical route without authorizing later navigation", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture");
      driver.current = { ...driver.current, url: "https://chatgpt.com/c/accepted" };
      expect((await provider.observeTurn(surface.lease, submitted.value)).state).toBe("proven");
      driver.current = { ...driver.current, url: "https://chatgpt.com/c/foreign" };
      await expect(provider.observeTurn(surface.lease, submitted.value)).rejects.toThrow("conversation changed");
    } finally { await surface.host.close(); }
  });

  test("Native cancellation ends tool handoff waiting for message identity", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver); const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture");
      driver.current = { ...driver.current, revision: "loading", turns: [] };
      let waiting = false;
      driver.waitForChange = async (_revision: string, signal?: AbortSignal) => {
        waiting = true;
        return await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      };
      const abort = new AbortController();
      const handoff = provider.armToolContinuation(surface.lease, submitted.value, "call", abort.signal);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(waiting).toBe(true);
      abort.abort(new Error("Native stopped"));
      await expect(handoff).rejects.toThrow("Native stopped");
    } finally { await surface.host.close(); }
  });

  test.each(["same-key", "rekey"] as const)("loading frame with no user cannot commit a placeholder: %s", async mode => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver); const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver, "accepted-user"));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture");
      const user = driver.current.turns.find(turn => turn.role === "user")!;
      driver.current = { ...driver.current, url: "https://chatgpt.com/c/accepted" };
      await provider.observeTurn(surface.lease, submitted.value);
      driver.current = { ...driver.current, revision: "loading", turns: [{
        key: "assistant-placeholder", role: "assistant", parentUserTurnKey: "unproven-placeholder",
        phase: "complete", text: "must never be delivered", publicProgress: ["must never be forwarded"],
      }] };
      expect((await provider.observeTurn(surface.lease, submitted.value)).state).toBe("probable");
      const loading = driver.current;
      driver.current = { ...loading, url: "https://chatgpt.com/c/foreign" };
      await expect(provider.observeTurn(surface.lease, submitted.value)).rejects.toThrow("conversation changed");
      driver.current = loading;
      const key = mode === "same-key" ? user.key : "hydrated-user";
      driver.queued.push({ ...loading, revision: "restored", turns: [
        { ...user, key }, { key: "actual-assistant", role: "assistant", parentUserTurnKey: key,
          phase: "complete", text: "actual answer" },
      ] });
      const completed = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(completed.state === "proven" && completed.value).toMatchObject({ kind: "completed", answer: "actual answer" });
    } finally { await surface.host.close(); }
  });

  test.each(["empty", "placeholder", "request-before-assistant"] as const)(
    "canonical route waits for exact request proof across incomplete frames: %s", async mode => {
      const driver = new FixtureDriver(fixture("ready-new-chat"));
      driver.approveRecognizedCard = true;
      const surface = await leaseFor(driver);
      const provider = new ChatGptSemanticProvider({ approvalAutomationMode: "recognized_once" });
      try {
        const submitting = provider.submitTurn(surface.lease, request());
        while (driver.current.revision === "r1") await Promise.resolve();
        driver.queued.push({ ...acceptedSnapshot(driver, "provisional-user"),
          url: "https://chatgpt.com/c/local-chatgpt%3A00000000-0000-0000-0000-000000000001" });
        const submitted = await submitting;
        if (submitted.state !== "proven") throw new Error("fixture");
        const user = driver.current.turns.find(turn => turn.role === "user")!;
        const restoredUser = { ...user, key: mode === "request-before-assistant" ? "hydrated-user" : user.key };
        driver.current = { ...driver.current, revision: "canonical-incomplete",
          url: "https://chatgpt.com/c/accepted", approval: recognizedApproval,
          turns: mode === "empty" ? [] : mode === "request-before-assistant" ? [restoredUser] : [{
            key: "unowned-placeholder", role: "assistant", parentUserTurnKey: "unowned-parent",
            phase: "complete", text: "must never be delivered", publicProgress: ["must never be forwarded"],
          }],
        };
        for (let i = 0; i < 2; i++) expect(await provider.observeTurn(surface.lease, submitted.value))
          .toMatchObject({ state: "probable", value: { phase: "accepted" } });
        expect(driver.approvalCalls).toBe(0);
        const { approval: _approval, ...restored } = driver.current;
        driver.queued.push({ ...restored, revision: "canonical-owned", turns: [restoredUser, {
          key: "owned-assistant", role: "assistant", parentUserTurnKey: restoredUser.key,
          phase: "complete", text: "correct answer",
        }] });
        expect(await provider.waitForTurnEvent(surface.lease, submitted.value)).toMatchObject({
          state: "proven", value: { kind: "completed", answer: "correct answer" },
        });
        expect(driver.activated).toHaveLength(1);
        expect(driver.approvalCalls).toBe(0);
      } finally { await surface.host.close(); }
    },
  );

  test.each(["second-canonical", "back-to-provisional", "foreign-origin", "wrong-user", "duplicate-request", "multiple-lineages"] as const)(
    "pending canonical route cannot authorize conflicting ownership: %s", async mode => {
      const driver = new FixtureDriver(fixture("ready-new-chat"));
      const surface = await leaseFor(driver); const provider = new ChatGptSemanticProvider();
      try {
        const submitting = provider.submitTurn(surface.lease, request());
        while (driver.current.revision === "r1") await Promise.resolve();
        driver.queued.push({ ...acceptedSnapshot(driver),
          url: "https://chatgpt.com/c/local-chatgpt%3A00000000-0000-0000-0000-000000000001" });
        const submitted = await submitting;
        if (submitted.state !== "proven") throw new Error("fixture");
        const accepted = driver.current;
        const user = accepted.turns.find(turn => turn.role === "user")!;
        driver.current = { ...accepted, revision: "canonical-empty", url: "https://chatgpt.com/c/accepted", turns: [] };
        expect((await provider.observeTurn(surface.lease, submitted.value)).state).toBe("probable");
        driver.current = { ...driver.current, revision: "conflicting",
          url: mode === "second-canonical" ? "https://chatgpt.com/c/foreign"
            : mode === "back-to-provisional" ? accepted.url
            : mode === "foreign-origin" ? "https://example.com/c/accepted" : driver.current.url,
          turns: mode === "wrong-user" ? [{ ...user, contentFingerprint: "wrong-request" }]
            : mode === "duplicate-request" ? [user, { ...user, key: "duplicate" }]
            : mode === "multiple-lineages" ? [
              { key: "a", role: "assistant", parentUserTurnKey: "p1", phase: "complete", text: "wrong" },
              { key: "b", role: "assistant", parentUserTurnKey: "p2", phase: "complete", text: "wrong" },
            ] : [user],
        };
        await expect(provider.observeTurn(surface.lease, submitted.value)).rejects.toThrow("conversation changed");
        expect(driver.activated).toHaveLength(1);
      } finally { await surface.host.close(); }
    },
  );

  test.each(["event", "tool-handoff"] as const)("Native/document cancellation ends pending canonical proof: %s", async mode => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver); const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture");
      driver.current = { ...driver.current, revision: "canonical-empty", url: "https://chatgpt.com/c/accepted", turns: [] };
      expect((await provider.observeTurn(surface.lease, submitted.value)).state).toBe("probable");
      let waiting = false;
      driver.waitForChange = async (_revision: string, signal?: AbortSignal) => {
        waiting = true;
        return await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      };
      const abort = new AbortController();
      const pending = mode === "event"
        ? provider.waitForTurnEvent(surface.lease, submitted.value, abort.signal)
        : provider.armToolContinuation(surface.lease, submitted.value, "call", abort.signal);
      while (!waiting) await Promise.resolve();
      const stopped = new Error("owned document or Native stopped");
      abort.abort(stopped);
      await expect(pending).rejects.toBe(stopped);
      expect(driver.activated).toHaveLength(1);
    } finally { await surface.host.close(); }
  });

  test("pending canonical proof blocks Native result handoff until the accepted lineage returns", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver); const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture");
      const user = driver.current.turns.find(turn => turn.role === "user")!;
      driver.current = { ...driver.current, revision: "canonical-empty", url: "https://chatgpt.com/c/accepted", turns: [] };
      let resume: ((snapshot: ChatGptSurfaceSnapshot) => void) | undefined;
      driver.waitForChange = async () => await new Promise(resolve => { resume = resolve; });
      let armed = false;
      const pending = provider.armToolContinuation(surface.lease, submitted.value, "call").then(value => { armed = true; return value; });
      while (!resume) await Promise.resolve();
      expect(armed).toBe(false);
      driver.current = { ...driver.current, revision: "canonical-owned", turns: [user, {
        key: "assistant", role: "assistant", parentUserTurnKey: user.key, phase: "tool-wait",
      }] };
      resume(driver.current);
      expect(await pending).toMatchObject({ state: "proven", value: { callId: "call" } });
      expect(driver.activated).toHaveLength(1);
    } finally { await surface.host.close(); }
  });

  test("canonical proof diagnostics record one pending transition and exact recovery without private data", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "tela-canonical-proof-"));
    const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    const file = join(scratch, "events.jsonl"); process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver); const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver, "SYNTHETIC_PRIVATE_USER"));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture");
      const user = driver.current.turns.find(turn => turn.role === "user")!;
      driver.current = { ...driver.current, revision: "empty", url: "https://chatgpt.com/c/SYNTHETIC_PRIVATE_CANONICAL", turns: [] };
      for (let i = 0; i < 3; i++) await provider.observeTurn(surface.lease, submitted.value);
      driver.current = { ...driver.current, revision: "owned", turns: [user] };
      expect((await provider.observeTurn(surface.lease, submitted.value)).state).toBe("proven");
      const text = readFileSync(file, "utf8");
      const rows = text.trim().split("\n").map(line => JSON.parse(line));
      expect(rows.filter(row => row.stage === "web_turn_identity_pending")).toHaveLength(1);
      expect(rows.find(row => row.stage === "web_turn_identity_pending")).toMatchObject({ reason_class: "canonical_route_pending" });
      expect(rows.filter(row => row.stage === "web_turn_identity_rebound")).toHaveLength(1);
      expect(rows.filter(row => row.stage === "web_turn_identity_rejected")).toHaveLength(0);
      expect(text).not.toContain("SYNTHETIC_PRIVATE");
      expect(text).not.toContain("https://");
    } finally {
      await surface.host.close();
      if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE; else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test.each(["initial", "provisional-same-key", "provisional-rekey"] as const)("canonical route hydration: %s", async mode => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver); const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push({ ...acceptedSnapshot(driver, "provisional-user"),
        ...(mode !== "initial" ? { url: "https://chatgpt.com/c/local-chatgpt%3A00000000-0000-0000-0000-000000000001" } : {}),
      });
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture");
      const user = driver.current.turns.find(turn => turn.role === "user")!;
      driver.current = { ...driver.current, revision: "route-and-key-hydrated",
        url: "https://chatgpt.com/c/accepted", turns: [
          { ...user, key: mode === "provisional-same-key" ? "provisional-user" : "stable-user" },
          { key: "assistant", role: "assistant", parentUserTurnKey: mode === "provisional-same-key" ? "provisional-user" : "stable-user", phase: "thinking" },
        ],
      };
      expect((await provider.observeTurn(surface.lease, submitted.value)).state).toBe("proven");
      const hydrated = driver.current;
      driver.current = { ...driver.current, url: "https://chatgpt.com/c/foreign" };
      await expect(provider.observeTurn(surface.lease, submitted.value)).rejects.toThrow("conversation changed");
      driver.current = hydrated;
      driver.queued.push({ ...hydrated, revision: "complete", turns: hydrated.turns.map(turn => turn.role === "assistant"
        ? { ...turn, phase: "complete", text: "correct" } : turn) });
      const completed = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(completed.state === "proven" && completed.value).toMatchObject({ kind: "completed", answer: "correct" });
    } finally { await surface.host.close(); }
  });

  test.each(["duplicate-request", "multiple-lineages", "foreign-origin"] as const)(
    "canonical route hydration refuses ambiguous ownership: %s", async mode => {
      const driver = new FixtureDriver(fixture("ready-new-chat"));
      const surface = await leaseFor(driver); const provider = new ChatGptSemanticProvider();
      try {
        const submitting = provider.submitTurn(surface.lease, request());
        while (driver.current.revision === "r1") await Promise.resolve();
        driver.queued.push(acceptedSnapshot(driver, "provisional-user"));
        const submitted = await submitting;
        if (submitted.state !== "proven") throw new Error("fixture");
        const user = driver.current.turns.find(turn => turn.role === "user")!;
        driver.current = { ...driver.current, revision: "unproven-hydration",
          url: mode === "foreign-origin" ? "https://example.com/c/accepted" : "https://chatgpt.com/c/accepted",
          turns: [{ ...user, key: "stable-user" },
            ...(mode === "duplicate-request" ? [{ ...user, key: "duplicate-user" }] : []),
            { key: "assistant", role: "assistant", parentUserTurnKey: "stable-user", phase: "complete", text: "wrong" },
            ...(mode === "multiple-lineages" ? [{ key: "other", role: "assistant" as const,
              parentUserTurnKey: "other-user", phase: "complete" as const, text: "wrong" }] : []),
          ],
        };
        await expect(provider.observeTurn(surface.lease, submitted.value)).rejects.toThrow("conversation changed");
      } finally { await surface.host.close(); }
    },
  );

  test.each(["initial", "provisional", "conversation"] as const)(
    "identity diagnostics distinguish accepted route and later navigation without private data: %s", async mode => {
      const scratch = mkdtempSync(join(tmpdir(), "tela-route-evidence-"));
      const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      const file = join(scratch, "events.jsonl"); process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
      const driver = new FixtureDriver(fixture("ready-new-chat"));
      const surface = await leaseFor(driver); const provider = new ChatGptSemanticProvider();
      try {
        const submitting = provider.submitTurn(surface.lease, request());
        while (driver.current.revision === "r1") await Promise.resolve();
        driver.queued.push({ ...acceptedSnapshot(driver, "SYNTHETIC_PRIVATE_USER_KEY"),
          url: mode === "initial" ? "https://chatgpt.com/?temporary-chat=true"
            : mode === "provisional" ? "https://chatgpt.com/c/local-chatgpt%3A00000000-0000-0000-0000-000000000001"
            : "https://chatgpt.com/c/SYNTHETIC_PRIVATE_ROUTE",
        });
        const submitted = await submitting;
        if (submitted.state !== "proven") throw Error("fixture submit failed");
        if (mode !== "conversation") {
          driver.current = { ...driver.current, url: "https://chatgpt.com/c/SYNTHETIC_PRIVATE_CANONICAL" };
          await provider.observeTurn(surface.lease, submitted.value);
        }
        driver.current = { ...driver.current, url: "https://chatgpt.com/c/SYNTHETIC_PRIVATE_FOREIGN" };
        await expect(provider.observeTurn(surface.lease, submitted.value)).rejects.toThrow("conversation changed");
        const text = readFileSync(file, "utf8");
        const rows = text.trim().split("\n").map(line => JSON.parse(line));
        expect(rows.filter(row => row.stage === "web_turn_identity_accepted")).toHaveLength(1);
        expect(rows.find(row => row.stage === "web_turn_identity_accepted")).toMatchObject({
          route_kind: mode, user_count: 1, baseline_lineage_count: 0, accepted_fingerprint_matches: true,
        });
        expect(rows.find(row => row.stage === "web_turn_identity_rejected")).toMatchObject({
          reason_class: "conversation_changed", previous_route_initial: false, previous_route_provisional: false,
          same_origin: true, matching_user_count: 1, accepted_key_matches: true,
        });
        expect(text).not.toContain("SYNTHETIC_PRIVATE");
        expect(text).not.toContain("https://");
      } finally {
        await surface.host.close();
        if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE; else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  test("public progress never consumes completion or authorizes a foreign conversation", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver); const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push({ ...acceptedSnapshot(driver), url: "https://chatgpt.com/c/accepted" });
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture");
      driver.queued.push({ ...driver.current, revision: "public-progress-and-final", turns: [...driver.current.turns,
        { key: "assistant", role: "assistant", parentUserTurnKey: "user-turn-1", phase: "complete", text: "final",
          publicProgress: ["Checked files", "Compared results"] }],
      });
      const progress = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(progress.state === "proven" && progress.value).toMatchObject({ kind: "progress", summary: "Checked files\n\nCompared results" });
      const final = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(final.state === "proven" && final.value).toMatchObject({ kind: "completed", answer: "final" });
    } finally { await surface.host.close(); }
  });

  test("public progress mutation alone does not prove post-tool continuation", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver); const provider = new ChatGptSemanticProvider();
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture");
      const assistant = { key: "assistant", role: "assistant" as const, parentUserTurnKey: "user-turn-1", phase: "thinking" as const };
      driver.current = { ...driver.current, turns: [...driver.current.turns, assistant] };
      await provider.armToolContinuation(surface.lease, submitted.value, "fixture-call");
      driver.queued.push({ ...driver.current, revision: "presentation-only", turns: [...driver.current.turns.filter(item => item.role === "user"),
        { ...assistant, publicProgress: ["Inspecting files"] }] });
      const progress = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(progress.state === "proven" && progress.value.kind).toBe("progress");
      driver.queued.push({ ...driver.current, revision: "actual-completion", turns: [...driver.current.turns.filter(item => item.role === "user"),
        { ...assistant, phase: "complete", text: "result", publicProgress: ["Inspecting files"] }] });
      const continuing = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(continuing.state === "proven" && continuing.value.kind).toBe("continuing");
      expect(driver.current.revision).toBe("actual-completion");
    } finally { await surface.host.close(); }
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

  test.each([false, true])("tool continuation and buffered final preserve ownership across loading: %s", async loading => {
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
        turns: [{ ...driver.current.turns.find(turn => turn.role === "user")!, key: "stable-user-turn" }, {
          key: "assistant-stable",
          role: "assistant",
          parentUserTurnKey: "stable-user-turn",
          phase: "tool-wait",
        }],
      };
      if (loading) {
        driver.queued.push({ ...driver.current, revision: "tool-owner-restored" });
        driver.current = { ...driver.current, revision: "tool-loading", turns: [{ key: "placeholder",
          role: "assistant", parentUserTurnKey: "unproven", phase: "thinking" }] };
      }
      const armed = await provider.armToolContinuation(surface.lease, submitted.value, "call-rekeyed");
      expect(armed).toEqual({
        state: "proven",
        value: { providerTurnId: "provisional-user-turn", callId: "call-rekeyed" },
        evidence: ["captured exact assistant state before MCP result handoff"],
      });

      driver.queued.push({
        ...driver.current,
        revision: "hydrated-complete",
        turns: [{ ...driver.current.turns.find(turn => turn.role === "user")!, key: "stable-user-turn" }, {
          key: "assistant-stable",
          role: "assistant",
          parentUserTurnKey: "stable-user-turn",
          phase: "complete",
          text: "finished-after-rekey",
          plainBodyText: "unformatted finished-after-rekey",
        }],
      });
      const continuing = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(continuing.state).toBe("proven");
      if (continuing.state === "proven") expect(continuing.value.kind).toBe("continuing");

      if (loading) {
        driver.queued.push({ ...driver.current, revision: "final-owner-restored" });
        driver.current = { ...driver.current, revision: "final-loading", turns: [{ key: "placeholder",
          role: "assistant", parentUserTurnKey: "unproven", phase: "complete", text: "wrong placeholder" }] };
      }
      const completed = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(completed).toEqual({
        state: "proven",
        value: {
          kind: "completed",
          providerTurnId: "provisional-user-turn",
          answer: "finished-after-rekey",
          plainAnswer: "unformatted finished-after-rekey",
        },
        evidence: ["assistant completion followed a proven post-tool continuation boundary"],
      });
    } finally {
      await surface.host.close();
    }
  });

  test("an unresolved approval cannot commit a progress reply after a tool result", async () => {
    for (const mode of ["off", "recognized_once"] as const) {
      const driver = new FixtureDriver(fixture("ready-new-chat"));
      const surface = await leaseFor(driver);
      const provider = new ChatGptSemanticProvider({ approvalAutomationMode: mode });
      try {
        const submitting = provider.submitTurn(surface.lease, request());
        while (driver.current.revision === "r1") await Promise.resolve();
        driver.queued.push(acceptedSnapshot(driver));
        const submitted = await submitting;
        if (submitted.state !== "proven") throw new Error("expected proven submit fixture");
        const waiting: ChatGptSurfaceSnapshot = {
          ...driver.current, revision: "approval-and-copy-controls",
          approval: { cardCount: 1, denyCount: 0, allowCount: 0, allowOnceCount: 0,
            alwaysAllowCount: 0, unknownCount: 4, revisionFingerprint: "synthetic-approval" },
          turns: [...driver.current.turns, { key: "assistant-1", role: "assistant",
            parentUserTurnKey: "user-turn-1", phase: "complete", text: "I will investigate" }],
        };
        driver.current = waiting;
        const state = await provider.observeTurn(surface.lease, submitted.value);
        expect(state.state === "proven" && state.value.phase).toBe("tool-wait");
        const handoff = await provider.armToolContinuation(surface.lease, submitted.value, "call-approval");
        expect(handoff.state).toBe("proven");
        expect(driver.approvalCalls).toBe(0);
        driver.queued.push({...waiting,revision:"still-pending"});
        const pending=await provider.waitForTurnEvent(surface.lease,submitted.value);
        expect(pending.state==="proven"&&pending.value.kind).toBe("progress");
        const { approval: _approval, ...cleared } = waiting;
        driver.queued.push({...cleared,revision:"card-cleared-only"});
        driver.queued.push({ ...cleared, revision: "work-really-finished",
          turns: [...waiting.turns.filter(row => row.role !== "assistant"), { key: "assistant-1", role: "assistant",
            parentUserTurnKey: "user-turn-1", phase: "complete", text: "Verified result" }],
        });
        const clearedProgress=await provider.waitForTurnEvent(surface.lease,submitted.value);
        expect(clearedProgress.state==="proven"&&clearedProgress.value.kind).toBe("progress");
        expect(driver.current.revision).toBe("card-cleared-only");
        const changedProgress=await provider.waitForTurnEvent(surface.lease,submitted.value);
        expect(changedProgress.state==="proven"&&changedProgress.value.kind).toBe("progress");
        const continuing = await provider.waitForTurnEvent(surface.lease, submitted.value);
        expect(continuing.state === "proven" && continuing.value.kind).toBe("continuing");
        expect(driver.current.revision).toBe("work-really-finished");
        const final = await provider.waitForTurnEvent(surface.lease, submitted.value);
        expect(final.state === "proven" && final.value).toMatchObject({ kind: "completed", answer: "Verified result" });
        expect(driver.current.revision).toBe("work-really-finished");
      } finally { await surface.host.close(); }
    }
  });

  test("processes an approval card before the assistant message is rendered", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.approveRecognizedCard = true;
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({ approvalAutomationMode: "recognized_once" });
    try {
      const pending = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const submitted = await pending;
      if (submitted.state !== "proven") throw new Error("fixture submit failed");
      driver.queued.push({ ...driver.current, revision: "approval-without-assistant", approval: recognizedApproval });
      driver.queued.push({ ...driver.current, revision: "after-approval", turns: [
        ...driver.current.turns, {key:"assistant-approved",role:"assistant",parentUserTurnKey:"user-turn-1",phase:"complete",text:"done"},
      ] });
      await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(driver.approvalCalls).toBe(1);
    } finally { await surface.host.close(); }
  });

  test("passes approval delay to the card driver during an active assistant turn", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.approveRecognizedCard = true;
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({
      approvalAutomationMode: "recognized_once",
      approvalAutomationDelayMs: 1,
    });
    const scratch = mkdtempSync(join(tmpdir(), "tela-approval-resolution-"));
    const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    const file = join(scratch, "events.jsonl");
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("expected proven submit fixture");
      driver.queued.push({
        ...driver.current,
        revision: "approval-assistant-active",
        approval: recognizedApproval,
        turns: [
          ...driver.current.turns,
          {
            key: "assistant-approval",
            role: "assistant",
            parentUserTurnKey: "user-turn-1",
            phase: "thinking",
          },
        ],
      });
      driver.queued.push({
        ...driver.current,
        revision: "approval-complete",
        turns: [
          ...driver.current.turns,
          {
            key: "assistant-approval",
            role: "assistant",
            parentUserTurnKey: "user-turn-1",
            phase: "complete",
            text: "approved and finished",
          },
        ],
      });
      const dispatched = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(dispatched.state === "proven" && dispatched.value).toMatchObject({ kind: "progress",
        summary: "Approval click sent; waiting for the Web browser to receive and process it." });
      const cleared = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(cleared.state === "proven" && cleared.value).toMatchObject({ kind: "progress",
        summary: "Approval card cleared; waiting for the task to resume." });
      const progress = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(progress.state === "proven" && progress.value).toMatchObject({ kind: "progress",
        summary: "The Web task progressed after the approval card cleared." });
      const completed = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(driver.approvalCalls).toBe(1);
      expect(driver.approvalDelays).toEqual([1]);
      expect(completed).toEqual({
        state: "proven",
        value: {
          kind: "completed",
          providerTurnId: "user-turn-1",
          answer: "approved and finished",
        },
        evidence: ["one assistant descendant reached complete state"],
      });
      const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const resolutions = rows.filter(row => row.stage === "approval_turn_resolution");
      expect(resolutions).toHaveLength(1);
      expect(resolutions[0]).toMatchObject({ approval_count: 1, dispatch_count: 1, card_clear_count: 1,
        native_result_count: 0, execution_evidence: "unverified", decision_evidence: "unverified", assistant_phase: "completed" });
      expect(rows.filter(row => row.stage === "approval_resolution_anomaly")).toHaveLength(1);
      expect(readFileSync(file, "utf8")).not.toContain("approved and finished");
      expect(() => new ChatGptSemanticProvider({ approvalAutomationDelayMs: 15_001 }))
        .toThrow("0-15000ms");
    } finally {
      await surface.host.close();
      if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("trusted approval input remains pending until card clearance and owned task continuation", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.approveRecognizedCard = true;
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({ approvalAutomationMode: "recognized_once" });
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture submit failed");
      const pendingCard: ChatGptSurfaceSnapshot = { ...driver.current, revision: "pending-approval",
        approval: recognizedApproval, turns: [...driver.current.turns, { key: "assistant-pending", role: "assistant",
          parentUserTurnKey: "user-turn-1", phase: "complete", text: "Preliminary reply" }] };
      driver.queued.push(pendingCard);
      driver.queued.push({ ...pendingCard, revision: "input-received",
        approval: { ...recognizedApproval, inputReceived: true } });
      const { approval: _approval, ...cleared } = pendingCard;
      driver.queued.push({ ...cleared, revision: "card-cleared", turns: [...cleared.turns.filter(t => t.role !== "assistant"),
        { key: "assistant-pending", role: "assistant", parentUserTurnKey: "user-turn-1", phase: "complete", text: "Verified result" }] });
      const next = async () => {
        const event = await provider.waitForTurnEvent(surface.lease, submitted.value);
        if (event.state !== "proven") throw new Error("fixture event unproven");
        return event.value;
      };
      expect(await next()).toMatchObject({ kind: "progress", summary: "Approval click sent; waiting for the Web browser to receive and process it." });
      expect(await next()).toMatchObject({ kind: "progress", summary: "The Web browser received the approval click; the card is still pending." });
      const cancelledWait = new AbortController();
      cancelledWait.abort(new Error("channel event won the wait"));
      await expect(provider.waitForTurnEvent(surface.lease, submitted.value, cancelledWait.signal)).rejects.toThrow();
      const pending = await provider.observeTurn(surface.lease, submitted.value);
      expect(pending.state === "proven" && pending.value.phase).toBe("tool-wait");
      await expect(provider.observeTurn({ ...surface.lease }, submitted.value)).rejects.toThrow("not bound");
      await expect(provider.observeTurn(surface.lease, { ...submitted.value, providerTurnId: "foreign-provider-turn" })).rejects.toThrow("not bound");
      expect(await next()).toMatchObject({ kind: "progress", summary: "Approval card cleared; waiting for the task to resume." });
      expect(await next()).toMatchObject({ kind: "progress", summary: "The Web task progressed after the approval card cleared." });
      expect(await next()).toMatchObject({ kind: "completed", answer: "Verified result" });
      expect(driver.approvalCalls).toBe(1);
    } finally { await surface.host.close(); }
  });

  test("visible card without an exact snapshot proof stays manual", async () => {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    driver.approveRecognizedCard = true;
    const surface = await leaseFor(driver);
    const provider = new ChatGptSemanticProvider({ approvalAutomationMode: "recognized_once" });
    try {
      const submitting = provider.submitTurn(surface.lease, request());
      while (driver.current.revision === "r1") await Promise.resolve();
      driver.queued.push(acceptedSnapshot(driver));
      const submitted = await submitting;
      if (submitted.state !== "proven") throw new Error("fixture submit failed");
      const { cardFingerprint: _card, ...withoutIdentity } = recognizedApproval;
      driver.queued.push({ ...driver.current, revision: "unproven-card", approval: withoutIdentity });
      const event = await provider.waitForTurnEvent(surface.lease, submitted.value);
      expect(event.state === "proven" && event.value).toMatchObject({ kind: "progress", summary: "Approval needed in the Web browser." });
      expect(driver.approvalCalls).toBe(0);
    } finally { await surface.host.close(); }
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


test("failed assistant supersedes a cached post-tool final even with a pending approval",async()=>{
 const driver=new FixtureDriver(fixture("ready-new-chat"));const surface=await leaseFor(driver);
 const provider=new ChatGptSemanticProvider({approvalAutomationMode:"off"});
 try{
  const submitting=provider.submitTurn(surface.lease,request());
  while(driver.current.revision==="r1")await Promise.resolve();
  driver.queued.push(acceptedSnapshot(driver));const submitted=await submitting;
  if(submitted.state!=="proven")throw Error("expected fixture submit");
  await provider.armToolContinuation(surface.lease,submitted.value,"cached-final-call");
  driver.queued.push({...driver.current,revision:"completed",turns:[...driver.current.turns,
   {key:"assistant",role:"assistant",parentUserTurnKey:"user-turn-1",phase:"complete",text:"Synthetic answer"}]});
  const continuing=await provider.waitForTurnEvent(surface.lease,submitted.value);
  expect(continuing.state==="proven"&&continuing.value.kind).toBe("continuing");
  driver.current={...driver.current,revision:"failed-after-completion",approval:recognizedApproval,
   turns:driver.current.turns.map(t=>t.role==="assistant"?{...t,phase:"failed",failureDetail:"Synthetic failure"}:t)};
  const failed=await provider.waitForTurnEvent(surface.lease,submitted.value);
  expect(failed.state==="proven"&&failed.value).toMatchObject({kind:"failed",detail:"Synthetic failure"});
  expect(driver.approvalCalls).toBe(0);
 }finally{await surface.host.close();}
});

test("inert checkpoint source uploads once and sends once, carrying its receipt only inside the file", async () => {
  const driver = new FixtureDriver(fixture("ready-new-chat"));
  const surface = await leaseFor(driver);
  const payload = request();
  const attachment = createChatGptContextAttachment(payload.physicalContext);
  const receipt = `ctxr_${"a".repeat(32)}`;
  try {
    const pending = new ChatGptSemanticProvider().submitTurn(surface.lease, {
      ...payload, inertSourceAttachment: { attachment, receipt },
    });
    while (driver.activated.length === 0) await Promise.resolve();
    driver.queued.push(acceptedSnapshot(driver));
    expect((await pending).state).toBe("proven");
    expect(driver.attachedFiles).toEqual([attachment.name]);
    expect(driver.activated).toHaveLength(1);
    expect(driver.contextAcknowledgement).toBe(`TELA_CONTEXT_ACK ${receipt}`);
  } finally { await surface.host.close(); }
});

test("inert checkpoint source rejects tool authority, preloads, retained deltas and corrupt files before browser mutation", async () => {
  const payload = request();
  const attachment = createChatGptContextAttachment(payload.physicalContext);
  const source = { attachment, receipt: `ctxr_${"a".repeat(32)}` };
  const cases: WebTurnRequest[] = [
    { ...toolRequest(), inertSourceAttachment: source },
    { ...payload, inertSourceAttachment: source, contextAttachment: attachment },
    { ...payload, inertSourceAttachment: source, physicalContext: { ...payload.physicalContext, mode: "retained-delta" } },
    { ...payload, inertSourceAttachment: { ...source, attachment: { ...attachment, sha256: "0".repeat(64) } } },
  ];
  for (const candidate of cases) {
    const driver = new FixtureDriver(fixture("ready-new-chat"));
    const surface = await leaseFor(driver);
    try {
      await expect(new ChatGptSemanticProvider().submitTurn(surface.lease, candidate)).rejects.toThrow();
      expect(driver.attachedFiles).toHaveLength(0);
      expect(driver.activated).toHaveLength(0);
    } finally { await surface.host.close(); }
  }
});
