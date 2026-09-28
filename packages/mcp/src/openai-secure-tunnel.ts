import { spawn } from "node:child_process";
import type {
  McpEndpoint,
  McpExposureHealth,
  McpExposureProvider,
  OpenAiSecureTunnelEndpoint,
} from "./exposure";
import type { DevelopmentMcpHttpServer } from "./http-server";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const RUNTIME_KEY_ENV = "CHATGPT_TELA_OPENAI_TUNNEL_RUNTIME_API_KEY";
const TUNNEL_ID = /^tunnel_[a-f0-9]{32}$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJson(stdout: string, operation: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(`tunnel-client ${operation} did not return valid JSON`);
  }
  const result = record(value);
  if (!result) throw new Error(`tunnel-client ${operation} returned an invalid JSON object`);
  return result;
}

function statusBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`tunnel-client status is missing boolean ${field}`);
  }
  return value;
}

function statusString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`tunnel-client status is missing ${field}`);
  }
  return value.trim();
}

function assertLocalMcp(server: DevelopmentMcpHttpServer): void {
  const url = server.endpointUrl;
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Secure MCP Tunnel requires a loopback HTTP MCP server");
  }
  if (server.authentication !== "none") {
    throw new Error("Secure MCP Tunnel local MCP server must delegate ingress authentication to the tunnel");
  }
}

function tunnelId(value: string): string {
  const normalized = value.trim();
  if (!TUNNEL_ID.test(normalized)) throw new Error("OpenAI tunnel id is invalid");
  return normalized;
}

function alias(value: string): string {
  const normalized = value.trim();
  if (!ALIAS.test(normalized)) throw new Error("OpenAI tunnel runtime alias is invalid");
  if (!normalized.startsWith("chatgpt-tela-")) {
    throw new Error("OpenAI tunnel runtime alias must be namespaced to chatgpt-tela-");
  }
  return normalized;
}

function runtimeApiKey(value: string): string {
  if (value.length < 20 || /[\u0000\r\n]/.test(value)) {
    throw new Error("OpenAI tunnel runtime API key is invalid");
  }
  return value;
}

function commandPath(value: string): string {
  const normalized = value.trim();
  if (!normalized || /[\u0000\r\n]/.test(normalized)) {
    throw new Error("tunnel-client executable path is invalid");
  }
  return normalized;
}

export interface TunnelClientCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface TunnelClientCommandRunner {
  run(input: {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<TunnelClientCommandResult>;
}

function abortError(): DOMException {
  return new DOMException("tunnel-client command aborted", "AbortError");
}

/** Node process runner used only for the official tunnel-client control CLI. */
export class NodeTunnelClientCommandRunner implements TunnelClientCommandRunner {
  async run(input: {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<TunnelClientCommandResult> {
    if (input.signal?.aborted) throw abortError();
    return new Promise<TunnelClientCommandResult>((resolvePromise, rejectPromise) => {
      const child = spawn(input.executable, input.arguments, {
        env: { ...process.env, ...input.environment },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener("abort", abort);
        complete();
      };
      const abort = () => {
        child.kill();
        finish(() => rejectPromise(abortError()));
      };
      const collect = (target: Buffer[], chunk: Buffer, current: number): number => {
        const next = current + chunk.byteLength;
        if (next > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill();
          finish(() => rejectPromise(new Error("tunnel-client output exceeded the bounded limit")));
          return next;
        }
        target.push(chunk);
        return next;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes = collect(stdout, chunk, stdoutBytes);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes = collect(stderr, chunk, stderrBytes);
      });
      child.once("error", error => finish(() => rejectPromise(error)));
      child.once("close", code => finish(() => resolvePromise(Object.freeze({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? -1,
      }))));
      input.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export interface OpenAiSecureMcpTunnelStatus {
  readonly alias: string;
  readonly tunnelId: string;
  readonly processRunning: boolean;
  readonly healthy: boolean;
  readonly ready: boolean;
  readonly uiUrl?: URL;
  readonly controlPlanePollHealthy?: boolean;
}

function parseStatus(value: Record<string, unknown>): OpenAiSecureMcpTunnelStatus {
  const aliasValue = statusString(value.alias, "alias");
  const tunnelIdValue = statusString(value.tunnel_id, "tunnel_id");
  const uiRaw = value.ui_url;
  const poll = record(value.control_plane_poll_health);
  let controlPlanePollHealthy: boolean | undefined;
  if (poll && typeof poll.ok === "boolean") controlPlanePollHealthy = poll.ok;
  else if (typeof value.control_plane_poll_healthy === "boolean") {
    controlPlanePollHealthy = value.control_plane_poll_healthy;
  }
  return Object.freeze({
    alias: aliasValue,
    tunnelId: tunnelIdValue,
    processRunning: statusBoolean(value.process_running, "process_running"),
    healthy: statusBoolean(value.healthy, "healthy"),
    ready: statusBoolean(value.ready, "ready"),
    ...(typeof uiRaw === "string" && uiRaw.trim() ? { uiUrl: new URL(uiRaw) } : {}),
    ...(controlPlanePollHealthy !== undefined ? { controlPlanePollHealthy } : {}),
  });
}

/**
 * Managed OpenAI Secure MCP Tunnel exposure using tunnel-client's native runtime lifecycle.
 *
 * The remote tunnel object is not created/deleted here. ChatGPT Tela attaches one namespaced local
 * runtime alias to an existing tunnel id, verifies official structured runtime status, and stops only
 * that local managed runtime. The runtime API key stays in the child environment and is referenced on
 * argv only as `env:CHATGPT_TELA_OPENAI_TUNNEL_RUNTIME_API_KEY`.
 */
export class OpenAiSecureMcpTunnelExposure implements McpExposureProvider {
  readonly kind = "openai-secure-mcp-tunnel";
  readonly #tunnelClient: string;
  readonly #alias: string;
  readonly #tunnelId: string;
  readonly #runtimeApiKey: string;
  readonly #local: DevelopmentMcpHttpServer;
  readonly #runner: TunnelClientCommandRunner;
  readonly #endpoint: OpenAiSecureTunnelEndpoint;
  #connected = false;
  #stopped = false;
  #stopping: Promise<void> | undefined;

  constructor(input: {
    readonly tunnelClient: string;
    readonly alias: string;
    readonly tunnelId: string;
    readonly runtimeApiKey: string;
    readonly local: DevelopmentMcpHttpServer;
    readonly runner?: TunnelClientCommandRunner;
  }) {
    assertLocalMcp(input.local);
    this.#tunnelClient = commandPath(input.tunnelClient);
    this.#alias = alias(input.alias);
    this.#tunnelId = tunnelId(input.tunnelId);
    this.#runtimeApiKey = runtimeApiKey(input.runtimeApiKey);
    this.#local = input.local;
    this.#runner = input.runner ?? new NodeTunnelClientCommandRunner();
    this.#endpoint = Object.freeze({
      kind: "openai-secure-tunnel" as const,
      tunnelId: this.#tunnelId,
      authentication: Object.freeze({ kind: "openai-tunnel" as const }),
    });
  }

  async prepare(signal?: AbortSignal): Promise<OpenAiSecureTunnelEndpoint> {
    if (this.#stopped) throw new Error("OpenAI Secure MCP Tunnel exposure is already stopped");
    if (this.#connected) return this.#endpoint;
    const result = await this.#run([
      "runtimes",
      "connect",
      "--alias",
      this.#alias,
      "--tunnel-id",
      this.#tunnelId,
      "--runtime-api-key",
      `env:${RUNTIME_KEY_ENV}`,
      "--mcp-server-url",
      this.#local.endpointUrl.href,
      "--json",
    ], signal);
    if (result.exitCode !== 0) throw this.#commandFailure("connect", result);
    this.#connected = true;
    return this.#endpoint;
  }

  async verify(endpoint: McpEndpoint, signal?: AbortSignal): Promise<McpExposureHealth> {
    if (endpoint.kind !== "openai-secure-tunnel" || endpoint.tunnelId !== this.#tunnelId) {
      throw new Error("cannot verify a Secure MCP Tunnel endpoint not owned by this provider");
    }
    if (!this.#connected) throw new Error("OpenAI Secure MCP Tunnel runtime is not connected");
    const status = await this.status(signal);
    if (status.alias !== this.#alias || status.tunnelId !== this.#tunnelId) {
      throw new Error("tunnel-client status does not belong to the owned alias/tunnel");
    }
    const ready = status.processRunning
      && status.healthy
      && status.ready
      && status.controlPlanePollHealthy !== false;
    return Object.freeze({
      ready,
      ...(!ready ? {
        detail: `process_running=${status.processRunning} healthy=${status.healthy} ready=${status.ready}`
          + (status.controlPlanePollHealthy === false ? " control_plane_poll_healthy=false" : ""),
      } : {}),
    });
  }

  async status(signal?: AbortSignal): Promise<OpenAiSecureMcpTunnelStatus> {
    const result = await this.#run([
      "runtimes",
      "status",
      this.#alias,
      "--json",
    ], signal);
    if (result.exitCode !== 0) throw this.#commandFailure("status", result);
    return parseStatus(parseJson(result.stdout, "status"));
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    if (this.#stopping) return this.#stopping;
    this.#stopping = (async () => {
      if (!this.#connected) {
        this.#stopped = true;
        return;
      }
      const result = await this.#run([
        "runtimes",
        "stop",
        this.#alias,
        "--json",
      ]);
      if (result.exitCode !== 0) throw this.#commandFailure("stop", result);
      this.#connected = false;
      this.#stopped = true;
    })().finally(() => {
      this.#stopping = undefined;
    });
    return this.#stopping;
  }

  async #run(arguments_: readonly string[], signal?: AbortSignal): Promise<TunnelClientCommandResult> {
    return this.#runner.run({
      executable: this.#tunnelClient,
      arguments: arguments_,
      environment: { [RUNTIME_KEY_ENV]: this.#runtimeApiKey },
      ...(signal ? { signal } : {}),
    });
  }

  #commandFailure(operation: string, result: TunnelClientCommandResult): Error {
    const redacted = result.stderr.split(this.#runtimeApiKey).join("[redacted]").trim();
    return new Error(
      `tunnel-client ${operation} failed with exit code ${result.exitCode}`
      + (redacted ? `: ${redacted}` : ""),
    );
  }
}
