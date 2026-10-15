import type { ChildProcess } from "node:child_process";

export function waitForOwnedProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

/** Only for the exact backend child owned by this target, never an external Desktop. */
export function createOwnedBackendStop(child: ChildProcess, timeoutMs: number): () => Promise<void> {
  let requested = false;
  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // POSIX app-server drains on its first SIGTERM; a second signal forces exit.
    // Windows uses Node's owned-process termination contract, not POSIX drain semantics.
    if (!requested) {
      if (!child.kill("SIGTERM")) throw new Error("Owned Native backend stop request failed");
      requested = true;
    }
    if (!await waitForOwnedProcessExit(child, timeoutMs)) {
      throw new Error("Owned Native backend shutdown is still pending");
    }
  };
}
