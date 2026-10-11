import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export interface ProfileLaunch {
  readonly kind: "direct" | "macos-application";
  readonly command: readonly [string, ...string[]];
  readonly executable: string;
}

/** The caller supplies the receipt-verified runtime executable, not an app-name search. */
export function profileLaunch(command: readonly [string, ...string[]], platform = process.platform): ProfileLaunch {
  if (command.some(value => !value || value.includes("\0"))) throw new Error("profile launch command is invalid");
  const executable = resolve(command[0]);
  const macos = dirname(executable), contents = dirname(macos), bundle = dirname(contents);
  if (platform === "darwin" && basename(macos) === "MacOS" && basename(contents) === "Contents" && bundle.endsWith(".app")) {
    return Object.freeze({kind: "macos-application", executable, command: ["/usr/bin/open", "-W", "-n", "-a", bundle, "--args", ...command.slice(1)] as const});
  }
  // CLI fixtures and other OS runtimes remain ordinary supervised child processes.
  return Object.freeze({kind: "direct", executable, command});
}

/** One fresh OS identity check; never adopt or signal a process found by name. */
export async function verifyProfileRuntimeProcess(launch: ProfileLaunch, runtimePid: number, launcherPid?: number): Promise<void> {
  if (launch.kind === "direct") {
    if (runtimePid !== launcherPid) throw new Error("profile readiness belongs to a different child process");
    return;
  }
  const output = await promisify(execFile)("/bin/ps", ["-p", String(runtimePid), "-o", "comm="], {timeout:3000,maxBuffer:4096});
  const executable = output.stdout.trim();
  if (!executable || executable !== launch.executable) {
    throw new Error("profile readiness belongs to a different macOS application");
  }
  // The executable basename is receipt-owned through the original command; no app-name lookup.
  if (await realpath(executable) !== executable) throw new Error("profile runtime application identity is ambiguous");
}
