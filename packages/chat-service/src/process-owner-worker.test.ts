import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { terminateOwnedProcessTree } from "./process-owner-worker";

test("cancellation ends only the isolated owned shell and its noninteractive descendant", async () => {
  if (process.platform === "win32") return; // Windows taskkill /T needs separate platform acceptance.
  const child = spawn("/bin/sh", ["-c", "sh -c 'sleep 60 & wait' & wait"], {
    detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve); child.once("error", reject);
    });
    child.stdin.end(); // Noninteractive stdin is already closed before cancellation.
    expect(child.pid).toBeGreaterThan(0);
    const closed = new Promise<void>(resolve => child.once("close", resolve));
    await terminateOwnedProcessTree(child.pid!);
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error("owned tree did not close")), 3000))]);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Fixture already ended. */ }
    }
  }
});
