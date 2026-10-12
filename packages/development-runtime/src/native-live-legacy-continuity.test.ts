import { expect, test } from "bun:test";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { NativeLiveTurnRegistry } from "@chatgpt-tela/core";
import {
  AppServerCurrentTurnSource, bindNativeTurnRequest,
  NativeHistoryBootstrapRequired, type CodexAppServerRpc,
} from "@chatgpt-tela/codex";
import { ActiveTurnRegistry } from "@chatgpt-tela/runtime";
import { createNativeRequestDevelopmentWebTurnPlanner } from "./native-request-planner";

function nativeRequest(turnId: string, input: unknown[]) {
  return {
    model: chatGptWebModelId(chatGptWebFamilyKey("Observed Fixture")),
    reasoning: { effort: "medium" },
    stream: false,
    client_metadata: {
      "x-codex-turn-metadata": {
        request_kind: "turn", thread_id: "old-legacy-thread", turn_id: turnId,
      },
    },
    input,
    tools: [{
      type: "function", name: "exec_command", description: "fixture tool",
      parameters: { type: "object" },
    }],
  };
}

test("Legacy with a fresh engine ACK continues from complete current Native request without scanning old rollout", async () => {
  const live = new NativeLiveTurnRegistry();
  const owner = {};
  const methods: string[] = [];
  const rpc: CodexAppServerRpc = {
    async request(method, params) {
      methods.push(method);
      if (method !== "thread/read"
        || (params as { includeTurns?: boolean }).includeTurns !== false) {
        throw Error("Private 73 MiB-equivalent Legacy history, model, fork and tools are forbidden");
      }
      return { thread: {
        id: "old-legacy-thread", historyMode: "legacy", source: "cli",
        status: { type: "active", activeFlags: [] },
        cwd: "/synthetic/workspace",
        environments: [{ cwd: "/synthetic/workspace",
          runtimeWorkspaceRoots: ["/synthetic/workspace"] }],
      } };
    },
    async close() {},
  };
  const source = new AppServerCurrentTurnSource(async () => rpc, {
    liveTurnProof: live,
  });
  live.accept("old-legacy-thread", "live-readable", owner);
  const readable = nativeRequest("live-readable", [
    { type: "context_compaction" },
    { type: "message", role: "user",
      content: "Original Native-readable task summary; previously verified steps and pending objective." },
    { type: "message", role: "user", content: "Continue with the next safe step." },
  ]);
  const binding = await bindNativeTurnRequest(readable, source);
  expect(binding.canonicalEvidence.proof).toBe("app-server-acknowledged-live-turn");
  const turns = new ActiveTurnRegistry();
  const registered = turns.register(binding);
  let forbiddenCalls = 0;
  const planner = createNativeRequestDevelopmentWebTurnPlanner({
    compactionHistory: async () => { forbiddenCalls++; throw Error("Legacy history may not be read"); },
    automaticNativeHandoff: async () => {
      forbiddenCalls++; throw Error("Additional Native model may not start");
    },
  });
  const plan = await planner(registered, readable);
  expect(plan.diagnostics?.continuity_source).toBe("current-input");
  expect(JSON.stringify(plan.physicalContext.segments)).toContain("Original Native-readable task summary");
  expect(JSON.stringify(plan.physicalContext.segments)).toContain("Continue with the next safe step.");
  expect(forbiddenCalls).toBe(0);
  expect(methods).toEqual(["thread/read", "thread/read"]);
  plan.settle?.({ status: "failed" });

  // The same live-owner admission does NOT turn opaque previous compaction
  // into readable Web state. It still returns the typed Legacy recovery.
  live.accept("old-legacy-thread", "live-opaque", owner);
  const opaque = nativeRequest("live-opaque", [
    { type: "compaction", encrypted_content: "opaque-original-model-state" },
    { type: "message", role: "user", content: "Continue original opaque history" },
  ]);
  const secondBinding = await bindNativeTurnRequest(opaque, source);
  const opaquePlan = createNativeRequestDevelopmentWebTurnPlanner({
    compactionHistory: async () => {
      forbiddenCalls++;
      throw new NativeHistoryBootstrapRequired("unindexed_history");
    },
  });
  await expect(opaquePlan(new ActiveTurnRegistry().register(secondBinding), opaque))
    .rejects.toMatchObject({
      code: "native_history_bootstrap_required", recoveryReason: "unindexed_history",
    });
  expect(forbiddenCalls).toBe(1);
  expect(methods).toEqual(Array(4).fill("thread/read"));
});
