import { webWorkingContextPolicy } from "./web-working-context-policy";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatGptWebFamilyKey, chatGptWebModelId,
  chatGptCheckpointInputTokens, chatGptWebCheckpointSourceTokenLimit } from "@chatgpt-tela/chatgpt";
import { ActiveTurnRegistry } from "@chatgpt-tela/runtime";
import { NativeToolInventory, defineNativeTurnAuthority, readDiagnosticTail } from "@chatgpt-tela/core";
import { FileContextCheckpointCache } from "./context-cache";
import { FileNativeVisiblePrefixStageJournal } from "./native-visible-prefix-journal";
import { createNativeRequestDevelopmentWebTurnPlanner, projectNativeRequestContext } from "./native-request-planner";
import { nativeCompactionPhysicalContext, nativeWorkingCheckpointScope, withExactCurrentInstructions } from "./native-working-context";
import { selectNativeWorkingCheckpoint } from "./native-working-context";
import { CheckpointPreparationBudget } from "./checkpoint-preparation-budget";

test("indexed historical steering cannot split a Native turn's call/result evidence at a fitted checkpoint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tela-import-boundary-"));
  try {
    const items = Array.from({ length: 3 }, (_, index) => [
      { turnId: `past-${index}`, item: { type: "userMessage", id: `user-${index}`, content: [] } },
      { turnId: `past-${index}`, item: { type: "dynamicToolCall", id: `call-${index}`, arguments: "A".repeat(500) } },
      { turnId: `past-${index}`, item: { type: "userMessage", id: `steer-${index}`, content: [] } },
      { turnId: `past-${index}`, item: { type: "functionCallOutput", id: `result-${index}`, output: "R".repeat(12_000) } },
    ]).flat();
    const projection = projectNativeRequestContext("task", { input: [{ role: "user", content: "Current work" }] },
      JSON.stringify({ type: "tela_native_visible_prefix_v1", items }));
    let calls = 0;
    const result = await selectNativeWorkingCheckpoint({ projection, currentTurnId: "current",
      cache: new FileContextCheckpointCache({ directory: join(directory, "cache") }),
      visiblePrefix: { accountNamespace: "account", journal: new FileNativeVisiblePrefixStageJournal({ directory: join(directory, "ledger"), initializationPath: join(directory, "init") }) },
      browserModel: { familyKey: "Fixture", effort: "high" },
      policy: { ...webWorkingContextPolicy("high"), checkpointSourceTokens: 5_000, suffixTargetTokens: 100 },
      preparationBudget: new CheckpointPreparationBudget(5_000),
      producer: async request => {
        calls++;
        const segments = JSON.parse(request.physicalContext.segments[0]!.content).source.items;
        const included: string[] = [];
        for (const segment of segments) {
          try { const entry = JSON.parse(segment.content); if (entry.item) included.push(entry.item.id); } catch { /* Historical header. */ }
        }
        expect(included).toEqual(["user-0", "call-0", "steer-0", "result-0"]);
        return { nativeTaskId: request.nativeTaskId, sourceRevisionId: request.sourceRevisionId, content: "Sealed complete historical turn" };
      },
    });
    expect(result.produced).toBe(true); expect(calls).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

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
  // Native compaction uses a full working bundle, unlike ordinary checkpoint-delta transport.
  const working = nativeCompactionPhysicalContext(projection, {
    checkpoint: { id: "verified", revisionId: projection.revisions[2]!.revision.id,
      estimatedTokens: 10 }, content: "Previous work was completed",
  } as any);
  expect(working.segments.filter(segment => segment.type === "revision"
    && segment.revisionId === later.revision.id)).toHaveLength(1);
  expect(withExactCurrentInstructions(working, projection)).toBe(working);

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
function registered(turnId: string, threadId = "task") {
  const claim = {
    threadId: threadId, turnId, requestKind: "turn" as const, toolObservations: [],
  };
  const authority = defineNativeTurnAuthority({
    threadId: threadId, turnId, cwd: "/fixture", workspaceRoots: ["/fixture"],
    sandbox: { kind: "read-only" as const, network: "restricted" as const },
  });
  return new ActiveTurnRegistry().register({ claim, authority,
    tools: NativeToolInventory.fromObservations(threadId, turnId, []),
    canonicalEvidence: { threadId: threadId, turnId, cwd: "/fixture",
      workspaceRoots: ["/fixture"], sandbox: authority.sandbox,
      proof: "turn-context", environmentSourceTurnId: turnId },
  });
}

test("checkpoint lookup reports the failed publication-read substage without replacing the exception", async () => {
  const directory = root();
  const failure = new Error("private checkpoint publication failure");
  const stages: string[] = [];
  const planner = createNativeRequestDevelopmentWebTurnPlanner({
    checkpointCache: new FileContextCheckpointCache({ directory: join(directory, "cache") }),
    visiblePrefix: {
      accountNamespace: "verified-fixture-account",
      journal: { async publishedCheckpoints() { throw failure; } } as any,
      async read(): Promise<never> { throw new Error("visible prefix read must not run"); },
    },
  });
  try {
    await expect(planner(registered("turn-checkpoint-lookup"), {
      model, reasoning: { effort: "high" }, input: [{ role: "user", content: "Current request" }],
    }, {
      signal: new AbortController().signal, onProgress() {},
      onPlannerSubstage(stage) { stages.push(stage); },
    })).rejects.toBe(failure);
    expect(stages).toContain("working_checkpoint_publication_read");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each([44_000, 140_000])("rolling derived context stays bounded across long archives, repeated physical rollovers and cache-loss restart (%i bytes per answer)", async (answerBytes) => {
  const directory = root();
  try {
    const cacheDir = join(directory, "cache");
    const journalOptions = { directory: join(directory, "ledger"), initializationPath: join(directory, "init") };
    const prefix = { accountNamespace: "verified-fixture-account",
      journal: new FileNativeVisiblePrefixStageJournal(journalOptions),
      async read(): Promise<never> { throw Error("request prefix is already readable"); },
    };
    const stageInputs: number[] = [];
    const sourceSamples: { mode: string; source?: {items?: {type?: string}[]} }[] = [];
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
      const beforePreparation = calls;
      const task = await planner(registered(`turn-${index}`), {
        model, reasoning: { effort: "high" }, instructions, input,
      });
      expect(calls - beforePreparation).toBeLessThanOrEqual(1);
      if (task.webEpochId !== priorEpoch) {
        generations++;
        priorEpoch = task.webEpochId;
        priorPhysical = `physical-${generations}`;
        expect(task.physicalContext.mode).not.toBe("retained-delta");
        expect(task.contextAttachment).toBeUndefined();
        if (index > 0) {
          // A new physical generation must not preload the growing Native archive.
          expect(task.physicalContext.transferTokens).toBeLessThan(answerBytes === 44_000 ? 24_000 : 95_000);
          expect(task.physicalContext.segments[0]).toMatchObject({
            type: "revision", kind: "system", content: instructions,
          });
          expect(task.physicalContext.segments.some(item => item.type === "checkpoint")).toBe(true);
          const checkpoint = task.physicalContext.segments.find(item => item.type === "checkpoint")!;
          const projection = projectNativeRequestContext("task", { model, instructions, input });
          const anchor = projection.revisions.findIndex(item => item.revision.id === checkpoint.sourceRevisionId);
          expect(anchor).toBeGreaterThanOrEqual(0);
          for (const revision of projection.revisions.slice(anchor + 1)) {
            expect(task.physicalContext.segments).toContainEqual(expect.objectContaining({
              type: "revision", revisionId: revision.revision.id, content: revision.content,
            }));
          }
        }
        initialTransfer ??= task.physicalContext.transferTokens;
      } else {
        // Maintenance changes the derived checkpoint, never the healthy Web conversation.
        expect(task.physicalContext.mode).toBe("retained-delta");
        expect(task.physicalContext.transferTokens).toBeLessThan(2_000);
      }
      expect(task.physicalContext.segments.at(-1)!.content).toBe(`Perform step ${index}.`);
      const answer = `Completed step ${index}: ` + "R".repeat(answerBytes);
      task.settle?.({ status: "completed", documentGeneration: 1,
        surfaceLeaseId: priorPhysical!, answer });
      input.push({ type: "message", role: "assistant", content: answer });
      input.push({ type: "message", role: "user", content: `Perform step ${index + 1}.` });
    }
    expect(generations).toBeGreaterThanOrEqual(3);
    // Checkpoint stages are driven by fitted suffix pressure, not turn count.
    // Require evidence of maintenance and bounded source, not a fixed stage tally.
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(31);
    expect(Math.max(...stageInputs)).toBeLessThanOrEqual(chatGptWebCheckpointSourceTokenLimit("high"));
    expect(sourceSamples.some(item => item.mode === "snapshot"
      && item.source?.items?.some(part => part.type === "checkpoint"))).toBe(true);

    const published = await prefix.journal.publishedCheckpoints!(
      (await import("./native-working-context")).nativeWorkingCheckpointScope(
        prefix.accountNamespace, "task", { familyKey: chatGptWebFamilyKey("Working Set Fixture"), effort: "high" }));
    expect(published.length).toBe(calls);
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
    expect(cold.physicalContext.transferTokens).toBeLessThan(answerBytes === 44_000 ? 24_000 : 95_000);
    expect(cold.physicalContext.segments.at(-1)!.content).toBe("Perform step 31.");
    // A newly appended suffix may require one legitimate maintenance stage.
    // Earlier sealed stages remain reusable after the disposable cache is lost.
    expect(calls - beforeRestart).toBeLessThanOrEqual(1);
    cold.settle?.({ status: "failed" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60_000);

test.each(["current request", "single historical exchange"])("irreducible %s refuses before any summary model call or page replacement", async (kind) => {
  const directory = root();
  try {
    let calls = 0;
    const planner = createNativeRequestDevelopmentWebTurnPlanner({
      checkpointCache: new FileContextCheckpointCache({ directory }),
      visiblePrefix: { accountNamespace: "verified-fixture-account",
        journal: new FileNativeVisiblePrefixStageJournal({ directory: join(directory, "ledger"), initializationPath: join(directory, "init") }),
        async read(): Promise<never> { throw Error("request is already readable"); } },
      checkpointProducer: async () => { calls++; throw Error("must not summarize irreducible input"); },
    });
    await expect(planner(registered("turn-large"), {
      model, reasoning: { effort: "high" },
      input: kind === "current request" ? [{ role: "user", content: "X".repeat(550_000) }]
        : [{ role: "user", content: "First request" },
          { role: "assistant", content: "X".repeat(550_000) },
          { role: "user", content: "Continue" }],
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

test("completed summaries reuse across model changes and exact-prefix forks, while account and edited ancestry stay isolated", async () => {
  const directory = root();
  const diagnosticFile = join(directory, "checkpoint-events.jsonl");
  const previousDiagnosticFile = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = diagnosticFile;
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
    const cacheReadFailed = await createNativeRequestDevelopmentWebTurnPlanner({
      ...options, checkpointPreparationPolicy: noSpending,
      checkpointCache: {
        async list() { throw Error("derived cache unavailable"); },
        put: cache.put.bind(cache), clear: cache.clear.bind(cache),
      },
    })(registered("cache-read-failed"), { model, reasoning: { effort: "high" }, input: source });
    expect(cacheReadFailed.physicalContext.mode).toBe("checkpoint-delta");
    cacheReadFailed.settle?.({ status: "failed" });
    expect(calls).toBe(1);
    await expect(createNativeRequestDevelopmentWebTurnPlanner({
      ...options, checkpointPreparationPolicy: noSpending,
    })(registered("edited-ancestor", "edited-task"), { model, reasoning: { effort: "high" },
      input: [{ ...source[0]!, content: "An altered original objective" }, ...source.slice(1)],
    })).rejects.toMatchObject({ budgetReason: "model_calls" });
    expect(calls).toBe(1);
    const fork = await createNativeRequestDevelopmentWebTurnPlanner({
      ...options, checkpointPreparationPolicy: noSpending,
    })(registered("edited-current", "child-task"), {
      model, reasoning: { effort: "high" },
      input: [...source.slice(0, 2), { role: "user", content: "Edited followup in child" }],
    });
    expect(fork.physicalContext.mode).toBe("checkpoint-delta");
    expect(fork.physicalContext.segments.at(-1)?.content).toBe("Edited followup in child");
    fork.settle?.({ status: "failed" });
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
      const pending = isolated(registered(`isolated-${variant.account}-${variant.effort}`), {
        model: variant.webModel, reasoning: { effort: variant.effort }, input: source,
      });
      if (variant.account !== "account-a") {
        await expect(pending).rejects.toMatchObject({ budgetReason: "model_calls" });
      } else {
        const reused = await pending;
        expect(reused.physicalContext.mode).toBe("checkpoint-delta");
        reused.settle?.({ status: "failed" });
      }
      expect(calls).toBe(1);
    }
    const stored = readDiagnosticTail(diagnosticFile);
    expect(stored.state).toBe("read");
    const selected = stored.events.filter(item => item.stage === "native_working_checkpoint_selected");
    expect(selected.some(item => item.reason_class === "no_candidate" && item.candidate_count === 0 && item.cached_candidate_count === 0
      && item.published_candidate_count === 0 && item.cache_read_failed === false)).toBe(true);
    expect(selected.some(item => item.reason_class === "selected" && item.checkpoint_reused === true && item.cached_candidate_count === 1
      && Number(item.published_candidate_count) >= 1)).toBe(true);
    expect(selected.some(item => item.checkpoint_reused === true && item.cache_read_failed === true
      && item.cached_candidate_count === 0 && Number(item.published_candidate_count) >= 1)).toBe(true);
    expect(selected.some(item => item.checkpoint_reused === false
      && Number(item.published_cross_scope_excluded_count) >= 1)).toBe(true);
    const raw = readFileSync(diagnosticFile, "utf8");
    expect(raw).not.toContain("Establish the task objective");
    expect(raw).not.toContain("Settled history");
    expect(raw).not.toContain("account-a");
  } finally {
    if (previousDiagnosticFile === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previousDiagnosticFile;
    rmSync(directory, { recursive: true, force: true });
  }
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
        expect(source.physicalContext.segments[0]).toMatchObject({ type: "checkpoint" });
        expect(source.physicalContext.segments.some(segment => segment.type === "revision"
          && segment.content === instructions)).toBe(false);
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
  expect((models as any[])[1].context_window).toBe(webWorkingContextPolicy("high").hard.contextWindowTokenLimit);
  expect((models as any[])[1].auto_compact_token_limit).toBe(webWorkingContextPolicy("high").hard.rolloverTokenLimit);
  expect((models as any[])[1]).not.toHaveProperty("max_output_tokens");
});

test("Native compaction leaves checkpoint-covered historical developer frames sealed", async () => {
  const directory = root();
  try {
    const cache = new FileContextCheckpointCache({ directory: join(directory, "cache") });
    const base = "Current Native base instruction";
    const frame = "Repeated historical model transition ".repeat(700);
    const input = [
      { role: "user", content: "Original task" },
      ...Array.from({ length: 18 }, (_, index) => ({ role: "developer", content: frame + index })),
      { role: "assistant", content: "Completed original task" },
      { role: "user", content: "Summarize the current task" },
    ];
    const projection = projectNativeRequestContext("task", { instructions: base, input });
    const checkpoint = projection.revisions.at(-2)!;
    await cache.put({ nativeTaskId: "task", revisionId: checkpoint.revision.id,
      content: "Verified task checkpoint; original history remains available for readback",
      estimatedTokens: 20,
      scopeFingerprint: nativeWorkingCheckpointScope("bound-account", "task", {
        familyKey: chatGptWebFamilyKey("Working Set Fixture"), effort: "high",
      }),
    });
    let calls = 0;
    const canonical = { threadId: "task", turnId: "compact", cwd: "/fixture",
      workspaceRoots: ["/fixture"], sandbox: { kind: "native-enforced" as const },
      proof: "app-server-active-turn" as const, environmentSourceTurnId: "compact" };
    const router = createNativeLocalCompactionRouter({
      source: { currentTurn: async () => canonical }, checkpointCache: cache,
      visiblePrefix: { accountNamespace: "bound-account", read: async () => { throw new Error("Unexpected opaque history read"); }, journal: new FileNativeVisiblePrefixStageJournal({
        directory: join(directory, "ledger"), initializationPath: join(directory, "init"),
      }) },
      summarize: async request => {
        calls++;
        expect(request.physicalContext.segments).toHaveLength(2);
        expect(request.physicalContext.segments[0]?.type).toBe("checkpoint");
        expect(request.physicalContext.segments[1]?.content).toBe("Summarize the current task");
        expect(chatGptCheckpointInputTokens(request.physicalContext)).toBeLessThan(2_000);
        return "Current continuation summary";
      },
    });
    const response = await router(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ model, reasoning: { effort: "high" }, instructions: base,
        input, tools: [], client_metadata: { "x-codex-turn-metadata": JSON.stringify({
          request_kind: "compaction", thread_id: "task", turn_id: "compact",
        }) },
      }),
    }));
    expect(response?.status).toBe(200);
    expect(calls).toBe(1);
    // Cold sources retain all instructions, rather than silently dropping material to fit.
    const cold = nativeCompactionPhysicalContext(projection);
    expect(chatGptCheckpointInputTokens(cold)).toBeGreaterThan(chatGptWebCheckpointSourceTokenLimit("high"));
    expect(cold.segments.filter(segment => segment.type === "revision"
      && (segment.kind === "developer" || segment.kind === "system"))).toHaveLength(19);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
