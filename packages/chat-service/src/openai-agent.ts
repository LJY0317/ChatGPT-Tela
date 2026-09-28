import type {
  ChatAgentDriver,
  ChatAgentRunCallbacks,
  ChatAgentRunInput,
  ChatAgentRunResult,
} from "./agents";
import type { ChatAgentProvidersConfig } from "./config";
import type { ChatAgentDriverFactory, ChatAgentWorkspaceTools } from "./tools";

const OPENAI_API_BASE = "https://api.openai.com/v1/";
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_ROUNDS = 12;
const MAX_TOOL_OUTPUT_BYTES = 512 * 1024;
const MAX_PROVIDER_SESSION_BYTES = 4 * 1024;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface FunctionCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

interface ParsedResponse {
  readonly text?: string;
  readonly calls: readonly FunctionCall[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\u0000")) {
    throw new Error(`${field} is invalid`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error(`${field} is too large`);
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function relativePath(value: unknown, field: string): string {
  const path = boundedText(value, field, 4 * 1024);
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`${field} must be relative to the authorized workspace`);
  }
  return path;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("OpenAI function call arguments are missing");
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch (error) { throw new Error("OpenAI function call arguments are invalid JSON", { cause: error }); }
  const args = record(parsed);
  if (!args) throw new Error("OpenAI function call arguments must be a JSON object");
  return args;
}

function parseResponse(value: unknown): ParsedResponse {
  const root = record(value);
  if (!root || !Array.isArray(root.output)) throw new Error("OpenAI Responses payload is missing output");
  const calls: FunctionCall[] = [];
  const text: string[] = [];
  for (const entry of root.output) {
    const item = record(entry);
    if (!item) continue;
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !item.call_id
        || typeof item.name !== "string" || !item.name) {
        throw new Error("OpenAI function call payload is incomplete");
      }
      calls.push(Object.freeze({
        callId: item.call_id,
        name: item.name,
        arguments: parseArguments(item.arguments),
      }));
      continue;
    }
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      const part = record(content);
      if (part?.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
        text.push(part.text);
      }
    }
  }
  if (calls.length > 0) return Object.freeze({ calls: Object.freeze(calls) });
  const outputText = typeof root.output_text === "string" && root.output_text.trim()
    ? root.output_text
    : text.join("\n");
  return Object.freeze({
    calls: Object.freeze([]),
    ...(outputText.trim() ? { text: outputText } : {}),
  });
}

function tools(writeMode: ChatAgentRunInput["writeMode"]): readonly Record<string, unknown>[] {
  const definitions: Record<string, unknown>[] = [
    {
      type: "function",
      name: "read",
      description: "Read bounded lines from one relative file inside the authorized workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: ["integer", "null"], minimum: 1 },
          limit: { type: ["integer", "null"], minimum: 1, maximum: 400 },
        },
        required: ["path", "offset", "limit"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "read_many",
      description: "Read bounded lines from multiple relative files inside the authorized workspace.",
      parameters: {
        type: "object",
        properties: {
          reads: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                offset: { type: ["integer", "null"], minimum: 1 },
                limit: { type: ["integer", "null"], minimum: 1, maximum: 400 },
              },
              required: ["path", "offset", "limit"],
              additionalProperties: false,
            },
          },
        },
        required: ["reads"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "show_changes",
      description: "Inspect the current Git-backed changes inside the authorized workspace.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: true,
    },
  ];
  if (writeMode === "workspace_write") {
    definitions.push({
      type: "function",
      name: "apply_patch",
      description: "Apply one transactional patch limited to files inside the authorized workspace.",
      parameters: {
        type: "object",
        properties: { patch: { type: "string" } },
        required: ["patch"],
        additionalProperties: false,
      },
      strict: true,
    });
  }
  return Object.freeze(definitions.map(value => Object.freeze(value)));
}

function toolResult(value: unknown): string {
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch (error) { throw new Error("Tela Chat agent tool result is not serializable", { cause: error }); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    throw new Error("Tela Chat agent tool result exceeded the provider transfer limit");
  }
  return serialized;
}

async function invokeTool(
  tools_: ChatAgentWorkspaceTools,
  input: ChatAgentRunInput,
  call: FunctionCall,
): Promise<unknown> {
  const args = call.arguments;
  switch (call.name) {
    case "read": {
      const offset = integer(args.offset, "read.offset", 1, Number.MAX_SAFE_INTEGER);
      const limit = integer(args.limit, "read.limit", 1, 400);
      return tools_.read({
        workspaceId: input.workspaceId,
        path: relativePath(args.path, "read.path"),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
      });
    }
    case "read_many": {
      if (!Array.isArray(args.reads) || args.reads.length < 1 || args.reads.length > 20) {
        throw new Error("read_many.reads must contain 1 to 20 entries");
      }
      return tools_.readMany({
        workspaceId: input.workspaceId,
        reads: args.reads.map((entry, index) => {
          const item = record(entry);
          if (!item) throw new Error(`read_many.reads[${index}] must be an object`);
          const offset = integer(item.offset, `read_many.reads[${index}].offset`, 1, Number.MAX_SAFE_INTEGER);
          const limit = integer(item.limit, `read_many.reads[${index}].limit`, 1, 400);
          return Object.freeze({
            path: relativePath(item.path, `read_many.reads[${index}].path`),
            ...(offset === undefined ? {} : { offset }),
            ...(limit === undefined ? {} : { limit }),
          });
        }),
      });
    }
    case "show_changes":
      return tools_.showChanges(input.workspaceId);
    case "apply_patch":
      if (input.writeMode !== "workspace_write") throw new Error("apply_patch is unavailable in read-only agent mode");
      return tools_.applyPatch({
        workspaceId: input.workspaceId,
        patch: boundedText(args.patch, "apply_patch.patch", 2 * 1024 * 1024),
      });
    default:
      throw new Error(`OpenAI requested an unavailable Tela Chat agent tool: ${call.name}`);
  }
}

async function jsonResponse(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_HTTP_RESPONSE_BYTES) {
      throw new Error("OpenAI response exceeded the bounded transfer limit");
    }
  }
  if (!response.body) throw new Error("OpenAI agent response body is missing");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_HTTP_RESPONSE_BYTES) {
        await reader.cancel("bounded response limit exceeded").catch(() => {});
        throw new Error("OpenAI response exceeded the bounded transfer limit");
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = Buffer.concat(chunks, total);
  if (!response.ok) throw new Error(`OpenAI agent request failed with HTTP ${response.status}`);
  try { return JSON.parse(buffer.toString("utf8")) as unknown; }
  catch (error) { throw new Error("OpenAI agent response was not valid JSON", { cause: error }); }
}

export interface OpenAiChatAgentDriverOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly workspaceTools: ChatAgentWorkspaceTools;
  readonly fetch?: FetchLike;
}

export class OpenAiChatAgentDriver implements ChatAgentDriver {
  readonly id = "openai-responses";
  readonly description = "OpenAI Responses workspace agent";
  readonly #apiKey: string;
  readonly #model: string;
  readonly #tools: ChatAgentWorkspaceTools;
  readonly #fetch: FetchLike;

  constructor(input: OpenAiChatAgentDriverOptions) {
    if (input.apiKey.length < 20 || /[\u0000\r\n]/.test(input.apiKey)) throw new Error("OpenAI API key is invalid");
    this.#apiKey = input.apiKey;
    this.#model = boundedText(input.model, "OpenAI agent model", 256);
    this.#tools = input.workspaceTools;
    this.#fetch = input.fetch ?? fetch;
  }

  async #post(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await this.#fetch(new URL(path, OPENAI_API_BASE), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    return jsonResponse(response);
  }

  async #conversation(input: ChatAgentRunInput, callbacks: ChatAgentRunCallbacks, signal: AbortSignal): Promise<string> {
    if (input.providerSessionId) {
      return boundedText(input.providerSessionId, "OpenAI conversation id", MAX_PROVIDER_SESSION_BYTES);
    }
    const value = record(await this.#post("conversations", {}, signal));
    const id = boundedText(value?.id, "OpenAI conversation id", MAX_PROVIDER_SESSION_BYTES);
    await callbacks.onSessionId(id);
    return id;
  }

  async run(
    input: ChatAgentRunInput,
    callbacks: ChatAgentRunCallbacks,
    signal: AbortSignal,
  ): Promise<ChatAgentRunResult> {
    if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    const conversation = await this.#conversation(input, callbacks, signal);
    const availableTools = tools(input.writeMode);
    let nextInput: unknown = [{ role: "user", content: input.prompt }];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = parseResponse(await this.#post("responses", {
        model: this.#model,
        conversation,
        instructions: input.writeMode === "workspace_write"
          ? "Work only through the provided Tela workspace tools. Paths are relative to one authorized workspace. You may inspect and patch files, but no shell or arbitrary filesystem access is available."
          : "Work only through the provided read-only Tela workspace tools. Paths are relative to one authorized workspace. Do not request writes or shell execution.",
        input: nextInput,
        tools: availableTools,
        tool_choice: "auto",
      }, signal));
      if (response.calls.length === 0) {
        if (!response.text) throw new Error("OpenAI agent response contained neither tool calls nor final text");
        return Object.freeze({ response: response.text, providerSessionId: conversation });
      }
      const outputs: Array<{ readonly type: "function_call_output"; readonly call_id: string; readonly output: string }> = [];
      for (const call of response.calls) {
        const result = await invokeTool(this.#tools, input, call);
        outputs.push(Object.freeze({
          type: "function_call_output",
          call_id: call.callId,
          output: toolResult(result),
        }));
      }
      nextInput = outputs;
    }
    throw new Error(`OpenAI agent exceeded ${MAX_TOOL_ROUNDS} bounded tool rounds`);
  }
}

export function createOpenAiChatAgentDriverFactory(input: {
  readonly apiKey: string;
  readonly model: string;
  readonly fetch?: FetchLike;
}): (tools: ChatAgentWorkspaceTools) => ChatAgentDriver {
  return workspaceTools => new OpenAiChatAgentDriver({
    apiKey: input.apiKey,
    model: input.model,
    workspaceTools,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
}

export function createConfiguredChatAgentDriverFactories(
  config: ChatAgentProvidersConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly ChatAgentDriverFactory[] {
  return Object.freeze(config.providers.flatMap(provider => {
    if (!provider.enabled) return [];
    const apiKey = provider.apiKeyEnv ? environment[provider.apiKeyEnv]?.trim() : undefined;
    if (!apiKey) return [];
    return [createOpenAiChatAgentDriverFactory({ apiKey, model: provider.model })];
  }));
}

export interface ChatAgentCredentialResolver {
  get(id: string): Promise<string | undefined>;
}

export async function createResolvedChatAgentDriverFactories(
  config: ChatAgentProvidersConfig,
  input: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly credentials?: ChatAgentCredentialResolver;
  } = {},
): Promise<readonly ChatAgentDriverFactory[]> {
  const environment = input.environment ?? process.env;
  const factories: ChatAgentDriverFactory[] = [];
  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    let apiKey = provider.apiKeyEnv ? environment[provider.apiKeyEnv]?.trim() : undefined;
    if (!apiKey && provider.credentialId && input.credentials) {
      try { apiKey = (await input.credentials.get(provider.credentialId))?.trim(); }
      catch { apiKey = undefined; }
    }
    if (!apiKey) continue;
    factories.push(createOpenAiChatAgentDriverFactory({ apiKey, model: provider.model }));
  }
  return Object.freeze(factories);
}
