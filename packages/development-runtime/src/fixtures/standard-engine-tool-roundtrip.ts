import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { encodeNativeResponsesOutcome, nativeResponsesSsePlan } from "@chatgpt-tela/responses";
import type { NativeGatewayOutcome } from "@chatgpt-tela/runtime";

// Public Codex app-server + isolated synthetic Responses provider. No real model or browser.
const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const engine = resolve(option("--engine")!);
const catalogPath = resolve(option("--catalog")!);
const imageEffort = process.argv.includes("--image-effort");
const interrupt = process.argv.includes("--interrupt");
assert(!(imageEffort && interrupt), "run one fixture scenario at a time");
const root = mkdtempSync(join(tmpdir(), "tela-official-tool-roundtrip-"));
const home = join(root, "home"); mkdirSync(home);
const model = chatGptWebModelId(chatGptWebFamilyKey("Official Tool Roundtrip Fixture"));
const original = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Record<string, unknown>[] };
const template = original.models[0]!;
assert(template?.slug, "a public model catalog template is required");
const modelCatalog = join(root, "models.json");
// In original-detail mode the public LocalImage contract preserves these exact PNG bytes.
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const imagePath = join(root, "synthetic.png");
if (imageEffort) writeFileSync(imagePath, imageBytes);
writeFileSync(modelCatalog, JSON.stringify({ models: [{ ...template, slug: model,
  display_name: "Official Tool Roundtrip Fixture", tool_mode: "direct",
  supported_reasoning_levels: [{ effort: "medium", description: "Fixture" },
    { effort: "high", description: "Fixture" }],
  default_reasoning_level: "medium",
}] }));

const callId = "fixture-command-once";
const marker = "TELA_OFFICIAL_TOOL_ROUNDTRIP_OK";
let requestCount = 0, toolResultSeen = 0, finalIssued = 0;
let imageMatched = 0, effortMatched = 0, providerRequestClosed = false;
let markBlocked!: () => void;
const blockedRequest = new Promise<void>(resolve => { markBlocked = resolve; });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as any;
  assert.equal(body.model, model);
  assert.equal(body.stream, true);
  requestCount++;
  if (interrupt) {
    assert.equal(requestCount, 1);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: response.created\ndata: ${JSON.stringify({
          type: "response.created", sequence_number: 0, response: {
            id: "resp_fixture_blocked", object: "response", status: "in_progress", output: [],
            model, usage: null, created_at: 0,
          },
        })}\n\n`));
        request.signal.addEventListener("abort", () => { providerRequestClosed = true; }, { once: true });
        markBlocked();
      },
      cancel() { providerRequestClosed = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  }
  if (imageEffort) {
    assert.equal(body.reasoning?.effort, "high");
    effortMatched++;
    const images = body.input?.flatMap((item: any) => item.type === "message"
      ? (item.content ?? []).filter((content: any) => content.type === "input_image") : []);
    assert.equal(images?.length, 1, "one original local image must reach the provider");
    assert.equal(typeof images[0].image_url, "string");
    assert(images[0].image_url.startsWith("data:image/png;base64,"));
    assert(Buffer.from(images[0].image_url.split(",")[1], "base64").equals(imageBytes),
      "exact original local image bytes must belong to the provider request");
    imageMatched++;
  }
  let outcome: NativeGatewayOutcome;
  if (requestCount === 1) {
    assert(!body.input?.some((item: any) => item.type === "function_call_output"));
    outcome = { type: "tool-call", item: {
      type: "function_call", name: "exec_command", call_id: callId,
      arguments: JSON.stringify({ cmd: `printf ${marker}`, workdir: root, login: false }),
    }, delivery: { capability: "synthetic-provider", callId } };
  } else {
    assert.equal(requestCount, 2, "one model-request tool roundtrip only");
    const result = body.input?.filter((item: any) => item.type === "function_call_output" && item.call_id === callId);
    assert.equal(result?.length, 1, "Native must return one output for the original call ID");
    assert.equal(typeof result[0].output, "string");
    assert(result[0].output.includes(marker), "the actual host command output must reach the next Responses input");
    assert(!body.input.some((item: any) => item.type === "function_call_output" && item.call_id !== callId));
    toolResultSeen++;
    outcome = { type: "final", answer: "Fixture final answer accepted after tool result.",
      delivery: { capability: "synthetic-provider" } };
    finalIssued++;
  }
  const encoded = encodeNativeResponsesOutcome({ outcome, model: body.model });
  const plan = nativeResponsesSsePlan(outcome, encoded);
  assert.equal(encoded.response.usage, null);
  return new Response(plan.frames.join(""), { headers: { "content-type": "text/event-stream" } });
} });

writeFileSync(join(home, "config.toml"), [
  `model = ${JSON.stringify(model)}`, 'model_provider = "fixture"',
  `model_catalog_json = ${JSON.stringify(modelCatalog)}`, 'model_reasoning_effort = "medium"',
  '[model_providers.fixture]', 'name = "OpenAI"', `base_url = "${server.url}v1"`,
  'wire_api = "responses"', 'requires_openai_auth = false',
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
const failWaiters = (error: unknown) => {
  for (const waiter of pending.values()) waiter.reject(error); pending.clear();
  for (const waiter of waiters.splice(0)) waiter.reject(error);
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
const rpc = (method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
  deadline.throwIfAborted(); const id = ++sequence; pending.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});
const notification = (method: string) => new Promise<any>((resolve, reject) => {
  deadline.throwIfAborted(); const index = notes.findIndex(note => note.method === method);
  if (index >= 0) resolve(notes.splice(index, 1)[0]); else waiters.push({ method, resolve, reject });
});
try {
  await rpc("initialize", { clientInfo: { name: "tela-official-tool-fixture", version: "0.0.0" },
    capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const catalog = await rpc("model/list", { includeHidden: true });
  assert(catalog.data.some((item: any) => item.model === model));
  const started = await rpc("thread/start", { model, modelProvider: "fixture", cwd: root,
    approvalPolicy: "never", sandbox: "danger-full-access", historyMode: "paginated",
    ephemeral: false, baseInstructions: "Execute only the supplied synthetic printf tool call." });
  const launched = await rpc("turn/start", { threadId: started.thread.id, model,
    effort: imageEffort ? "high" : "medium",
    input: imageEffort ? [
      { type: "text", text: "Inspect the synthetic local image and run the fixture tool." },
      { type: "localImage", path: imagePath, detail: "original" },
    ] : [{ type: "text", text: interrupt ? "Wait for the fixture response." : "Run the one synthetic tool and return its result." }] });
  if (interrupt) {
    await blockedRequest;
    await rpc("turn/interrupt", { threadId: started.thread.id, turnId: launched.turn.id });
  }
  const completed = await notification("turn/completed");
  assert.equal(completed.params.turn.status, interrupt ? "interrupted" : "completed");
  assert.equal(requestCount, interrupt ? 1 : 2);
  assert.equal(toolResultSeen, interrupt ? 0 : 1);
  assert.equal(finalIssued, interrupt ? 0 : 1);
  if (interrupt) assert(providerRequestClosed, "the blocked provider response must close on interrupt");
  if (imageEffort) { assert.equal(imageMatched, 2); assert.equal(effortMatched, 2); }
  const proof = { engineVersion: execFileSync(engine, ["--version"], { encoding: "utf8" }).trim(),
    publicAppServer: true, syntheticProvider: true, responseUsage: null, requestCount,
    toolCallName: interrupt ? null : "exec_command", toolCallIdMatched: !interrupt,
    hostToolResultSeen: toolResultSeen,
    finalAnswerAccepted: !interrupt, imageOriginalBytesMatched: imageMatched,
    reasoningEffortMatched: effortMatched, interrupted: interrupt, providerRequestClosed,
    browserOrModelCalls: 0, installedOrRestartedServices: false };
  if (option("--output")) writeFileSync(resolve(option("--output")!), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
} finally {
  child.stdin.end(); await child.exited; await reading; await stderr; await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
