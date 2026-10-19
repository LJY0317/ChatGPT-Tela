import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AppServerCurrentTurnSource, bindNativeTurnRequest, decodeTelaCompactionSummary, NativeHistoryBootstrapRequired } from "@chatgpt-tela/codex";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { ActiveTurnRegistry } from "@chatgpt-tela/runtime";
import { nativeCompactionSummaryResponse } from "@chatgpt-tela/responses";
import { createNativeLocalCompactionRouter } from "../native-local-compaction";
import { createNativeRequestDevelopmentWebTurnPlanner } from "../native-request-planner";
import { scrubTelaResponsesArtifacts } from "../native-passthrough";

// Standalone: real supplied Codex executable and public RPC, synthetic model/summary responses.
// Isolated CODEX_HOME; no credentials, browser, user conversation, installation or model calls.
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const engine = resolve(option("--engine")!);
const catalogPath = resolve(option("--catalog")!);
const rejectCompaction = option("--reject-compaction");
const autoLimit = option("--auto-limit") ? Number(option("--auto-limit")) : undefined;
const root = mkdtempSync(join(option("--scratch-root") ?? tmpdir(), "tela-standard-engine-"));
const home = join(root, "home"); mkdirSync(home);
const model = chatGptWebModelId(chatGptWebFamilyKey("Standard Engine Fixture"));
const original = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Record<string, unknown>[] };
const template = original.models[0]!;
const modelCatalog = join(root, "models.json");
writeFileSync(modelCatalog, JSON.stringify({ models: [{ ...template, slug: model,
  display_name: "Standard Engine Fixture", tool_mode: null,
  context_window: 100_000, max_context_window: 100_000,
  auto_compact_token_limit: autoLimit ?? 90_000,
  supported_reasoning_levels: [{ effort: "medium", description: "Fixture" }], default_reasoning_level: "medium",
}] }));
let rpcRequest!: (method: string, params?: unknown) => Promise<any>;
const current = new AppServerCurrentTurnSource(async () => ({ request: rpcRequest, async close() {} }));
let summaries = 0, remoteRequests = 0, plannedReplays = 0, nativeSwitches = 0, automatic = 0, continuedAfterRejection = 0;
const router = createNativeLocalCompactionRouter({
  source: { currentTurn: id => current.currentTurn(id) },
  summarize: async () => { summaries++;
    if (rejectCompaction === "source-budget") throw new NativeHistoryBootstrapRequired("source_budget");
    if (rejectCompaction) throw new Error("Synthetic terminal summary failure");
    return "Fixture checkpoint: preserve pending task and read original evidence when needed."; },
});
let phase: "seed" | "followup" | "native" = "seed";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.clone().json() as any;
  if (body.input?.at(-1)?.type === "compaction_trigger") {
    remoteRequests++;
    return await router(request) ?? new Response("Unexpected compaction route", { status: 500 });
  }
  if (rejectCompaction && phase === "followup") {
    assert(!body.input?.some((item: any) => item.type === "compaction"));
    assert(JSON.stringify(body.input).includes("Fixture final answer."));
    continuedAfterRejection++;
  }
  if (phase === "followup" && body.input?.some((item: any) =>
    item.type === "compaction" && decodeTelaCompactionSummary(item.encrypted_content) !== undefined)) {
    const binding = await bindNativeTurnRequest(body, current);
    const plan = await createNativeRequestDevelopmentWebTurnPlanner()(
      new ActiveTurnRegistry().register(binding), body);
    assert(plan.physicalContext.segments.some(segment => segment.content.includes("Fixture checkpoint:")));
    plan.settle?.({ status: "failed" });
    plannedReplays++;
  }
  if (phase === "native") {
    const scrubbed = scrubTelaResponsesArtifacts(body);
    assert(scrubbed.changed);
    const input = (scrubbed.value as any).input;
    assert(!input.some((item: any) => typeof item.encrypted_content === "string"
      && item.encrypted_content.startsWith("tela:summary:v1:")));
    assert(JSON.stringify(input).includes("Fixture checkpoint:"));
    nativeSwitches++;
  }
  return nativeCompactionSummaryResponse({ summary: phase === "seed" && autoLimit
    ? "Fixture seed. " + "state ".repeat(10_000) : "Fixture final answer.",
    operationId: crypto.randomUUID(), model: body.model, stream: true });
} });
writeFileSync(join(home, "config.toml"), [
  `model = ${JSON.stringify(model)}`, 'model_provider = "fixture"',
  `model_catalog_json = ${JSON.stringify(modelCatalog)}`, 'model_reasoning_effort = "medium"',
  "[model_providers.fixture]", 'name = "OpenAI"', `base_url = "${server.url}v1"`,
  'wire_api = "responses"', "requires_openai_auth = false",
].join("\n"));
const child = Bun.spawn([engine, "app-server", "--stdio"], {
  cwd: root, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, CODEX_HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir() }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
let sequence = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void }>();
const notes: any[] = [];
const waiters: { method: string; resolve(value: any): void; reject(error: unknown): void }[] = [];
const deadline = AbortSignal.timeout(30_000);
const failWaiters = (reason: unknown) => {
  for (const waiter of pending.values()) waiter.reject(reason); pending.clear();
  for (const waiter of waiters.splice(0)) waiter.reject(reason);
};
deadline.addEventListener("abort", () => failWaiters(deadline.reason), { once: true });
const reading = (async () => {
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = "";
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    buffer += decoder.decode(part.value, { stream: true });
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        const waiter = pending.get(message.id); pending.delete(message.id);
        if (waiter) message.error ? waiter.reject(message.error) : waiter.resolve(message.result);
      } else {
        const index = waiters.findIndex(waiter => waiter.method === message.method);
        if (index >= 0) waiters.splice(index, 1)[0]!.resolve(message); else notes.push(message);
      }
    }
  }
  failWaiters(new Error("Owned fixture engine closed"));
})();
const stderr = new Response(child.stderr).text();
rpcRequest = (method, params) => new Promise((resolve, reject) => {
  deadline.throwIfAborted(); const id = ++sequence; pending.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});
const notification = (method: string) => new Promise<any>((resolve, reject) => {
  deadline.throwIfAborted(); const index = notes.findIndex(note => note.method === method);
  if (index >= 0) resolve(notes.splice(index, 1)[0]); else waiters.push({ method, resolve, reject });
});
try {
  await rpcRequest("initialize", { clientInfo: { name: "tela-standard-fixture", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const catalog = await rpcRequest("model/list", { includeHidden: true });
  assert(catalog.data.some((item: any) => item.model === model), "Standard model_catalog_json must expose the Web row");
  const started = await rpcRequest("thread/start", { model, modelProvider: "fixture", cwd: root,
    approvalPolicy: "never", sandbox: "danger-full-access", historyMode: "paginated", ephemeral: false,
    baseInstructions: "Isolated synthetic fixture; use only the supplied task." });
  const threadId = started.thread.id;
  const turn = async (text: string, selectedModel = model) => {
    await rpcRequest("turn/start", { threadId, model: selectedModel, effort: "medium", input: [{ type: "text", text }] });
    const completed = await notification("turn/completed"); assert.equal(completed.params.turn.status, "completed");
  };
  await turn("Produce a synthetic seed.");
  phase = "followup";
  if (autoLimit) await turn("Continue the synthetic seed.");
  automatic = remoteRequests;
  if (!remoteRequests) {
    await rpcRequest("thread/compact/start", { threadId });
    const completed = await notification("turn/completed");
    assert.equal(completed.params.turn.status, rejectCompaction ? "failed" : "completed");
  }
  await turn("Continue after the checkpoint.");
  if (rejectCompaction) {
    assert.equal(remoteRequests, 1); assert.equal(summaries, 1); assert.equal(continuedAfterRejection, 1);
  } else {
    phase = "native";
    await turn("Continue with the fixture Native route.", String(template.slug));
    assert(plannedReplays > 0); assert.equal(nativeSwitches, 1);
  }
  if (!rejectCompaction) assert.equal(summaries, remoteRequests);
  const proof = { engineVersion: execFileSync(engine, ["--version"], { encoding: "utf8" }).trim(),
    engineSuppliedByCaller: true, standardModelCatalogSeed: true,
    canonicalOwner: "public-paginated-rpc", remoteCompactions: remoteRequests, summaryCalls: summaries,
    automaticCompactionsWithoutUsage: automatic, plannedReplays, nativeSwitches, continuedAfterRejection,
    terminalCompactionRejection: rejectCompaction ?? null,
    browserOrModelCalls: 0, fakeResponses: true, installedOrRestartedServices: false };
  if (option("--output")) writeFileSync(resolve(option("--output")!), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
} finally {
  child.stdin.end(); await child.exited; await reading; await stderr; await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
