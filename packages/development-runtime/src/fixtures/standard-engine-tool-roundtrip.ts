import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { prepareLocalChatPlugin } from "../../../../apps/local-mcp/src/plugin-package";
import { encodeNativeResponsesOutcome, nativeResponsesSsePlan } from "@chatgpt-tela/responses";
import { editAppOwnedDesktopProviderConfig } from "@chatgpt-tela/default-desktop-target";
import type { NativeGatewayOutcome } from "@chatgpt-tela/runtime";

// Public Codex app-server + isolated synthetic Responses provider. No real model or browser.
const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const engine = resolve(option("--engine")!);
const catalogPath = resolve(option("--catalog")!);
const configuredHome = option("--configured-home");
const configuredModel = option("--configured-model");
const expectedNativeModel = option("--expected-native-model");
const imageEffort = process.argv.includes("--image-effort");
const interrupt = process.argv.includes("--interrupt");
const inspectTools = process.argv.includes("--inspect-tools");
const defaultToolMode = process.argv.includes("--default-tool-mode");
const mcpEnabled = process.argv.includes("--mcp-enabled");
const mcpDisabled = process.argv.includes("--mcp-disabled");
const pluginEnabled = process.argv.includes("--plugin-enabled");
const pluginDisabled = process.argv.includes("--plugin-disabled");
const firstPartyAuth = process.argv.includes("--first-party-auth");
const builtinProvider = process.argv.includes("--builtin-provider");
const pluginFixture = pluginEnabled || pluginDisabled;
const mcpActive = mcpEnabled || pluginEnabled;
const mcpConfigured = mcpEnabled || mcpDisabled || pluginFixture;
assert(!(imageEffort && interrupt), "run one fixture scenario at a time");
assert(!inspectTools || (!imageEffort && !interrupt), "tool declaration inspection is a separate scenario");
assert(!defaultToolMode || inspectTools, "default tool mode applies to tool inspection only");
assert(!(mcpEnabled && mcpDisabled), "select one MCP enablement control");
assert(!(pluginEnabled && pluginDisabled), "select one plugin MCP enablement control");
assert(!pluginFixture || (!mcpEnabled && !mcpDisabled && inspectTools), "plugin case requires standalone tool inspection");
assert(!(mcpEnabled || mcpDisabled) || inspectTools, "MCP control requires tool inspection");
const root = mkdtempSync(join(tmpdir(), "tela-official-tool-roundtrip-"));
const home = configuredHome ? resolve(configuredHome) : join(root, "home");
if (!configuredHome) mkdirSync(home);
if (firstPartyAuth) writeFileSync(join(home, "auth.json"), JSON.stringify({
  auth_mode: "apikey", OPENAI_API_KEY: "synthetic-fixture-key", tokens: null,
}));
const model = configuredModel ?? (firstPartyAuth ? "gpt-6-sol" : chatGptWebModelId(chatGptWebFamilyKey("Official Tool Roundtrip Fixture")));
const providerId = builtinProvider ? "openai" : firstPartyAuth ? "chatgpt_tela_local" : "fixture";
const original = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Record<string, unknown>[] };
const template = original.models[0]!;
assert(template?.slug, "a public model catalog template is required");
const modelCatalog = join(root, "models.json");
const mcpLog = join(root, "mcp.jsonl");
if (mcpConfigured) writeFileSync(mcpLog, "");
let pluginMarketplace: string | undefined;
if (pluginFixture) {
  const { plugin, marketplace } = prepareLocalChatPlugin(root, process.execPath);
  writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: {
    "tela-local-chat": { type: "stdio", command: process.execPath,
      args: [join(import.meta.dir, "standard-engine-mcp-stub.ts"), mcpLog] },
  } }));
  pluginMarketplace = marketplace;
}
// In original-detail mode the public LocalImage contract preserves these exact PNG bytes.
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const imagePath = join(root, "synthetic.png");
if (imageEffort) writeFileSync(imagePath, imageBytes);
writeFileSync(modelCatalog, JSON.stringify({ models: [{ ...template, slug: model,
  display_name: "Official Tool Roundtrip Fixture", tool_mode: defaultToolMode ? null : "direct",
  supported_reasoning_levels: [{ effort: "medium", description: "Fixture" },
    { effort: "high", description: "Fixture" }],
  default_reasoning_level: "medium",
}] }));

const callId = "fixture-command-once";
const marker = "TELA_OFFICIAL_TOOL_ROUNDTRIP_OK";
let requestCount = 0, toolResultSeen = 0, finalIssued = 0;
let declaration: { location: string; namespace: string | null; parameterType: string;
  commandType: string; commandRequired: boolean } | null = null;
let mcpDeclaredTools: string[] = [];
let mcpDiscovery: { callId: string; names: string[]; status: string;
  schemaType: string | null; deferLoading: boolean | null } | null = null;
let imageMatched = 0, effortMatched = 0, providerRequestClosed = false;
let missingFirstPartyAuth = 0;
let markBlocked!: () => void;
const blockedRequest = new Promise<void>(resolve => { markBlocked = resolve; });
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(option("--provider-port") ?? 0), async fetch(request) {
  if (firstPartyAuth && request.headers.get("authorization") !== "Bearer synthetic-fixture-key") {
    missingFirstPartyAuth++;
    return Response.json({ error: { message: "Fixture requires synthetic first-party authorization" } }, { status: 401 });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const body = await request.json() as any;
  assert.equal(body.model, model);
  assert.equal(body.stream, true);
  requestCount++;
  if (inspectTools) {
    assert(requestCount <= (mcpActive ? 2 : 1), "unexpected extra tool inspection request");
    if (mcpActive && requestCount === 2) {
      // In alpha.6 an ordinary MCP tool is deferred: the engine's own
      // tool_search_output, not the initial additional_tools, reveals its schema.
      const outputs = body.input?.filter((item: any) => item.type === "tool_search_output"
        && item.call_id === "fixture-mcp-discovery") ?? [];
      assert.equal(outputs.length, 1, "official Native engine must return its own discovery output");
      const tools = outputs[0].tools ?? [];
      const definitions = tools.flatMap((item: any) => item.type === "namespace"
        ? item.tools ?? [] : [item]);
      const names = definitions.map((item: any) => item.name);
      const discovered = definitions.find((item: any) => item.name?.includes("fixture_probe"));
      mcpDiscovery = { callId: outputs[0].call_id, names,
        status: outputs[0].status, schemaType: discovered?.parameters?.type ?? null,
        deferLoading: discovered?.defer_loading ?? null };
      assert.equal(mcpDiscovery.status, "completed");
      assert(names.some((name: string) => name?.includes("fixture_probe")),
        "official Native MCP search should resolve the isolated tool");
      assert.equal(mcpDiscovery.schemaType, "object");
      const outcome: NativeGatewayOutcome = { type: "final", answer: "MCP discovery verified.",
        delivery: { capability: "synthetic-provider" } };
      finalIssued++;
      const encoded = encodeNativeResponsesOutcome({ outcome, model: body.model });
      assert.equal(encoded.response.usage, null);
      return new Response(nativeResponsesSsePlan(outcome, encoded).frames.join(""),
        { headers: { "content-type": "text/event-stream" } });
    }
    // Official Responses Lite transmits tool declarations as a durable input item.
    // Other standard Responses providers may use top-level tools instead.
    const additional = body.input?.filter((item: any) => item.type === "additional_tools") ?? [];
    const advertised = additional.flatMap((item: any) => item.tools ?? []);
    const tools = [...(body.tools ?? []), ...advertised];
    const namespace = tools.find((item: any) => item.type === "namespace"
      && item.tools?.some((nested: any) => nested.name === "exec_command"));
    const entry = tools.find((item: any) => item.name === "exec_command")
      ?? namespace?.tools.find((item: any) => item.name === "exec_command");
    assert(entry, `official request lacks exec_command schema (input item types: ${
      [...new Set((body.input ?? []).map((item: any) => item.type))].join(",")})`);
    assert.equal(entry.type, "function");
    assert.equal(entry.parameters?.type, "object");
    assert.equal(entry.parameters?.properties?.cmd?.type, "string");
    assert(entry.parameters?.required?.includes("cmd"));
    declaration = { location: additional.length ? "input.additional_tools" : "tools",
      namespace: namespace?.name ?? null, parameterType: entry.parameters.type,
      commandType: entry.parameters.properties.cmd.type, commandRequired: true };
    const all = (items: any[]): any[] => items.flatMap(item => item.type === "namespace"
      ? all(item.tools ?? []) : [item]);
    mcpDeclaredTools = all(tools).map(item => String(item.name ?? item.type));
    const outcome: NativeGatewayOutcome = mcpActive
      ? { type: "tool-call", item: { type: "tool_search_call",
          call_id: "fixture-mcp-discovery", arguments: { query: "fixture_probe" } },
          delivery: { capability: "synthetic-provider", callId: "fixture-mcp-discovery" } }
      : { type: "final", answer: "Verified official Native tool declaration.",
          delivery: { capability: "synthetic-provider" } };
    if (!mcpActive) finalIssued++;
    const encoded = encodeNativeResponsesOutcome({ outcome, model: body.model });
    assert.equal(encoded.response.usage, null);
    return new Response(nativeResponsesSsePlan(outcome, encoded).frames.join(""),
      { headers: { "content-type": "text/event-stream" } });
  }
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

const providerConfig = [
  `model = ${JSON.stringify(model)}`, `model_provider = "${providerId}"`,
  ...(!firstPartyAuth || builtinProvider ? [`model_catalog_json = ${JSON.stringify(modelCatalog)}`] : []),
  'model_reasoning_effort = "medium"',
  ...(builtinProvider ? [`openai_base_url = "${server.url}v1"`] : !firstPartyAuth ? [
    `[model_providers.${providerId}]`, 'name = "OpenAI"', `base_url = "${server.url}v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false',
  ] : []),
  ...(mcpEnabled || mcpDisabled ? [
    // Official mcp_servers configuration, never an installed app/plugin toggle.
    '[mcp_servers.fixture_isolation]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify([join(import.meta.dir, "standard-engine-mcp-stub.ts"), mcpLog])}`,
    `enabled = ${mcpEnabled}`,
    'startup_timeout_sec = 10',
  ] : []),
  ...(pluginFixture ? [
    '[features]', 'plugins = true',
    '[plugins."tela-local-chat@tela-local-development".mcp_servers."tela-local-chat"]',
    `enabled = ${pluginEnabled}`,
  ] : []),
].join("\n");
if (!configuredHome) writeFileSync(join(home, "config.toml"), firstPartyAuth && !builtinProvider
  ? editAppOwnedDesktopProviderConfig(providerConfig, "register", {
    installId: "a7f1e18d-6020-4f0c-9684-c4370a8dd58f",
    baseUrl: `${server.url}${"a".repeat(48)}/v1`,
  }).content
  : providerConfig);
const child = Bun.spawn([engine, "app-server", "--stdio"], {
  cwd: root, env: { PATH: process.env.PATH!, HOME: root, CODEX_HOME: home,
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
  if (pluginMarketplace) {
    await rpc("plugin/install", { marketplacePath: pluginMarketplace, pluginName: "tela-local-chat" });
  }
  const catalog = await rpc("model/list", { includeHidden: true });
  assert(catalog.data.some((item: any) => item.model === model),
    `synthetic model not listed (available=${catalog.data.map((item: any) => item.model).join(",")})`);
  if (expectedNativeModel) assert(catalog.data.some((item: any) => item.model === expectedNativeModel),
    "the original Native model must coexist with the configured Web family");
  const started = await rpc("thread/start", { model, modelProvider: providerId, cwd: root,
    approvalPolicy: "never", sandbox: "danger-full-access", historyMode: "paginated",
    ephemeral: false, baseInstructions: "Execute only the supplied synthetic printf tool call." });
  assert.equal(started.thread.modelProvider, providerId);
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
  if (firstPartyAuth) assert.equal(missingFirstPartyAuth, 0, "official provider did not forward first-party authorization");
  assert.equal(requestCount, interrupt || inspectTools && !mcpActive ? 1 : 2);
  assert.equal(toolResultSeen, interrupt || inspectTools ? 0 : 1);
  assert.equal(finalIssued, interrupt ? 0 : 1);
  if (inspectTools) {
    assert(declaration, "official Native tool declaration must be provider-visible");
    assert.equal(toolResultSeen, 0, "inspection must not execute synthetic tools");
  }
  const mcpMethods = mcpConfigured
    ? readFileSync(mcpLog, "utf8").trim().split("\n").filter(Boolean)
      .map(line => (JSON.parse(line) as { method: string }).method)
    : [];
  if (mcpConfigured) console.log(JSON.stringify({ diagnostic: "mcp_tool_probe",
    enabled: mcpActive, pluginFixture, mcpMethods, mcpDeclaredTools }));
  if (mcpActive) {
    assert(mcpMethods.includes("initialize"), "enabled MCP stub must initialize");
    assert(mcpMethods.includes("tools/list"), "enabled MCP stub must publish its tool list");
    assert(mcpDeclaredTools.includes("tool_search"), "deferred MCP tools require official search");
    assert(mcpDiscovery, "official Native search result is required");
  }
  if (mcpDisabled || pluginDisabled) {
    assert.equal(mcpMethods.length, 0, "disabled MCP stub must never start");
    assert.equal(mcpDeclaredTools.filter(name => name.includes("fixture_probe")).length, 0);
  }
  if (interrupt) assert(providerRequestClosed, "the blocked provider response must close on interrupt");
  if (imageEffort) { assert.equal(imageMatched, 2); assert.equal(effortMatched, 2); }
  const proof = { engineVersion: execFileSync(engine, ["--version"], { encoding: "utf8" }).trim(),
    publicAppServer: true, syntheticProvider: true, firstPartyAuth, providerId,
    threadProvider: started.thread.modelProvider, builtinProvider, responseUsage: null, requestCount,
    productionConfigConsumed: Boolean(configuredHome), nativeModelVisible: Boolean(expectedNativeModel),
    toolInspection: inspectTools, modelToolMode: defaultToolMode ? null : "direct",
    declaration,
    ...(inspectTools ? { modelVisibleToolNames: mcpDeclaredTools } : {}),
    ...(mcpConfigured ? { mcpEnabled: mcpActive, pluginFixture, mcpDeclaredTools, mcpMethods, mcpDiscovery } : {}),
    toolCallName: inspectTools ? mcpActive ? "tool_search" : null
      : interrupt ? null : "exec_command", toolCallIdMatched: !interrupt && !inspectTools,
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
