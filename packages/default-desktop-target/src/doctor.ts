import { spawnSync } from "node:child_process";
import {
  defaultDesktopProcessIds,
  resolveDefaultDesktopInstallation,
  type DefaultDesktopInstallation,
} from "./platform";

export interface DefaultDesktopDoctorCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DefaultDesktopDoctorReport {
  readonly version: 1;
  readonly ready: boolean;
  readonly action:
    | "ready-to-start"
    | "restart-required"
    | "close-duplicate-desktop-processes"
    | "repair-desktop-installation"
    | "repair-codex-runtime";
  readonly discovery:
    | { readonly state: "ready"; readonly installation: DefaultDesktopInstallation }
    | { readonly state: "blocked"; readonly detail: string };
  readonly codexRuntime:
    | { readonly state: "ready"; readonly version: string }
    | { readonly state: "blocked"; readonly detail: string }
    | { readonly state: "not-checked" };
  readonly desktop:
    | { readonly state: "stopped" }
    | { readonly state: "running"; readonly pid: number }
    | { readonly state: "ambiguous"; readonly pids: readonly number[] }
    | { readonly state: "blocked"; readonly detail: string }
    | { readonly state: "not-checked" };
}

export interface DefaultDesktopDoctorOptions {
  readonly resolveInstallation?: () => DefaultDesktopInstallation;
  readonly processIds?: (installation: DefaultDesktopInstallation) => Promise<readonly number[]>;
  readonly run?: (command: string, arguments_: readonly string[]) => DefaultDesktopDoctorCommandResult;
}

function sanitize(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\u0000\r\n]+/g, " ").trim().slice(0, 800) || "unknown failure";
}

function firstLine(stdout: string, stderr: string): string {
  const line = `${stdout}\n${stderr}`.split(/\r?\n/).map(value => value.trim()).find(Boolean);
  return (line ?? "unknown version").replace(/[\u0000\r\n]+/g, " ").slice(0, 240);
}

function systemRun(command: string, arguments_: readonly string[]): DefaultDesktopDoctorCommandResult {
  const result = spawnSync(command, [...arguments_], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    env: process.env,
  });
  return Object.freeze({
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  });
}

function desktopState(pids: readonly number[]): DefaultDesktopDoctorReport["desktop"] {
  if (pids.length === 0) return Object.freeze({ state: "stopped" as const });
  if (pids.length === 1) return Object.freeze({ state: "running" as const, pid: pids[0]! });
  return Object.freeze({ state: "ambiguous" as const, pids: Object.freeze([...pids]) });
}

export async function diagnoseDefaultDesktop(
  options: DefaultDesktopDoctorOptions = {},
): Promise<DefaultDesktopDoctorReport> {
  let installation: DefaultDesktopInstallation;
  try {
    installation = (options.resolveInstallation ?? (() => resolveDefaultDesktopInstallation()))();
  } catch (error) {
    return Object.freeze({
      version: 1,
      ready: false,
      action: "repair-desktop-installation",
      discovery: Object.freeze({ state: "blocked" as const, detail: sanitize(error) }),
      codexRuntime: Object.freeze({ state: "not-checked" as const }),
      desktop: Object.freeze({ state: "not-checked" as const }),
    });
  }

  const run = options.run ?? systemRun;
  let codexRuntime: DefaultDesktopDoctorReport["codexRuntime"];
  try {
    const result = run(installation.codexExecutable, ["--version"]);
    codexRuntime = result.exitCode === 0
      ? Object.freeze({ state: "ready" as const, version: firstLine(result.stdout, result.stderr) })
      : Object.freeze({ state: "blocked" as const,
          detail: `Codex executable failed --version with exit code ${result.exitCode}: ${firstLine(result.stderr, result.stdout)}` });
  } catch (error) {
    codexRuntime = Object.freeze({ state: "blocked" as const, detail: sanitize(error) });
  }

  let pids: readonly number[];
  try {
    pids = await (options.processIds ?? defaultDesktopProcessIds)(installation);
  } catch (error) {
    return Object.freeze({
      version: 1,
      ready: false,
      action: codexRuntime.state === "blocked" ? "repair-codex-runtime" : "repair-desktop-installation",
      discovery: Object.freeze({ state: "ready" as const, installation }),
      codexRuntime,
      desktop: Object.freeze({ state: "blocked" as const, detail: sanitize(error) }),
    });
  }
  const desktop = desktopState(pids);

  if (codexRuntime.state === "blocked") {
    return Object.freeze({
      version: 1,
      ready: false,
      action: "repair-codex-runtime",
      discovery: Object.freeze({ state: "ready" as const, installation }),
      codexRuntime,
      desktop,
    });
  }
  if (desktop.state === "ambiguous") {
    return Object.freeze({
      version: 1,
      ready: false,
      action: "close-duplicate-desktop-processes",
      discovery: Object.freeze({ state: "ready" as const, installation }),
      codexRuntime,
      desktop,
    });
  }
  return Object.freeze({
    version: 1,
    ready: true,
    action: desktop.state === "running" ? "restart-required" : "ready-to-start",
    discovery: Object.freeze({ state: "ready" as const, installation }),
    codexRuntime,
    desktop,
  });
}
