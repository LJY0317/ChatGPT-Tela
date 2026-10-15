import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createOwnedBackendStop, waitForOwnedProcessExit } from "./owned-process";

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("a slow owned backend is retained and retries cannot send its force-exit signal", async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => console.log("drain"));
    process.stdin.on("data", () => process.exit(0));
    console.log("ready");
  `], { stdio: ["pipe", "pipe", "ignore"] });
  let output = "";
  child.stdout.on("data", data => { output += data.toString(); });
  try {
    while (!output.includes("ready")) await once(child.stdout, "data");
    const stop = createOwnedBackendStop(child, 50);
    await expect(stop()).rejects.toThrow("still pending");
    await expect(stop()).rejects.toThrow("still pending");
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(output.match(/drain/g)?.length).toBe(1);
    expect(child.listenerCount("exit")).toBe(0);
    child.stdin.end("finish");
    expect(await waitForOwnedProcessExit(child, 2_000)).toBe(true);
    await stop();
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForOwnedProcessExit(child, 2_000);
    }
  }
});
