import { spawn } from "node:child_process";
import { diagnosticFailureFields, diagnosticFingerprint, emitDiagnosticEvent } from "@chatgpt-tela/core";

const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw Error(`Invalid Plura ${field}`);
  return value.trim();
}
function targetId(value: string): string { return stringField(value, "target ID"); }
function parseJson(stdout: string, command: string): Record<string, unknown> {
  const value = record(JSON.parse(stdout));
  if (!value || value.contractVersion !== 2) throw Error(`Plura ${command} requires target contract v2`);
  return value;
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
  readonly backendPolicy: "official-desktop-owned";
  readonly profileIndex?: number;
}
export interface MultiProfileTargetSession {
  readonly targetId: string;
  readonly state: string;
  readonly desktopProcessId?: number;
}
function parseTarget(value: unknown): MultiProfileTarget {
  const target = record(value);
  if (!target || target.backendPolicy !== "official-desktop-owned" || typeof target.managed !== "boolean") throw Error("Invalid Plura Desktop target");
  const profileIndex = target.profileIndex;
  if (profileIndex !== undefined && (!Number.isSafeInteger(profileIndex) || Number(profileIndex) < 2 || Number(profileIndex) > 99)) throw Error("Invalid Plura profile index");
  return Object.freeze({ id: targetId(stringField(target.id, "target ID")), displayName: stringField(target.displayName, "display name"),
    role: stringField(target.role, "role"), managed: target.managed, state: stringField(target.state, "state"),
    backendPolicy: "official-desktop-owned", ...(profileIndex === undefined ? {} : { profileIndex: profileIndex as number }) });
}
function parseSession(value: Record<string, unknown>, expectedTargetId: string): MultiProfileTargetSession {
  if (value.targetID !== expectedTargetId || value.backendPolicy !== "official-desktop-owned") throw Error("Plura returned another target or execution owner");
  const pid = value.desktopProcessID;
  if (pid !== undefined && (!Number.isSafeInteger(pid) || Number(pid) < 1)) throw Error("Invalid Desktop process ID");
  return Object.freeze({ targetId: expectedTargetId, state: stringField(value.state, "state"),
    ...(pid === undefined ? {} : { desktopProcessId: pid as number }) });
}

/** Optional app lifecycle only. Native execution and provider selection belong to Desktop. */
export class MultiProfileControlClient {
  readonly #command: readonly [string, ...string[]];
  readonly #runner: MultiProfileControlRunner;
  constructor(input: { readonly command: readonly [string, ...string[]]; readonly runner?: MultiProfileControlRunner }) {
    if (!input.command[0]?.trim()) throw Error("Plura command is empty");
    this.#command = Object.freeze([...input.command]) as readonly [string, ...string[]];
    this.#runner = input.runner ?? new NodeMultiProfileControlRunner();
  }
  async targets(signal?: AbortSignal): Promise<readonly MultiProfileTarget[]> {
    const contract = parseJson((await this.#run(["targets", "--json"], signal)).stdout, "targets");
    if (!Array.isArray(contract.targets)) throw Error("Plura targets are missing");
    const targets = contract.targets.map(parseTarget);
    if (new Set(targets.map(target => target.id)).size !== targets.length) throw Error("Duplicate Plura targets");
    return Object.freeze(targets);
  }
  async targetSession(target: string, signal?: AbortSignal): Promise<MultiProfileTargetSession> {
    const id = targetId(target);
    return parseSession(parseJson((await this.#run(["target-session", "--target", id, "--json"], signal)).stdout, "target-session"), id);
  }
  async launchTarget(input: { readonly targetId: string; readonly expectedProfileIndex?: number; readonly signal?: AbortSignal }): Promise<MultiProfileTargetSession> {
    const id = targetId(input.targetId);
    if (input.expectedProfileIndex !== undefined) {
      const matches = (await this.targets(input.signal)).filter(target => target.id === id && target.managed && target.profileIndex === input.expectedProfileIndex);
      if (matches.length !== 1) throw Error("Plura target does not own the selected profile");
    }
    return parseSession(parseJson((await this.#run(["launch-target", "--target", id, "--json"], input.signal)).stdout, "launch-target"), id);
  }
  async quitTarget(target: string, signal?: AbortSignal, expectedDesktopProcessId?: number): Promise<MultiProfileTargetSession> {
    const id = targetId(target);
    return parseSession(parseJson((await this.#run(["quit-target", "--target", id,
      ...(expectedDesktopProcessId === undefined ? [] : ["--expected-desktop-pid", String(expectedDesktopProcessId)]), "--json"], signal)).stdout, "quit-target"), id);
  }
  async #run(arguments_: readonly string[], signal?: AbortSignal): Promise<MultiProfileControlResult> {
    const started = performance.now(), action = arguments_[0] ?? "unknown";
    const result = await this.#runner.run(this.#command, { arguments: arguments_, ...(signal ? { signal } : {}) }).catch(error => {
      emitDiagnosticEvent("chatgpt_tela_setup", "profile_control_failed", { action, phase: "execute", ...diagnosticFailureFields(error) }); throw error;
    });
    if (result.exitCode !== 0) {
      emitDiagnosticEvent("chatgpt_tela_setup", "profile_control_failed", { action, phase: "exit", exit_code: result.exitCode,
        duration_ms: Math.round(performance.now() - started), stdout_bytes: Buffer.byteLength(result.stdout),
        stderr_bytes: Buffer.byteLength(result.stderr), stderr_fingerprint: diagnosticFingerprint(result.stderr) });
      throw Error(`Plura ${action} failed with exit code ${result.exitCode}`);
    }
    return result;
  }
}
