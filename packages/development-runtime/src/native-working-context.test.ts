import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatGptWebFamilyKey, chatGptWebModelId,
  chatGptCheckpointInputTokens, chatGptWebCheckpointSourceTokenLimit } from "@chatgpt-tela/chatgpt";
import { ActiveTurnRegistry } from "@chatgpt-tela/runtime";
import { NativeToolInventory, defineNativeTurnAuthority } from "@chatgpt-tela/core";
import { FileContextCheckpointCache } from "./context-cache";
import { FileNativeVisiblePrefixStageJournal } from "./native-visible-prefix-journal";
import { createNativeRequestDevelopmentWebTurnPlanner, projectNativeRequestContext } from "./native-request-planner";
import { withExactCurrentInstructions } from "./native-working-context";

test("checkpoint projection injects each exact current instruction revision only once", () => {
  const projection = projectNativeRequestContext("task", {
    instructions: "Current priority, retained without rewriting",
    input: [
      { role: "user", content: "Older request" },
      { role: "assistant", content: "Completed earlier work" },
      { role: "developer", content: "Later current developer instruction" },
      { role: "user", content: "Continue" },
    ],
  });
  const later = projection.revisions.at(-2)!;
  const request = projection.revisions.at(-1)!;
  const physical = {
    mode: "checkpoint-delta" as const,
    headRevisionId: projection.headId,
    activeRequestRevisionId: request.revision.id,
    baseRevisionId: projection.revisions[2]!.revision.id,
    logicalTokens: 500,
    transferTokens: 24,
    segments: [
      { type: "checkpoint" as const, checkpointId: "verified", sourceRevisionId: projection.revisions[2]!.revision.id, content: "Previous work was completed" },
      { type: "revision" as const, revisionId: later.revision.id, kind: later.revision.kind, content: later.content },
      { type: "revision" as const, revisionId: request.revision.id, kind: request.revision.kind, content: request.content },
    ],
  };
  const restored = withExactCurrentInstructions(physical, projection);
  expect(restored.segments.filter(segment => segment.type === "revision"
    && segment.kind === "developer" && segment.revisionId === later.revision.id)).toHaveLength(1);
  expect(restored.segments[0]).toMatchObject({ type: "revision", kind: "system",
    content: "Current priority, retained without rewriting" });
  expect(restored.transferTokens).toBe(physical.transferTokens + Math.ceil(Buffer.byteLength(projection.revisions[0]!.content) / 4));
  expect(withExactCurrentInstructions(restored, projection)).toBe(restored);

  const conflicting = { ...physical, segments: [physical.segments[0]!,
    { ...physical.segments[1]!, content: "Altered developer authority" }, physical.segments[2]!] };
  expect(() => withExactCurrentInstructions(conflicting, projection))
    .toThrow("conflicts with exact Native instruction ownership");

  const distinct = projectNativeRequestContext("task", {
    instructions: "Same exact words",
    input: [
      { role: "user", content: "First" }, { role: "assistant", content: "Completed" },
      { role: "developer", content: "Same exact words" }, { role: "user", content: "Next" },
    ],
  });
  const suffix = distinct.revisions.slice(-2).map(item => ({
    type: "revision" as const, revisionId: item.revision.id,
    kind: item.revision.kind, content: item.content,
  }));
  const alsoExact = withExactCurrentInstructions({ ...physical,
    headRevisionId: distinct.headId, segments: [physical.segments[0]!, ...suffix],
  }, distinct);
  expect(alsoExact.segments.filter(item => item.type === "revision"
    && item.content === "Same exact words")).toHaveLength(2);
});
import { createNativeLocalCompactionRouter } from "./native-local-compaction";

const model = chatGptWebModelId(chatGptWebFamilyKey("Working Set Fixture"));
const root = () => mkdtempSync(join(tmpdir(), "tela-rolling-context-"));
function registered(turnId: string) {
  const claim = {
    threadId: "task", turnId, requestKind: "turn" as const, toolObservations: [],
  };
  const authority = defineNativeTurnAuthority({
    threadId: "task", turnId, cwd: "/fixture", workspaceRoots: ["/fixture"],
    sandbox: { kind: "read-only" as const, network: "restricted" as const },
  });
  return new ActiveTurnRegistry().register({ claim, authority,
    tools: NativeToolInventory.fromObservations("task", turnId, []),
    canonicalEvidence: { threadId: "task", turnId, cwd: "/fixture",
      workspaceRoots: ["/fixture"], sandbox: authority.sandbox,
      proof: "turn-context", environmentSourceTurnId: turnId },
  });
}

test("rolling derived context stays bounded across long archives, repeated physical rollovers and cache-loss restart", async () => {
  const directory = root();
  try {
    const cacheDir = join(directory, "cache");
    const journalOptions = { directory: join(directory, "ledger"), initializationPath: join(directory, "init") };
    const prefix = { accountNamespace: "verified-fixture-account",
      journal: new FileNativeVisiblePrefixStageJournal(journalOptions),
      async read(): Promise<never> { throw Error("request prefix is already readable"); },
    };
    const stageInputs: number[] = [];
    const sourceSamples: { mode: string; fragment?: string; summaries?: unknown[] }[] = [];
    let calls = 0;
    const producer = async (input: any) => {
      calls++;
      const estimate = chatGptCheckpointInputTokens(input.physicalContext);
      stageInputs.push(estimate);
      expect(estimate).toBeLessThanOrEqual(chatGptWebCheckpointSourceTokenLimit("high"));
      sourceSamples.push(JSON.parse(input.physicalContext.segments[0].content));
      return { nativeTaskId: input.nativeTaskId, sourceRevisionId: input.sourceRevisionId,
        content: "Bounded rolling fixture summary: old specifics require authorized Native readback." };
    };
    const options = {
      checkpointCache: new FileContextCheckpointCache({ directory: cacheDir }),
      visiblePrefix: prefix,
      checkpointProducer: producer,
    };
    const planner = createNativeRequestDevelopmentWebTurnPlanner(options);
    const input: any[] = [{ type: "message", role: "user", content: "Perform step 0." }];
    const instructions = "Exact priority instruction: report only verified effects.";
    let generations = 0;
    let priorEpoch: string | undefined;
    let priorPhysical: string | undefined;
    let initialTransfer: number | undefined;
    for (let index = 0; index < 31; index++) {
      const task = await planner(registered(`turn-${index}`), {
        model, reasoning: { effort: "high" }, instructions, input,
      });
      if (task.webEpochId !== priorEpoch) {
        generations++;
        priorEpoch = task.webEpochId;
        priorPhysical = `physical-${generations}`;
        expect(task.physicalContext.mode).not.toBe("retained-delta");
        expect(task.contextAttachment).toBeUndefined();
        if (index > 0) {
          // A new physical generation must not preload the growing Native archive.
          expect(task.physicalContext.transferTokens).toBeLessThan(24_000);
          expect(task.physicalContext.segments[0]).toMatchObject({
            type: "revision", kind: "system", content: instructions,
          });
          expect(task.physicalContext.segments.some(item => item.type === "checkpoint")).toBe(true);
        }
        initialTransfer ??= task.physicalContext.transferTokens;
      } else {
        // Maintenance changes the derived checkpoint, never the healthy Web conversation.
        expect(task.physicalContext.mode).toBe("retained-delta");
        expect(task.physicalContext.transferTokens).toBeLessThan(2_000);
      }
      expect(task.physicalContext.segments.at(-1)!.content).toBe(`Perform step ${index}.`);
      const answer = `Completed step ${index}: ` + "R".repeat(44_000);
      task.settle?.({ status: "completed", documentGeneration: 1,
        surfaceLeaseId: priorPhysical!, answer });
      input.push({ type: "message", role: "assistant", content: answer });
      input.push({ type: "message", role: "user", content: `Perform step ${index + 1}.` });
    }
    expect(generations).toBeGreaterThanOrEqual(3);
    expect(calls).toBeGreaterThanOrEqual(5);
    expect(calls).toBeLessThan(31);
    expect(Math.max(...stageInputs)).toBeLessThan(45_000);
    expect(sourceSamples.some(item => item.mode === "fragment"
      && item.fragment?.includes('"type":"checkpoint"'))).toBe(true);

    const published = await prefix.journal.publishedCheckpoints!(
      (await import("./native-working-context")).nativeWorkingCheckpointScope(
        prefix.accountNamespace, "task", { familyKey: chatGptWebFamilyKey("Working Set Fixture"), effort: "high" }));
    expect(published.length).toBeGreaterThanOrEqual(5);
    const beforeRestart = calls;
    rmSync(cacheDir, { recursive: true, force: true });
    const restarted = createNativeRequestDevelopmentWebTurnPlanner({
      ...options,
      checkpointCache: new FileContextCheckpointCache({ directory: cacheDir }),
      visiblePrefix: { ...prefix, journal: new FileNativeVisiblePrefixStageJournal(journalOptions) },
    });
    const cold = await restarted(registered("turn-after-restart"), {
      model, reasoning: { effort: "high" }, instructions, input,
    });
    expect(cold.physicalContext.mode).toBe("checkpoint-delta");
    expect(cold.physicalContext.transferTokens).toBeLessThan(24_000);
    expect(cold.physicalContext.segments.at(-1)!.content).toBe("Perform step 31.");
    expect(calls).toBe(beforeRestart); // Journal publication survives disposable cache loss.
    cold.settle?.({ status: "failed" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60_000);

test("after initialization archive size varies by two orders while fresh seed, maintenance input and new model-call count stay bounded", async () => {
  const observed: Array<{ archiveBytes: number; seedTokens: number; updateTokens: number; newCalls: number }> = [];
  for (const size of [120_000, 1_200_000, 12_000_000]) {
    const directory = root();
    try {
      const cache = new FileContextCheckpointCache({ directory: join(directory, "cache") });
      const visiblePrefix = { accountNamespace: "stable-account",
        journal: new FileNativeVisiblePrefixStageJournal({
          directory: join(directory, "ledger"), initializationPath: join(directory, "init"),
        }), async read(): Promise<never> { throw Error("no raw history read"); } };
      const input: any[] = [
        { type: "message", role: "user", content: "Start the same kind of task" },
        { type: "message", role: "assistant", content: "A".repeat(size) },
        { type: "message", role: "user", content: "Continue the task" },
      ];
      let calls = 0;
      const stageSizes: number[] = [];
      const producer = async (request: any) => {
        calls++;
        stageSizes.push(chatGptCheckpointInputTokens(request.physicalContext));
        return { nativeTaskId: request.nativeTaskId,
          sourceRevisionId: request.sourceRevisionId, content: "Bounded settled work; original evidence needs Native readback" };
      };
      // Explicit bootstrap cost policy is intentionally not inherited by the
      // steady-state followups; it admits larger exceptional cold histories.
      const bootstrap = createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: cache, visiblePrefix, checkpointProducer: producer,
        checkpointPreparationPolicy: { maxModelCalls: 128, maxInputTokens: 20_000_000,
          maxElapsedMs: 600_000 },
      });
      const first = await bootstrap(registered("initial"), {
        model, reasoning: { effort: "high" }, input,
      });
      expect(first.physicalContext.mode).toBe("checkpoint-delta");
      first.settle?.({ status: "failed" });
      const initialCalls = calls;
      expect(initialCalls).toBeGreaterThanOrEqual(1);
      // Reopened planner uses only default finite preparation settings.
      const steady = createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: new FileContextCheckpointCache({ directory: join(directory, "cache") }),
        visiblePrefix: { ...visiblePrefix, journal: new FileNativeVisiblePrefixStageJournal({
          directory: join(directory, "ledger"), initializationPath: join(directory, "init"),
        }) },
        checkpointProducer: producer,
      });
      input.push({ type: "message", role: "assistant", content: "R".repeat(60_000) });
      input.push({ type: "message", role: "user", content: "Perform identical next task" });
      const followup = await steady(registered("fresh"), {
        model, reasoning: { effort: "high" }, input,
      });
      expect(followup.physicalContext.mode).toBe("checkpoint-delta");
      expect(followup.physicalContext.segments.at(-1)?.content).toBe("Perform identical next task");
      expect(followup.contextAttachment).toBeUndefined();
      followup.settle?.({ status: "failed" });
      const newCalls = calls - initialCalls;
      expect(newCalls).toBe(1);
      const updateTokens = stageSizes.at(-1)!;
      expect(updateTokens).toBeLessThan(30_000);
      expect(followup.physicalContext.transferTokens).toBeLessThan(24_000);
      observed.push({ archiveBytes: size, seedTokens: followup.physicalContext.transferTokens,
        updateTokens, newCalls });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  expect(observed).toHaveLength(3);
  expect(Math.max(...observed.map(item => item.seedTokens))).toBeLessThan(24_000);
  expect(Math.max(...observed.map(item => item.updateTokens))
    - Math.min(...observed.map(item => item.updateTokens))).toBeLessThan(2_000);
}, 60_000);

test("irreducible current user request refuses before any summary model call or page replacement", async () => {
  const directory = root();
  try {
    let calls = 0;
    const planner = createNativeRequestDevelopmentWebTurnPlanner({
      checkpointCache: new FileContextCheckpointCache({ directory }),
      checkpointProducer: async () => { calls++; throw Error("must not summarize active request"); },
    });
    await expect(planner(registered("turn-large"), {
      model, reasoning: { effort: "high" },
      input: [{ role: "user", content: "X".repeat(550_000) }],
    })).rejects.toThrow("requires a verified checkpoint");
    expect(calls).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an exact active request may exceed the soft first-message target without being truncated", async () => {
  const text = "X".repeat(370_000);
  const plan = await createNativeRequestDevelopmentWebTurnPlanner()(registered("large-but-admissible"), {
    model, reasoning: { effort: "high" }, input: [{ role: "user", content: text }],
  });
  expect(plan.physicalContext.mode).toBe("full");
  expect(plan.physicalContext.segments).toHaveLength(1);
  expect(plan.physicalContext.segments[0]!.content).toBe(text);
  expect(plan.physicalContext.transferTokens).toBeGreaterThan(24_000);
  expect(plan.contextAttachment).toBeUndefined();
  plan.settle?.({ status: "failed" });
});

test("large Web-released Native tool output consumes physical residency and forces a new owned epoch", async () => {
  const planner = createNativeRequestDevelopmentWebTurnPlanner();
  const first = await planner(registered("first"), {
    model, reasoning: { effort: "high" },
    input: [{ role: "user", content: "A bounded first request" }],
  });
  const initialEpoch = first.webEpochId;
  first.settle?.({ status: "completed", surfaceLeaseId: "surface-fixture",
    documentGeneration: 1, answer: "Done.",
    releasedToolResultBytes: 500_000, toolRoundCount: 1 });
  const second = await planner(registered("second"), {
    model, reasoning: { effort: "high" },
    input: [
      { role: "user", content: "A bounded first request" },
      { role: "assistant", content: "Done." },
      { role: "user", content: "Follow up" },
    ],
  });
  expect(second.physicalContext.mode).not.toBe("retained-delta");
  expect(second.webEpochId).not.toBe(initialEpoch);
  expect(second.diagnostics).toMatchObject({ physical_rollover: true });
  expect(second.physicalContext.segments.at(-1)?.content).toBe("Follow up");
  second.settle?.({ status: "failed" });
});

test("zero-budget optional maintenance cannot block a proven healthy retained page", async () => {
  const directory = root();
  try {
    let calls = 0;
    const planner = createNativeRequestDevelopmentWebTurnPlanner({
      checkpointCache: new FileContextCheckpointCache({ directory: join(directory, "cache") }),
      visiblePrefix: { accountNamespace: "retained-account",
        journal: new FileNativeVisiblePrefixStageJournal({
          directory: join(directory, "journal"), initializationPath: join(directory, "initialization"),
        }), async read(): Promise<never> { throw Error("no historical page needed"); } },
      checkpointPreparationPolicy: { maxModelCalls: 0, maxInputTokens: 0, maxElapsedMs: 600_000 },
      checkpointProducer: async () => { calls++; throw Error("must not call"); },
    });
    const first = await planner(registered("retained-first"), {
      model, reasoning: { effort: "high" }, input: [{ role: "user", content: "Start" }],
    });
    const answer = "A".repeat(65_000);
    first.settle?.({ status: "completed", documentGeneration: 1,
      surfaceLeaseId: "owned-page", answer });
    const next = await planner(registered("retained-next"), {
      model, reasoning: { effort: "high" }, input: [
        { role: "user", content: "Start" },
        { role: "assistant", content: answer },
        { role: "user", content: "Continue exactly" },
      ],
    });
    expect(next.physicalContext.mode).toBe("retained-delta");
    expect(next.webEpochId).toBe(first.webEpochId);
    expect(next.physicalContext.segments.at(-1)?.content).toBe("Continue exactly");
    expect(calls).toBe(0);
    next.settle?.({ status: "failed" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("completed summaries reuse only under the exact account, Web family, effort and active ancestry", async () => {
  const directory = root();
  try {
    const cache = new FileContextCheckpointCache({ directory: join(directory, "cache") });
    const journal = new FileNativeVisiblePrefixStageJournal({
      directory: join(directory, "ledger"), initializationPath: join(directory, "init"),
    });
    let calls = 0;
    const checkpointProducer = async (source: any) => {
      calls++;
      return { nativeTaskId: source.nativeTaskId, sourceRevisionId: source.sourceRevisionId,
        content: "One settled objective and its readback obligation" };
    };
    const source = [
      { role: "user", content: "Establish the task objective" },
      { role: "assistant", content: "Settled history ".repeat(12_500) },
      { role: "user", content: "Perform current work" },
    ];
    const options = {
      checkpointCache: cache, checkpointProducer,
      visiblePrefix: { accountNamespace: "account-a", journal,
        async read(): Promise<never> { throw Error("unexpected original-history paging"); } },
    };
    const prepared = await createNativeRequestDevelopmentWebTurnPlanner(options)(
      registered("source"), { model, reasoning: { effort: "high" }, input: source });
    expect(prepared.physicalContext.mode).toBe("checkpoint-delta");
    expect(calls).toBe(1);
    prepared.settle?.({ status: "failed" });
    const noSpending = { maxModelCalls: 0, maxInputTokens: 0, maxElapsedMs: 600_000 };
    const same = await createNativeRequestDevelopmentWebTurnPlanner({
      ...options, checkpointPreparationPolicy: noSpending,
    })(registered("reused"), { model, reasoning: { effort: "high" },
      input: [...source.slice(0, 2), { role: "user", content: "A changed current request" }] });
    expect(same.physicalContext.mode).toBe("checkpoint-delta");
    expect(same.physicalContext.segments.at(-1)?.content).toBe("A changed current request");
    same.settle?.({ status: "failed" });
    expect(calls).toBe(1);
    for (const variant of [
      { account: "account-b", webModel: model, effort: "high" },
      { account: "account-a", webModel: chatGptWebModelId(chatGptWebFamilyKey("Another Family")), effort: "high" },
      { account: "account-a", webModel: model, effort: "medium" },
    ] as const) {
      const isolated = createNativeRequestDevelopmentWebTurnPlanner({
        ...options, checkpointPreparationPolicy: noSpending,
        visiblePrefix: { ...options.visiblePrefix, accountNamespace: variant.account },
      });
      await expect(isolated(registered(`isolated-${variant.account}-${variant.effort}`), {
        model: variant.webModel, reasoning: { effort: variant.effort }, input: source,
      })).rejects.toMatchObject({ budgetReason: "model_calls" });
      expect(calls).toBe(1);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a past edit cannot inherit the old derived branch; losing the entire stage journal fails closed", async () => {
  const directory = root();
  try {
    const cacheDir = join(directory, "cache");
    const ledgerDir = join(directory, "ledger");
    const initPath = join(directory, "journal-initialized");
    const journal = new FileNativeVisiblePrefixStageJournal({
      directory: ledgerDir, initializationPath: initPath,
    });
    let calls = 0;
    const options = {
      checkpointCache: new FileContextCheckpointCache({ directory: cacheDir }),
      visiblePrefix: { accountNamespace: "bound-account", journal,
        async read(): Promise<never> { throw Error("No off-request paging"); } },
      checkpointProducer: async (input: any) => {
        calls++;
        return { nativeTaskId: input.nativeTaskId, sourceRevisionId: input.sourceRevisionId,
          content: "Historical task state only, not original source authority" };
      },
    };
    const original: any[] = [
      { type: "message", role: "user", content: "Original first task" },
      { type: "message", role: "assistant", content: "A".repeat(56_000) },
      { type: "message", role: "user", content: "Continue after the original work" },
    ];
    const base = await createNativeRequestDevelopmentWebTurnPlanner(options)(
      registered("initial"), { model, reasoning: { effort: "high" }, input: original });
    expect(calls).toBe(1);
    expect(base.physicalContext.mode).toBe("checkpoint-delta");
    base.settle?.({ status: "failed" });
    const count = calls;

    // Changed oldest content changes every descendant Native revision ID; no
    // text-similarity or journal pointer is allowed to reattach the old branch.
    const edited = structuredClone(original);
    edited[0].content = "Past task has been materially edited";
    const zeroBudget = {
      ...options,
      checkpointPreparationPolicy: { maxModelCalls: 0, maxInputTokens: 0, maxElapsedMs: 600_000 },
    };
    await expect(createNativeRequestDevelopmentWebTurnPlanner(zeroBudget)(
      registered("edited"), { model, reasoning: { effort: "high" }, input: edited }))
      .rejects.toThrow("requires a verified checkpoint");
    expect(calls).toBe(count);

    // A disposable cache may disappear while completed model stages and the
    // published checkpoint still exist in the account's durable journal.
    rmSync(cacheDir, { recursive: true, force: true });
    const recovered = await createNativeRequestDevelopmentWebTurnPlanner({
      ...options, checkpointCache: new FileContextCheckpointCache({ directory: cacheDir }),
      visiblePrefix: { ...options.visiblePrefix,
        journal: new FileNativeVisiblePrefixStageJournal({
          directory: ledgerDir, initializationPath: initPath,
        }) },
    })(registered("cache-lost"), { model, reasoning: { effort: "high" }, input: original });
    expect(recovered.physicalContext.mode).toBe("checkpoint-delta");
    expect(calls).toBe(count);
    recovered.settle?.({ status: "failed" });

    // Initialization receipt outlives the whole journal. A fresh empty
    // execution ledger must NOT authorize replay of potentially sent work.
    rmSync(ledgerDir, { recursive: true, force: true });
    await expect(createNativeRequestDevelopmentWebTurnPlanner({
      ...options, checkpointCache: new FileContextCheckpointCache({ directory: cacheDir }),
      visiblePrefix: { ...options.visiblePrefix,
        journal: new FileNativeVisiblePrefixStageJournal({
          directory: ledgerDir, initializationPath: initPath,
        }) },
    })(registered("ledger-lost"), { model, reasoning: { effort: "high" }, input: original }))
      .rejects.toThrow();
    expect(calls).toBe(count);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("unresolved historical media is never silently folded into a text-only checkpoint", async () => {
  const directory = root();
  try {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9RwvWgAAAABJRU5ErkJggg==";
    let calls = 0;
    const planner = createNativeRequestDevelopmentWebTurnPlanner({
      checkpointCache: new FileContextCheckpointCache({ directory: join(directory, "cache") }),
      visiblePrefix: { accountNamespace: "bound-account",
        journal: new FileNativeVisiblePrefixStageJournal({
          directory: join(directory, "ledger"), initializationPath: join(directory, "init"),
        }), async read(): Promise<never> { throw Error("not needed"); } },
      checkpointProducer: async () => { calls++; throw Error("must not summarize uncarried historical media"); },
    });
    await expect(planner(registered("media"), {
      model, reasoning: { effort: "high" },
      input: [
        { type: "message", role: "user", content: [
          { type: "input_text", text: "Original image; exact evidence is required" },
          { type: "input_image", image_url: png },
        ] },
        { type: "message", role: "assistant", content: "A".repeat(100_000) },
        { type: "message", role: "user", content: "Use original image in the next step" },
      ],
    })).rejects.toThrow("requires a verified checkpoint");
    expect(calls).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Native local compaction reuses the ordinary request's compatible working checkpoint with one final summary call", async () => {
  const directory = root();
  try {
    const journal = new FileNativeVisiblePrefixStageJournal({
      directory: join(directory, "ledger"), initializationPath: join(directory, "init"),
    });
    const cache = new FileContextCheckpointCache({ directory: join(directory, "cache") });
    const visiblePrefix = { accountNamespace: "bound-account", journal,
      async read(): Promise<never> { throw Error("already-readable canonical source"); } };
    const old = "R".repeat(80_000);
    const input = [
      { type: "message", role: "user", content: "The first task" },
      { type: "message", role: "assistant", content: old },
      { type: "message", role: "user", content: "Summarize the current task" },
    ];
    const instructions = "Current mandatory task policy";
    let maintenanceCalls = 0;
    const checkpointProducer = async (source: any) => {
      maintenanceCalls++;
      return { nativeTaskId: source.nativeTaskId, sourceRevisionId: source.sourceRevisionId,
        content: "Verified derived working-state summary: previous task done" };
    };
    const planned = await createNativeRequestDevelopmentWebTurnPlanner({
      checkpointCache: cache, visiblePrefix, checkpointProducer,
    })(registered("ordinary"), { model, reasoning: { effort: "high" }, input, instructions });
    expect(planned.physicalContext.mode).toBe("checkpoint-delta");
    expect(maintenanceCalls).toBe(1);
    planned.settle?.({ status: "failed" });
    let summaries = 0;
    const canonical = { threadId: "task", turnId: "compact", cwd: "/fixture",
      workspaceRoots: ["/fixture"], sandbox: { kind: "native-enforced" as const },
      proof: "app-server-active-turn" as const, environmentSourceTurnId: "compact" };
    const router = createNativeLocalCompactionRouter({
      source: { currentTurn: async () => canonical },
      checkpointCache: cache, visiblePrefix,
      summarize: async source => {
        summaries++;
        expect(source.physicalContext.segments[0]).toMatchObject({
          type: "revision", kind: "system", content: instructions,
        });
        expect(source.physicalContext.segments[1]).toMatchObject({ type: "checkpoint" });
        expect(source.physicalContext.segments.at(-1)).toMatchObject({
          kind: "user", content: "Summarize the current task",
        });
        expect(source.physicalContext.segments.map(item => item.content).join(""))
          .not.toContain(old.slice(0, 256));
        return "Current readable Native continuation summary";
      },
    });
    const response = await router(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({
        model, reasoning: { effort: "high" }, tools: [], instructions, input,
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({
          request_kind: "compaction", thread_id: "task", turn_id: "compact",
        }) },
      }),
    }));
    expect(response?.status).toBe(200);
    expect(summaries).toBe(1);
    expect(maintenanceCalls).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Web model metadata is scoped to Web evidence, not inherited Native capacity", async () => {
  const { augmentNativeCodexModelCatalog } = await import("./web-model-catalog");
  const source = { models: [{ slug: "native", visibility: "list",
    supported_reasoning_levels: [{ effort: "high", description: "Native High" }],
    context_window: 1_000_000, auto_compact_token_limit: 900_000,
    max_output_tokens: 500_000 }] };
  const { models } = augmentNativeCodexModelCatalog(source, [{
    key: chatGptWebFamilyKey("Working Set Fixture"), label: "Working Set Fixture",
    availableEfforts: ["high"],
  }]);
  expect((models as any[])[0]).toEqual(source.models[0]);
  expect((models as any[])[1]).not.toHaveProperty("context_window");
  expect((models as any[])[1]).not.toHaveProperty("auto_compact_token_limit");
  expect((models as any[])[1]).not.toHaveProperty("max_output_tokens");
});
