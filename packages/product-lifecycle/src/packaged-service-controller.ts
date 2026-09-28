import type { PackagedInstallBlueprint } from "./packaged-install";
import {
  applyPackagedRepairFromPayload,
  type PackagedRepairPlan,
  type PackagedRepairServiceController,
} from "./packaged-repair";
import {
  applyPackagedUpgradeFromPayload,
  type PackagedUpgradePlan,
  type PackagedUpgradeServiceController,
} from "./packaged-upgrade";
import {
  SystemServiceRegistrationCommandRunner,
  type ServiceRegistrationCommandResult,
  type ServiceRegistrationCommandRunner,
} from "./service-registration";
import type { TelaServiceId } from "./layout";

const DEFAULT_TRANSITION_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function commandFailure(action: string, result: ServiceRegistrationCommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(`${action} failed${detail ? `: ${detail.slice(0, 240)}` : ""}`);
}

function exactRegistrationId(blueprint: PackagedInstallBlueprint, service: TelaServiceId): string {
  const entry = blueprint.services.find(candidate => candidate.service === service);
  if (!entry) throw new Error(`packaged service blueprint is missing ${service}`);
  if (!entry.resource.identity || entry.resource.identity.platform !== blueprint.platform) {
    throw new Error(`packaged ${service} service identity does not match blueprint platform`);
  }
  return entry.resource.registrationId;
}

function parseLaunchdState(stdout: string): "running" | "stopped" {
  const states = stdout.split(/\r?\n/)
    .map(line => /^\s*state\s*=\s*(.+?)\s*$/.exec(line)?.[1]?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  if (states.length !== 1) throw new Error("launchd service state is ambiguous");
  if (states[0] === "running") return "running";
  if (states[0] === "not running" || states[0] === "exited") return "stopped";
  throw new Error(`launchd service state is unsupported: ${states[0]}`);
}

function parseSystemdState(result: ServiceRegistrationCommandResult): "running" | "stopped" {
  const state = result.stdout.trim();
  if (result.exitCode === 0 && state === "active") return "running";
  if ((result.exitCode === 3 || result.exitCode === 0) && (state === "inactive" || state === "failed")) return "stopped";
  throw commandFailure("systemd service status", result);
}

function parseWindowsState(result: ServiceRegistrationCommandResult): "running" | "stopped" {
  if (result.exitCode !== 0) throw commandFailure("Windows scheduled-task status", result);
  const state = result.stdout.trim().toLowerCase();
  if (state === "running") return "running";
  if (state === "ready") return "stopped";
  throw new Error(`Windows scheduled-task state is transitional or unsupported: ${state || "empty"}`);
}

export class PackagedPlatformServiceController implements PackagedUpgradeServiceController, PackagedRepairServiceController {
  readonly #blueprint: PackagedInstallBlueprint;
  readonly #runner: ServiceRegistrationCommandRunner;
  readonly #transitionTimeoutMs: number;
  readonly #userId: number | undefined;

  constructor(input: {
    readonly blueprint: PackagedInstallBlueprint;
    readonly runner?: ServiceRegistrationCommandRunner;
    readonly transitionTimeoutMs?: number;
    readonly userId?: number;
  }) {
    this.#blueprint = input.blueprint;
    this.#runner = input.runner ?? new SystemServiceRegistrationCommandRunner();
    this.#transitionTimeoutMs = input.transitionTimeoutMs ?? DEFAULT_TRANSITION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#transitionTimeoutMs) || this.#transitionTimeoutMs < 100 || this.#transitionTimeoutMs > 60_000) {
      throw new Error("packaged service transition timeout is invalid");
    }
    this.#userId = input.userId ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  }

  async inspect(service: TelaServiceId): Promise<"running" | "stopped"> {
    const registrationId = exactRegistrationId(this.#blueprint, service);
    if (this.#blueprint.platform === "linux") {
      return parseSystemdState(await this.#runner.run("systemctl", ["--user", "is-active", registrationId]));
    }
    if (this.#blueprint.platform === "win32") {
      const script = "$t=Get-ScheduledTask -TaskName $args[0] -TaskPath '\\' -ErrorAction Stop; $t.State.ToString()";
      return parseWindowsState(await this.#runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, registrationId]));
    }
    if (this.#userId === undefined) throw new Error("macOS packaged service control requires a user id");
    const target = `gui/${this.#userId}/${registrationId}`;
    const result = await this.#runner.run("/bin/launchctl", ["print", target]);
    if (result.exitCode !== 0) throw commandFailure("launchd service status", result);
    return parseLaunchdState(result.stdout);
  }

  async #waitFor(service: TelaServiceId, expected: "running" | "stopped"): Promise<void> {
    const deadline = Date.now() + this.#transitionTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        if (await this.inspect(service) === expected) return;
      } catch (error) {
        lastError = error;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`packaged ${service} service did not become ${expected}`, lastError ? { cause: lastError } : undefined);
  }

  async quiesce(service: TelaServiceId): Promise<void> {
    if (await this.inspect(service) === "stopped") return;
    const registrationId = exactRegistrationId(this.#blueprint, service);
    let result: ServiceRegistrationCommandResult;
    if (this.#blueprint.platform === "linux") {
      result = await this.#runner.run("systemctl", ["--user", "stop", registrationId]);
    } else if (this.#blueprint.platform === "win32") {
      const script = "$t=Get-ScheduledTask -TaskName $args[0] -TaskPath '\\' -ErrorAction Stop; if($t.State.ToString() -eq 'Running'){Stop-ScheduledTask -InputObject $t -ErrorAction Stop}";
      result = await this.#runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, registrationId]);
    } else {
      if (this.#userId === undefined) throw new Error("macOS packaged service control requires a user id");
      result = await this.#runner.run("/bin/launchctl", ["kill", "SIGTERM", `gui/${this.#userId}/${registrationId}`]);
    }
    if (result.exitCode !== 0) throw commandFailure(`normal stop for ${service}`, result);
    await this.#waitFor(service, "stopped");
  }

  async resume(service: TelaServiceId): Promise<void> {
    if (await this.inspect(service) === "running") return;
    const registrationId = exactRegistrationId(this.#blueprint, service);
    let result: ServiceRegistrationCommandResult;
    if (this.#blueprint.platform === "linux") {
      result = await this.#runner.run("systemctl", ["--user", "start", registrationId]);
    } else if (this.#blueprint.platform === "win32") {
      const script = "$t=Get-ScheduledTask -TaskName $args[0] -TaskPath '\\' -ErrorAction Stop; if($t.State.ToString() -ne 'Running'){Start-ScheduledTask -InputObject $t -ErrorAction Stop}";
      result = await this.#runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, registrationId]);
    } else {
      if (this.#userId === undefined) throw new Error("macOS packaged service control requires a user id");
      result = await this.#runner.run("/bin/launchctl", ["kickstart", `gui/${this.#userId}/${registrationId}`]);
    }
    if (result.exitCode !== 0) throw commandFailure(`normal start for ${service}`, result);
    await this.#waitFor(service, "running");
  }
}

export async function applyPackagedUpgradeWithPlatformServices(input: {
  readonly plan: PackagedUpgradePlan;
  readonly payloadSourcePath: string;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
  readonly userId?: number;
}): ReturnType<typeof applyPackagedUpgradeFromPayload> {
  const controller = new PackagedPlatformServiceController({
    blueprint: input.plan.targetBlueprint,
    ...(input.runner ? { runner: input.runner } : {}),
    ...(input.userId === undefined ? {} : { userId: input.userId }),
  });
  return applyPackagedUpgradeFromPayload({
    plan: input.plan,
    payloadSourcePath: input.payloadSourcePath,
    services: controller,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.home ? { home: input.home } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
  });
}

export async function applyPackagedRepairWithPlatformServices(input: {
  readonly plan: PackagedRepairPlan;
  readonly payloadSourcePath: string;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: ServiceRegistrationCommandRunner;
  readonly userId?: number;
}): ReturnType<typeof applyPackagedRepairFromPayload> {
  const controller = new PackagedPlatformServiceController({
    blueprint: input.plan.blueprint,
    ...(input.runner ? { runner: input.runner } : {}),
    ...(input.userId === undefined ? {} : { userId: input.userId }),
  });
  return applyPackagedRepairFromPayload({
    plan: input.plan,
    payloadSourcePath: input.payloadSourcePath,
    services: controller,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.home ? { home: input.home } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
  });
}
