import { expect, test } from "bun:test";
import { ProfileConnectionError } from "./profile-operation";
import { startCodexService } from "./controller";
import type { CodexNativeTargetAdapter } from "./native-target";

function fixture(state: string, targetState: string, desktopProcessId?: number) {
  const target = { slot: 1, adapterKind: "default-desktop" as const, id: "default", displayName: "ChatGPT", state: targetState, managed: true };
  const session = { targetId: "default", state, ...(desktopProcessId ? { desktopProcessId } : {}) };
  let quits = 0;
  const adapter: CodexNativeTargetAdapter = {
    kind: "default-desktop", async profiles() { return [{ target, session }]; },
    async resolve() { return { target, session }; }, async session() { return session; },
    async quit() { quits++; return { targetId: "default", state: "available" }; },
    profileRuntimeEnvironment() { return {}; },
  };
  return { adapter, quits: () => quits };
}

test("reopen consent is bound to the observed Desktop PID; replacement apps remain open", async () => {
  const native = fixture("restart-required", "running", 456);
  const service = await startCodexService({ config: {}, profileRuntimeCommand: ["unused"], nativeTargetAdapter: native.adapter });
  try {
    const [profile] = await service.profiles();
    expect(profile?.desktopProcessId).toBe(456);
    expect(profile?.connectionInProgress).toBe(false);
    await expect(service.startProfile(1, { expectedDesktopProcessId: 123 })).rejects.toThrow(ProfileConnectionError);
    expect(native.quits()).toBe(0);
  } finally { await service.close(); }
});

test("reopen rechecks identity immediately before quit after the initial consent check", async () => {
  const native = fixture("restart-required", "running", 123);
  let reads = 0;
  native.adapter.resolve = async () => {
    const [observed] = await native.adapter.profiles();
    return { ...observed!, session: { ...observed!.session, desktopProcessId: ++reads === 1 ? 123 : 456 } };
  };
  const service = await startCodexService({ config: {}, profileRuntimeCommand: ["unused"], nativeTargetAdapter: native.adapter });
  try {
    await expect(service.startProfile(1, { expectedDesktopProcessId: 123 })).rejects.toThrow(ProfileConnectionError);
    expect(native.quits()).toBe(0);
  } finally { await service.close(); }
});

test("stopped launch without an owned child uses one fresh adapter lookup before preparation", async () => {
  const native = fixture("available", "stopped");
  let resolves = 0;
  const resolve = native.adapter.resolve;
  native.adapter.resolve = async (...args) => { resolves++; return resolve(...args); };
  native.adapter.profileRuntimeEnvironment = () => { throw new Error("controlled preparation boundary"); };
  const phases: string[] = [];
  const service = await startCodexService({config:{},profileRuntimeCommand:["unused"],nativeTargetAdapter:native.adapter});
  try {
    await expect(service.startProfile(1,{requireStopped:true,onProgress: phase => phases.push(phase)})).rejects.toThrow(ProfileConnectionError);
    expect(resolves).toBe(1);
    expect(phases).toContain("preparing");
    expect(native.quits()).toBe(0);
  } finally { await service.close(); }
});

test("restoration rechecks ownership and cannot quit an app that opened since discovery", async () => {
  const native = fixture("restart-required", "running");
  const changes: unknown[] = [];
  const service = await startCodexService({ config: {}, profileRuntimeCommand: ["unused"], nativeTargetAdapter: native.adapter,
    onProfileConnectionChanged: (...args) => { changes.push(args); } });
  try {
    await expect(service.startProfile(1, { requireStopped: true })).rejects.toThrow(ProfileConnectionError);
    expect(native.quits()).toBe(0); expect(changes).toEqual([]);
  } finally { await service.close(); }
});

test("explicit disconnect clears choice, service shutdown alone never clears it", async () => {
  const native = fixture("available", "stopped");
  const changes: unknown[] = [];
  const service = await startCodexService({ config: {}, profileRuntimeCommand: ["unused"], nativeTargetAdapter: native.adapter,
    onProfileConnectionChanged: (...args) => { changes.push(args); } });
  await service.stopProfile(1); expect(changes).toEqual([["default", false]]);
  await service.close(); expect(changes).toEqual([["default", false]]);
  await expect(service.startProfile(1)).rejects.toThrow("stopping");
});

test("a foreign ready route cannot be stopped or erase connection intent", async () => {
  const native = fixture("ready", "running");
  let changes = 0;
  const service = await startCodexService({ config: {}, profileRuntimeCommand: ["unused"], nativeTargetAdapter: native.adapter,
    onProfileConnectionChanged: () => { changes++; } });
  try { await expect(service.stopProfile(1)).rejects.toThrow("another owner"); expect(changes).toBe(0); expect(native.quits()).toBe(0); }
  finally { await service.close(); }
});


test("quit failure has a stable phase and no raw process/error payload; duplicate starts are excluded", async () => {
  const native = fixture("restart-required", "running");
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  native.adapter.quit = async () => { await blocked; throw new Error("private path/account fixture must not escape"); };
  const phases: string[] = [];
  const service = await startCodexService({ config: {}, profileRuntimeCommand: ["unused"], nativeTargetAdapter: native.adapter });
  try {
    const first = service.startProfile(1, { onProgress: phase => { phases.push(phase); } });
    // Allow resolve to enter the controlled quit operation.
    await Promise.resolve(); await Promise.resolve();
    await expect(service.startProfile(1)).rejects.toThrow("already running");
    release();
    const failure = await first.catch(error => error);
    expect(failure).toBeInstanceOf(ProfileConnectionError);
    expect(failure.phase).toBe("closing");
    expect(failure.message).not.toContain("private path");
    expect(phases).toEqual(["checking", "closing"]);
  } finally { release(); await service.close(); }
});
