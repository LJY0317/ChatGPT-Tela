import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Read direct job fields only; nested coalitions and requirements are not job authority. */
function directJobFields(stdout: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  let depth = 0;
  let roots = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (/=>?\s*\{\s*$/.test(line)) {
      if (depth === 0) roots++;
      depth++;
    } else if (/^\s*}\s*$/.test(line)) {
      if (depth === 0) throw new Error("launchd service dictionary is malformed");
      depth--;
    } else if (depth === 1) {
      const entry = /^\s*([a-z]+(?: [a-z]+)*)\s*=\s*(.+?)\s*$/.exec(line);
      if (entry) fields.set(entry[1]!, [...(fields.get(entry[1]!) ?? []), entry[2]!]);
    }
  }
  if (roots !== 1 || depth !== 0) throw new Error("launchd service dictionary is malformed");
  return fields;
}

function singleField(fields: Map<string, string[]>, name: string): string | undefined {
  const values = fields.get(name);
  return values?.length === 1 ? values[0] : undefined;
}

export function launchdJobField(stdout: string, field: "state" | "path"): string {
  const value = singleField(directJobFields(stdout), field);
  if (value === undefined) throw new Error(`launchd service ${field} is ambiguous`);
  return value;
}

/** Safe evidence only, for failed starts; never expose a job's raw output, PID or paths. */
export function launchdJobFailureEvidence(stdout: string): Readonly<{
  state: string;
  process: "present" | "absent" | "unknown";
  lastExitReason: string;
  lastExitCode: string;
  spawnFailed: "yes" | "no" | "unknown";
}> {
  const fields = directJobFields(stdout);
  const rawState = singleField(fields, "state")?.toLowerCase();
  const state = rawState && ["running", "not running", "exited", "xpcproxy"].includes(rawState) ? rawState : "unknown";
  const pid = singleField(fields, "pid");
  const process = pid && /^\d{1,9}$/.test(pid) ? (Number(pid) > 0 ? "present" : "absent") : "unknown";
  const rawReason = singleField(fields, "last exit reason") ?? "";
  const osReason = /^(OS_REASON_[A-Z][A-Z0-9_]{0,47})(?:\b|$)/.exec(rawReason);
  const lastExitReason = osReason?.[1] ?? (rawReason.toLowerCase() === "spawn failed" ? "spawn failed" : "unknown");
  const rawExitCode = singleField(fields, "last exit code") ?? "";
  const lastExitCode = /^(?:-?\d{1,9}|0x[0-9a-fA-F]{1,8})$/.test(rawExitCode) ? rawExitCode : "unknown";
  const rawSpawnFailed = singleField(fields, "spawn failed")?.toLowerCase();
  const spawnFailed = lastExitReason === "spawn failed" || rawSpawnFailed === "true" || rawSpawnFailed === "1"
    ? "yes" : rawSpawnFailed === "false" || rawSpawnFailed === "0" ? "no" : "unknown";
  return Object.freeze({ state, process, lastExitReason, lastExitCode, spawnFailed });
}

/** Session-wide labels must resolve to this install's physical definition before mutation. */
export function assertLaunchdJobDefinition(stdout: string, expectedPath: string | undefined): void {
  const loadedPath = launchdJobField(stdout, "path");
  if (!isAbsolute(loadedPath) || !expectedPath
    || realpathSync(loadedPath) !== realpathSync(expectedPath)) {
    throw new Error("loaded launchd registration belongs to a different definition");
  }
}
