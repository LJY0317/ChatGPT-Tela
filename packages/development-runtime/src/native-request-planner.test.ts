import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatGptWebFamilyKey,
  chatGptWebModelId,
} from "@chatgpt-tela/chatgpt";
import {
  NativeToolInventory,
  defineNativeTurnAuthority,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import { ActiveTurnRegistry } from "@chatgpt-tela/runtime";
import { FileContextCheckpointCache } from "./context-cache";
import {
  createNativeRequestDevelopmentWebTurnPlanner,
  projectNativeRequestContext,
} from "./native-request-planner";

function binding(): NativeTurnBinding {
  const tools = [{
    wireName: "exec_command",
    name: "exec_command",
    description: "command",
    kind: "function" as const,
    inputSchema: { type: "object" },
  }];
  return {
    claim: {
      threadId: "thread-1",
      turnId: "turn-1",
      requestKind: "turn",
      toolObservations: [{ source: "fixture", tools }],
    },
    authority: defineNativeTurnAuthority({
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "/private/workspace",
      workspaceRoots: ["/private/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
    }),
    tools: NativeToolInventory.fromObservations("thread-1", "turn-1", [
      { source: "fixture", tools },
    ]),
    canonicalEvidence: {
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "/private/workspace",
      workspaceRoots: ["/private/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
      proof: "turn-context",
      environmentSourceTurnId: "turn-1",
    },
  };
}

function registered() {
  return new ActiveTurnRegistry().register(binding());
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "chatgpt-tela-native-planner-test-"));
}

describe("Native request development Web planner", () => {
  test("projects request instructions/input through the logical -> physical context boundary", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const turn = registered();
    const request = {
      instructions: "Follow the current Codex task.",
      client_metadata: {
        "x-codex-turn-metadata": {
          thread_id: "thread-1",
          turn_id: "turn-1",
          cwd: "/must-not-enter-web-context",
        },
      },
      tools: [{
        type: "function",
        name: "secret_tool_schema",
        description: "must not enter web context",
      }],
      input: [
        { type: "reasoning", encrypted_content: "opaque-native-state" },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Preserve developer priority." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the repository." }],
        },
        {
          type: "function_call",
          call_id: "old-call",
          name: "exec_command",
          arguments: "{\"cmd\":[\"pwd\"]}",
        },
        {
          type: "function_call_output",
          call_id: "old-call",
          output: "/workspace",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Repository inspected." }],
        },
      ],
    };

    const plan = await planner(turn, request);
    expect(plan.nativeTaskId).toBe("thread-1");
    expect(plan.webEpochId).toMatch(/^dev_epoch_/);
    expect(plan.physicalContext.mode).toBe("full");
    const activeRequest = plan.physicalContext.segments.find(segment =>
      segment.type === "revision" && segment.revisionId === plan.physicalContext.activeRequestRevisionId);
    expect(activeRequest).toMatchObject({
      type: "revision",
      kind: "user",
      content: "Inspect the repository.",
    });
    expect(plan.physicalContext.logicalTokens).toBe(plan.physicalContext.transferTokens);
    expect(plan.physicalContext.segments.map(segment => (
      segment.type === "revision" ? segment.kind : "checkpoint"
    ))).toEqual(["system", "developer", "user", "tool-call", "tool-result", "assistant"]);

    const serialized = JSON.stringify(plan.physicalContext);
    expect(serialized).toContain("Follow the current Codex task.");
    expect(serialized).toContain("Preserve developer priority.");
    expect(serialized).toContain("Inspect the repository.");
    expect(serialized).toContain("old-call");
    expect(serialized).not.toContain("must-not-enter-web-context");
    expect(serialized).not.toContain("secret_tool_schema");
    expect(serialized).not.toContain("opaque-native-state");

    plan.settle?.({ status: "failed" });
    const replay = await planner(turn, structuredClone(request));
    expect(replay.webEpochId).toBe(plan.webEpochId);
    expect(replay.physicalContext).toEqual(plan.physicalContext);
    replay.settle?.({ status: "failed" });
  });

  test("fails closed on attachment content instead of silently flattening it into text", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    await expect(planner(registered(), {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,..." }],
      }],
    })).rejects.toThrow("input_image content is not supported");
  });

  test("fails closed when the Native request has no supported logical context", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    await expect(planner(registered(), {
      input: [{ type: "reasoning", encrypted_content: "opaque" }],
    })).rejects.toThrow("no supported logical context");
  });

  test("synthetic Web model ids carry exact browser family/effort selection while Native ids do not", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const familyKey = chatGptWebFamilyKey("Observed Family");
    const web = await planner(registered(), {
      model: chatGptWebModelId(familyKey),
      reasoning: { effort: "xhigh" },
      input: [{ type: "message", role: "user", content: "Use the Web route." }],
    });
    expect(web.browserModel).toEqual({ familyKey, effort: "xhigh" });
    web.settle?.({ status: "failed" });

    const native = await planner(registered(), {
      model: "gpt-native",
      reasoning: { effort: "high" },
      input: [{ type: "message", role: "user", content: "Native route fixture." }],
    });
    expect(native.browserModel).toBeUndefined();
    native.settle?.({ status: "failed" });
  });

  test("synthetic Web model ids fail before browser work when reasoning effort is absent or unsupported", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const model = chatGptWebModelId(chatGptWebFamilyKey("Observed Family"));
    await expect(planner(registered(), {
      model,
      input: [{ type: "message", role: "user", content: "missing effort" }],
    })).rejects.toThrow("supported reasoning effort");
    await expect(planner(registered(), {
      model,
      reasoning: { effort: "future-effort" },
      input: [{ type: "message", role: "user", content: "bad effort" }],
    })).rejects.toThrow("supported reasoning effort");
  });

  test("canonical prefixes keep stable revision ids across later turns and append-only steering-like input", () => {
    const earlier = projectNativeRequestContext("thread-1", {
      instructions: "Keep repository context.",
      input: [
        { type: "message", role: "user", content: "Inspect A." },
        { type: "message", role: "assistant", content: "A inspected." },
      ],
    });
    const later = projectNativeRequestContext("thread-1", {
      instructions: "Keep repository context.",
      input: [
        { type: "message", role: "user", content: "Inspect A." },
        { type: "message", role: "assistant", content: "A inspected." },
        { type: "message", role: "user", content: "Now inspect B instead." },
      ],
    });

    expect(later.revisions.slice(0, earlier.revisions.length).map(item => item.revision.id))
      .toEqual(earlier.revisions.map(item => item.revision.id));
    expect(later.headId).not.toBe(earlier.headId);
  });

  test("committed Web answers retain one epoch and send only the exact later Native suffix", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const first = await planner(registered(), {
      model: "native-model-a",
      reasoning: { effort: "high" },
      instructions: "Keep working in the same repository.",
      input: [{ type: "message", role: "user", content: "Inspect A." }],
    });
    expect(first.physicalContext.mode).toBe("full");
    first.settle?.({ status: "completed", answer: "A inspected." });

    const second = await planner(registered(), {
      model: "native-model-a",
      reasoning: { effort: "high" },
      instructions: "Keep working in the same repository.",
      input: [
        { type: "message", role: "user", content: "Inspect A." },
        { type: "message", role: "assistant", content: "A inspected." },
        { type: "message", role: "user", content: "Now inspect B." },
      ],
    });

    expect(second.webEpochId).toBe(first.webEpochId);
    expect(second.physicalContext).toMatchObject({
      mode: "retained-delta",
      activeRequestRevisionId: second.physicalContext.headRevisionId,
    });
    expect(second.physicalContext.baseRevisionId).toBeDefined();
    expect(second.physicalContext.logicalTokens).toBeGreaterThan(second.physicalContext.transferTokens);
    expect(second.physicalContext.segments).toEqual([
      expect.objectContaining({ type: "revision", kind: "user", content: "Now inspect B." }),
    ]);
    second.settle?.({ status: "completed", answer: "B inspected." });

    const third = await planner(registered(), {
      model: "native-model-a",
      reasoning: { effort: "high" },
      instructions: "Keep working in the same repository.",
      input: [
        { type: "message", role: "user", content: "Inspect A." },
        { type: "message", role: "assistant", content: "A inspected." },
        { type: "message", role: "user", content: "Now inspect B." },
        { type: "message", role: "assistant", content: "B inspected." },
        { type: "message", role: "user", content: "Finally inspect C." },
      ],
    });
    expect(third.webEpochId).toBe(first.webEpochId);
    expect(third.physicalContext.mode).toBe("retained-delta");
    expect(third.physicalContext.segments.map(segment => (
      segment.type === "revision" ? segment.content : "checkpoint"
    ))).toEqual(["Finally inspect C."]);
    third.settle?.({ status: "failed" });
  });

  test("retained continuation fails closed to a fresh epoch when ancestry, answer, or route identity changes", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const firstRequest = {
      model: "native-model-a",
      reasoning: { effort: "medium" },
      instructions: "Stable authority.",
      input: [{ type: "message", role: "user", content: "Do A." }],
    };
    const first = await planner(registered(), firstRequest);
    first.settle?.({ status: "completed", answer: "A done." });

    const changedModel = await planner(registered(), {
      ...firstRequest,
      model: "native-model-b",
      input: [
        { type: "message", role: "user", content: "Do A." },
        { type: "message", role: "assistant", content: "A done." },
        { type: "message", role: "user", content: "Do B." },
      ],
    });
    expect(changedModel.physicalContext.mode).toBe("full");
    expect(changedModel.webEpochId).not.toBe(first.webEpochId);
    changedModel.settle?.({ status: "failed" });

    const changedBranch = await planner(registered(), {
      model: "native-model-a",
      reasoning: { effort: "medium" },
      instructions: "Different authority.",
      input: [
        { type: "message", role: "user", content: "Different A." },
        { type: "message", role: "assistant", content: "A done." },
        { type: "message", role: "user", content: "Do B." },
      ],
    });
    expect(changedBranch.physicalContext.mode).toBe("full");
    changedBranch.settle?.({ status: "failed" });

    const wrongAnswer = await planner(registered(), {
      ...firstRequest,
      input: [
        { type: "message", role: "user", content: "Do A." },
        { type: "message", role: "assistant", content: "Different answer." },
        { type: "message", role: "user", content: "Do B." },
      ],
    });
    expect(wrongAnswer.physicalContext.mode).toBe("full");
    wrongAnswer.settle?.({ status: "failed" });
  });

  test("failed plans clear transactional pending state without advancing retained context", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const request = { input: [{ type: "message", role: "user", content: "Do A." }] };
    const first = await planner(registered(), request);
    await expect(planner(registered(), request)).rejects.toThrow("unsettled Web context plan");
    first.settle?.({ status: "failed" });
    const retry = await planner(registered(), request);
    expect(retry.webEpochId).toBe(first.webEpochId);
    expect(retry.physicalContext).toEqual(first.physicalContext);
    retry.settle?.({ status: "failed" });
  });

  test("persistent checkpoints reduce physical transfer while canonical Native history remains rebuildable", async () => {
    const root = scratch();
    try {
      const request = {
        instructions: "I".repeat(160),
        input: [
          { type: "message", role: "user", content: "U".repeat(160) },
          { type: "message", role: "assistant", content: "A".repeat(20) },
          { type: "message", role: "user", content: "N".repeat(20) },
        ],
      };
      const projection = projectNativeRequestContext("thread-1", request);
      const anchor = projection.revisions[1]?.revision;
      if (!anchor) throw new Error("fixture anchor missing");
      const cache = new FileContextCheckpointCache({ directory: root });
      const checkpoint = await cache.put({
        nativeTaskId: "thread-1",
        revisionId: anchor.id,
        content: "accepted compact projection of the first two revisions",
        estimatedTokens: 8,
      });

      const plannerAfterRestart = createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: new FileContextCheckpointCache({ directory: root }),
        budgetTokens: 30,
      });
      const compact = await plannerAfterRestart(registered(), request);
      expect(compact.physicalContext.mode).toBe("checkpoint-delta");
      expect(compact.physicalContext.logicalTokens).toBeGreaterThan(compact.physicalContext.transferTokens);
      expect(compact.physicalContext.segments[0]).toEqual({
        type: "checkpoint",
        checkpointId: checkpoint.checkpoint.id,
        sourceRevisionId: anchor.id,
        content: "accepted compact projection of the first two revisions",
      });
      expect(compact.physicalContext.segments.slice(1).map(segment => (
        segment.type === "revision" ? segment.content : "checkpoint"
      ))).toEqual(["A".repeat(20), "N".repeat(20)]);

      await cache.clear("thread-1");
      const withoutCache = await createNativeRequestDevelopmentWebTurnPlanner()(registered(), request);
      expect(withoutCache.physicalContext.mode).toBe("full");
      expect(withoutCache.physicalContext.headRevisionId).toBe(compact.physicalContext.headRevisionId);
      expect(withoutCache.physicalContext.segments.map(segment => (
        segment.type === "revision" ? segment.content : "checkpoint"
      ))).toEqual([
        "I".repeat(160),
        "U".repeat(160),
        "A".repeat(20),
        "N".repeat(20),
      ]);
      await expect(createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: cache,
        budgetTokens: 30,
      })(registered(), request)).rejects.toThrow("requires a checkpoint");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("one dedicated producer checkpoint compacts only the canonical prefix and preserves the newest revision exact", async () => {
    const root = scratch();
    try {
      const request = {
        instructions: "I".repeat(160),
        input: [
          { type: "message", role: "user", content: "U".repeat(160) },
          { type: "message", role: "assistant", content: "A".repeat(80) },
          { type: "message", role: "user", content: "N".repeat(20) },
        ],
      };
      const produced: Array<{
        sourceRevisionId: string;
        contents: string[];
      }> = [];
      const cache = new FileContextCheckpointCache({ directory: root });
      const planner = createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: cache,
        budgetTokens: 30,
        checkpointProducer(input) {
          produced.push({
            sourceRevisionId: input.sourceRevisionId,
            contents: input.physicalContext.segments.map(segment => (
              segment.type === "revision" ? segment.content : "unexpected-checkpoint"
            )),
          });
          return {
            nativeTaskId: input.nativeTaskId,
            sourceRevisionId: input.sourceRevisionId,
            content: "compact prefix",
          };
        },
      });

      const plan = await planner(registered(), request);
      expect(produced).toHaveLength(1);
      expect(produced[0]?.contents).toEqual([
        "I".repeat(160),
        "U".repeat(160),
        "A".repeat(80),
      ]);
      expect(plan.physicalContext.mode).toBe("checkpoint-delta");
      expect(plan.physicalContext.segments[0]).toMatchObject({
        type: "checkpoint",
        sourceRevisionId: produced[0]?.sourceRevisionId,
        content: "compact prefix",
      });
      expect(plan.physicalContext.segments.at(-1)).toMatchObject({
        type: "revision",
        kind: "user",
        content: "N".repeat(20),
      });
      expect(await cache.list("thread-1")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("producer source mismatch fails before cache mutation", async () => {
    const root = scratch();
    try {
      const cache = new FileContextCheckpointCache({ directory: root });
      const planner = createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: cache,
        budgetTokens: 10,
        checkpointProducer(input) {
          return {
            nativeTaskId: input.nativeTaskId,
            sourceRevisionId: "wrong-source",
            content: "must not persist",
          };
        },
      });
      await expect(planner(registered(), {
        input: [
          { type: "message", role: "user", content: "A".repeat(80) },
          { type: "message", role: "user", content: "B".repeat(20) },
        ],
      })).rejects.toThrow("different Native source");
      expect(await cache.list("thread-1")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an ineffective checkpoint is not regenerated automatically on the same canonical anchor", async () => {
    const root = scratch();
    try {
      const cache = new FileContextCheckpointCache({ directory: root });
      let producerCalls = 0;
      const planner = createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: cache,
        budgetTokens: 10,
        checkpointProducer(input) {
          producerCalls += 1;
          return {
            nativeTaskId: input.nativeTaskId,
            sourceRevisionId: input.sourceRevisionId,
            content: "S".repeat(80),
          };
        },
      });
      const request = {
        input: [
          { type: "message", role: "user", content: "A".repeat(80) },
          { type: "message", role: "user", content: "B".repeat(20) },
        ],
      };
      await expect(planner(registered(), request)).rejects.toThrow("requires a checkpoint");
      expect(producerCalls).toBe(1);
      expect(await cache.list("thread-1")).toHaveLength(1);

      await expect(planner(registered(), request)).rejects.toThrow("requires a checkpoint");
      expect(producerCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a checkpoint from a superseded canonical branch is ignored rather than promoted to authority", async () => {
    const root = scratch();
    try {
      const oldRequest = {
        input: [
          { type: "message", role: "user", content: "Old direction" },
          { type: "message", role: "assistant", content: "Old work" },
        ],
      };
      const oldProjection = projectNativeRequestContext("thread-1", oldRequest);
      const oldHead = oldProjection.revisions.at(-1)!.revision;
      const cache = new FileContextCheckpointCache({ directory: root });
      await cache.put({
        nativeTaskId: "thread-1",
        revisionId: oldHead.id,
        content: "stale branch checkpoint",
        estimatedTokens: 1,
      });

      const changedRequest = {
        input: [
          { type: "message", role: "user", content: "New direction" },
          { type: "message", role: "assistant", content: "New work" },
        ],
      };
      const planned = await createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: cache,
      })(registered(), changedRequest);

      expect(planned.physicalContext.mode).toBe("full");
      expect(JSON.stringify(planned.physicalContext)).not.toContain("stale branch checkpoint");
      expect(JSON.stringify(planned.physicalContext)).toContain("New direction");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
