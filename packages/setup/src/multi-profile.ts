import { spawn } from "node:child_process";
import {
  AppServerCurrentTurnSource,
  connectCodexAppServerWebSocket,
  type CanonicalCurrentTurnSource,
} from "@chatgpt-tela/codex";

const CONTRACT_VERSION = 1;
const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Multi-Profile contract returned invalid ${field}`);
  }
  const normalized = value.trim();
  if (normalized.length > 1024 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Multi-Profile contract returned invalid ${field}`);
  }
  return normalized;
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Multi-Profile contract returned invalid ${field}`);
  }
  return value;
}

function contractVersion(value: unknown): void {
  if (value !== CONTRACT_VERSION) {
    throw new Error(`unsupported Multi-Profile contract version: ${String(value)}`);
  }
}

function loopbackResponsesBaseUrl(value: URL | string): string {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Multi-Profile Responses route must use loopback http://");
  }
  if (!url.port) throw new Error("Multi-Profile Responses route must include an explicit port");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Multi-Profile Responses route must not contain credentials, query, or fragment");
  }
  url.pathname = "/v1";
  return url.href.replace(/\/$/, "");
}

function loopbackAppServerEndpoint(value: unknown): string {
  const raw = stringField(value, "target session endpoint");
  const url = new URL(raw);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Multi-Profile target session endpoint must use loopback ws://");
  }
  if (!url.port || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("Multi-Profile target session endpoint is not a plain loopback WebSocket endpoint");
  }
  return url.href;
}

function environmentKey(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) {
    throw new Error("Multi-Profile Responses env key must be an uppercase environment variable name");
  }
  return value;
}

function targetId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("Multi-Profile target id is invalid");
  }
  return normalized;
}

function fingerprint(value: unknown): string {
  const normalized = stringField(value, "Responses route fingerprint");
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("Multi-Profile Responses route fingerprint is invalid");
  }
  return normalized;
}

export interface MultiProfileControlResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface MultiProfileControlRunner {
  run(
    command: readonly [string, ...string[]],
    input: {
      readonly arguments: readonly string[];
      readonly environment?: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
    },
  ): Promise<MultiProfileControlResult>;
}

function abortError(): DOMException {
  return new DOMException("Multi-Profile control command aborted", "AbortError");
}

export class NodeMultiProfileControlRunner implements MultiProfileControlRunner {
  async run(
    command: readonly [string, ...string[]],
    input: {
      readonly arguments: readonly string[];
      readonly environment?: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
    },
  ): Promise<MultiProfileControlResult> {
    if (input.signal?.aborted) throw abortError();
    const [program, ...prefix] = command;
    if (!program.trim()) throw new Error("Multi-Profile control command is empty");

    const windowsCommand = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(program);
    const executable = windowsCommand ? (process.env.ComSpec || "cmd.exe") : program;
    const arguments_ = windowsCommand
      ? ["/d", "/s", "/c", program, ...prefix, ...input.arguments]
      : [...prefix, ...input.arguments];
    const environment = {
      ...process.env,
      ...(input.environment ?? {}),
    };

    return new Promise<MultiProfileControlResult>((resolvePromise, rejectPromise) => {
      const child = spawn(executable, arguments_, {
        env: environment,
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
        if (next > MAX_CONTROL_OUTPUT_BYTES) {
          child.kill();
          finish(() => rejectPromise(new Error("Multi-Profile control output exceeded the bounded limit")));
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

export interface MultiProfileTarget {
  readonly id: string;
  readonly displayName: string;
  readonly managed: boolean;
  readonly role: string;
  readonly state: string;
  readonly sessionState: string;
  readonly sharedAppServerSupported: boolean;
  readonly responsesRouteSupported: boolean;
  readonly profileIndex?: number;
}

export interface MultiProfileTargetSession {
  readonly targetId: string;
  readonly state: string;
  readonly endpoint?: string;
  readonly responsesRouteFingerprint?: string;
  readonly desktopProcessId?: number;
}

export interface MultiProfileManagedRuntime {
  readonly target: MultiProfileTarget;
  readonly session: Required<Pick<MultiProfileTargetSession,
    "targetId" | "state" | "endpoint" | "responsesRouteFingerprint">>;
  readonly currentTurnSource: CanonicalCurrentTurnSource;
}

export type MultiProfileRoutedRuntime = MultiProfileManagedRuntime;

function parseJson(stdout: string, command: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(`Multi-Profile ${command} did not return valid JSON`);
  }
  const result = record(value);
  if (!result) throw new Error(`Multi-Profile ${command} returned an invalid JSON object`);
  contractVersion(result.contractVersion);
  return result;
}

function parseTarget(value: unknown): MultiProfileTarget {
  const target = record(value);
  if (!target) throw new Error("Multi-Profile targets contract contains an invalid target");
  const profileIndex = target.profileIndex;
  if (profileIndex !== undefined
    && (!Number.isSafeInteger(profileIndex) || (profileIndex as number) < 2 || (profileIndex as number) > 99)) {
    throw new Error("Multi-Profile targets contract contains an invalid profile index");
  }
  return Object.freeze({
    id: stringField(target.id, "target id"),
    displayName: stringField(target.displayName, "target display name"),
    managed: booleanField(target.managed, "target managed flag"),
    role: stringField(target.role, "target role"),
    state: stringField(target.state, "target state"),
    sessionState: stringField(target.sessionState, "target session state"),
    sharedAppServerSupported: booleanField(target.sharedAppServerSupported, "shared app-server support"),
    responsesRouteSupported: booleanField(target.responsesRouteSupported, "Responses route support"),
    ...(profileIndex !== undefined ? { profileIndex: profileIndex as number } : {}),
  });
}

function parseSession(value: Record<string, unknown>, expectedTargetId: string): MultiProfileTargetSession {
  const returnedTargetId = stringField(value.targetID, "target session target id");
  if (returnedTargetId !== expectedTargetId) {
    throw new Error("Multi-Profile returned a session for a different target");
  }
  const state = stringField(value.state, "target session state");
  const endpoint = value.endpoint === undefined ? undefined : loopbackAppServerEndpoint(value.endpoint);
  const responsesRouteFingerprint = value.responsesRouteFingerprint === undefined
    ? undefined
    : fingerprint(value.responsesRouteFingerprint);
  const desktopProcessID = value.desktopProcessID;
  if (desktopProcessID !== undefined
    && (!Number.isSafeInteger(desktopProcessID) || (desktopProcessID as number) < 1)) {
    throw new Error("Multi-Profile target session desktop process id is invalid");
  }
  return Object.freeze({
    targetId: returnedTargetId,
    state,
    ...(endpoint ? { endpoint } : {}),
    ...(responsesRouteFingerprint ? { responsesRouteFingerprint } : {}),
    ...(desktopProcessID !== undefined ? { desktopProcessId: desktopProcessID as number } : {}),
  });
}

/**
 * Optional consumer of Plura Desktop's public multi-profile control contract.
 *
 * ChatGPT Tela never reconstructs managed CODEX_HOME/user-data paths. Plura Desktop remains lifecycle
 * owner; ChatGPT Tela supplies only a loopback Responses route at launch, consumes the returned
 * public session endpoint, and binds Native authority through Codex app-server's public read API.
 * Development stock canaries do not instantiate this adapter. Product callers may use the same public
 * contract for the canonical `default` target through launchRoutedTarget().
 */
export class MultiProfileControlClient {
  readonly #command: readonly [string, ...string[]];
  readonly #runner: MultiProfileControlRunner;

  constructor(input: {
    readonly command: readonly [string, ...string[]];
    readonly runner?: MultiProfileControlRunner;
  }) {
    if (!input.command[0]?.trim()) throw new Error("Multi-Profile control command is empty");
    this.#command = Object.freeze([...input.command]) as readonly [string, ...string[]];
    this.#runner = input.runner ?? new NodeMultiProfileControlRunner();
  }

  async targets(signal?: AbortSignal): Promise<readonly MultiProfileTarget[]> {
    const result = await this.#run(["targets", "--json"], undefined, signal);
    const contract = parseJson(result.stdout, "targets");
    if (!Array.isArray(contract.targets)) throw new Error("Multi-Profile targets contract is missing targets");
    const targets = contract.targets.map(parseTarget);
    const unique = new Set(targets.map(target => target.id));
    if (unique.size !== targets.length) throw new Error("Multi-Profile targets contract contains duplicate target ids");
    return Object.freeze(targets);
  }

  async targetSession(target: string, signal?: AbortSignal): Promise<MultiProfileTargetSession> {
    const expectedTargetId = targetId(target);
    const result = await this.#run([
      "target-session",
      "--target",
      expectedTargetId,
      "--json",
    ], undefined, signal);
    return parseSession(parseJson(result.stdout, "target-session"), expectedTargetId);
  }

  async launchManagedTarget(input: {
    readonly targetId: string;
    readonly responsesBaseUrl: URL | string;
    readonly responsesEnvKey: string;
    readonly responsesToken: string;
    readonly signal?: AbortSignal;
  }): Promise<MultiProfileManagedRuntime> {
    return this.#launchRoutedTarget(input, true);
  }

  /**
   * Launch one public launcher target with a process-local Responses route.
   *
   * Unlike launchManagedTarget(), this product-control primitive also accepts the launcher's
   * canonical `default` target. The development canary intentionally keeps using the stricter
   * managed-only entrypoint so its stock-mode independence does not change accidentally.
   */
  async launchRoutedTarget(input: {
    readonly targetId: string;
    readonly responsesBaseUrl: URL | string;
    readonly responsesEnvKey: string;
    readonly responsesToken: string;
    readonly signal?: AbortSignal;
  }): Promise<MultiProfileRoutedRuntime> {
    return this.#launchRoutedTarget(input, false);
  }

  async quitTarget(target: string, signal?: AbortSignal): Promise<MultiProfileTargetSession> {
    const expectedTargetId = targetId(target);
    const result = await this.#run([
      "quit-target",
      "--target",
      expectedTargetId,
      "--json",
    ], undefined, signal);
    return parseSession(parseJson(result.stdout, "quit-target"), expectedTargetId);
  }

  async #launchRoutedTarget(input: {
    readonly targetId: string;
    readonly responsesBaseUrl: URL | string;
    readonly responsesEnvKey: string;
    readonly responsesToken: string;
    readonly signal?: AbortSignal;
  }, requireManaged: boolean): Promise<MultiProfileRoutedRuntime> {
    const expectedTargetId = targetId(input.targetId);
    const route = loopbackResponsesBaseUrl(input.responsesBaseUrl);
    const envKey = environmentKey(input.responsesEnvKey);
    if (input.responsesToken.length < 32) {
      throw new Error("Multi-Profile Responses token must contain at least 32 characters");
    }
    const targets = await this.targets(input.signal);
    const matches = targets.filter(target => target.id === expectedTargetId);
    if (matches.length !== 1) throw new Error(`Multi-Profile target is not available: ${expectedTargetId}`);
    const target = matches[0]!;
    if (requireManaged && !target.managed) {
      throw new Error("stock/default ChatGPT must use ChatGPT Tela's native single-profile path");
    }
    if (!target.sharedAppServerSupported || !target.responsesRouteSupported) {
      throw new Error("Multi-Profile target does not support the required app-server/Responses contract");
    }

    const result = await this.#run([
      "launch-target",
      "--target",
      expectedTargetId,
      "--responses-base-url",
      route,
      "--responses-env-key",
      envKey,
      "--json",
    ], { [envKey]: input.responsesToken }, input.signal);
    const session = parseSession(parseJson(result.stdout, "launch-target"), expectedTargetId);
    if (session.state !== "ready" || !session.endpoint || !session.responsesRouteFingerprint) {
      throw new Error("Multi-Profile launch did not return a ready routed target session");
    }

    const readySession = Object.freeze({
      targetId: session.targetId,
      state: session.state,
      endpoint: session.endpoint,
      responsesRouteFingerprint: session.responsesRouteFingerprint,
    });
    return Object.freeze({
      target,
      session: readySession,
      currentTurnSource: new AppServerCurrentTurnSource(
        signal => connectCodexAppServerWebSocket(
          readySession.endpoint,
          signal ? { signal } : {},
        ),
      ),
    });
  }

  async #run(
    arguments_: readonly string[],
    environment: Readonly<Record<string, string>> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<MultiProfileControlResult> {
    const result = await this.#runner.run(this.#command, {
      arguments: arguments_,
      ...(environment ? { environment } : {}),
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0) {
      let detail = result.stderr.trim();
      for (const secret of Object.values(environment ?? {})) {
        if (secret) detail = detail.split(secret).join("[redacted]");
      }
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Multi-Profile control command failed with exit code ${result.exitCode}${suffix}`);
    }
    return result;
  }
}
