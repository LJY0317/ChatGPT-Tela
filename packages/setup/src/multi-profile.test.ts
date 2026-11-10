import { describe, expect, test } from "bun:test";
import type {
  MultiProfileControlResult,
  MultiProfileControlRunner,
} from "./multi-profile";
import { MultiProfileControlClient } from "./multi-profile";
import { observeDiagnosticEvents } from "@chatgpt-tela/core";

class FixtureRunner implements MultiProfileControlRunner {
  readonly calls: Array<{
    command: readonly string[];
    arguments: readonly string[];
    environment?: Readonly<Record<string, string>>;
  }> = [];
  readonly results: MultiProfileControlResult[] = [];

  async run(command: readonly [string, ...string[]], input: {
    readonly arguments: readonly string[];
    readonly environment?: Readonly<Record<string, string>>;
  }): Promise<MultiProfileControlResult> {
    this.calls.push({
      command: [...command],
      arguments: [...input.arguments],
      ...(input.environment ? { environment: { ...input.environment } } : {}),
    });
    const result = this.results.shift();
    if (!result) throw new Error("fixture runner has no result");
    return result;
  }
}

function result(value: unknown, exitCode = 0): MultiProfileControlResult {
  return { stdout: JSON.stringify(value), stderr: "", exitCode };
}

const id = "local.plura-desktop.profile2";
const target = { id, displayName: "ChatGPT Profile 2", managed: true, role: "managed", state: "stopped", profileIndex: 2, backendPolicy: "official-desktop-owned" };
const session = { contractVersion: 2, targetID: id, backendPolicy: "official-desktop-owned", state: "launch-requested" };
test("v2 owns only app lifecycle and does not inject routes, credentials or another engine", async () => {
  const runner = new FixtureRunner();
  runner.results.push(result({ contractVersion: 2, targets: [target] }), result(session), result({ ...session, state: "running", desktopProcessID: 42 }), result({ ...session, state: "stopped" }));
  const client = new MultiProfileControlClient({ command: ["fixture"], runner });
  expect(await client.launchTarget({ targetId: id, expectedProfileIndex: 2 })).toEqual({ targetId: id, state: "launch-requested" });
  expect(await client.targetSession(id)).toEqual({ targetId: id, state: "running", desktopProcessId: 42 });
  expect(await client.quitTarget(id, undefined, 42)).toEqual({ targetId: id, state: "stopped" });
  expect(runner.calls.map(call => call.arguments)).toEqual([["targets", "--json"], ["launch-target", "--target", id, "--json"], ["target-session", "--target", id, "--json"], ["quit-target", "--target", id, "--expected-desktop-pid", "42", "--json"]]);
  expect(runner.calls.every(call => call.environment === undefined)).toBe(true);
});
test("v2 rejects a different profile and does not fall back to a v1 Native runtime", async () => {
  const runner = new FixtureRunner();
  runner.results.push(result({ contractVersion: 2, targets: [{ ...target, profileIndex: 3 }] }), result({ contractVersion: 1, targets: [] }));
  const client = new MultiProfileControlClient({ command: ["fixture"], runner });
  await expect(client.launchTarget({ targetId: id, expectedProfileIndex: 2 })).rejects.toThrow("selected profile");
  await expect(client.targets()).rejects.toThrow("contract v2");
  expect(runner.calls.every(call => call.arguments[0] === "targets")).toBe(true);
});
test("failed app launch emits structural evidence without private output", async () => {
  const runner = new FixtureRunner(); runner.results.push({ exitCode: 1, stdout: "private stdout", stderr: "private stderr" });
  const events: unknown[] = []; const stop = observeDiagnosticEvents(event => events.push(event));
  try {
    await expect(new MultiProfileControlClient({ command: ["fixture"], runner }).launchTarget({ targetId: id })).rejects.toThrow("exit code 1");
    expect(JSON.stringify(events)).not.toContain("private");
    expect(events).toContainEqual(expect.objectContaining({ action: "launch-target", exit_code: 1, stdout_bytes: 14 }));
  } finally { stop?.(); }
});
