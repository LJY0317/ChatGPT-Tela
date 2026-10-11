import { expect, test } from "bun:test";
import { parseProcessObservation, summarizeProcessInterval, observeDesktopPerformance, gpuProcessIds } from "./desktop-performance";

test("CPU deltas preserve spaces in executable paths and emit only structural roles", () => {
  const before = parseProcessObservation(" 1 0 1:00.00 1024 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n 2 1 0:01.00 2048 /private/account/Codex (Renderer)\n 3 0 0:02.00 1024 /System/WindowServer");
  const after = parseProcessObservation(" 1 0 1:00.10 1024 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n 2 1 0:01.50 2048 /private/account/Codex (Renderer)\n 3 0 0:02.25 1024 /System/WindowServer");
  const result = summarizeProcessInterval(before, after, 1000);
  expect(result.desktop?.cpuPercent).toBeCloseTo(10);
  expect(result.renderer?.cpuPercent).toBe(50);
  expect(result.compositor?.cpuPercent).toBe(25);
  expect(JSON.stringify(result)).not.toContain("account");
  expect(JSON.stringify(result)).not.toContain("pid");
});

test("PID reuse and new processes cannot manufacture a CPU spike", () => {
  const before = parseProcessObservation(" 1 0 0:00.00 1024 /old\n 2 0 0:10.00 1024 /System/WindowServer");
  const after = parseProcessObservation(" 1 0 9:00.00 1024 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n 2 0 0:01.00 1024 /System/WindowServer");
  expect(summarizeProcessInterval(before, after, 1000).desktop?.measuredProcesses).toBe(0);
  expect(summarizeProcessInterval(before, after, 1000).compositor?.cpuPercent).toBe(0);
});

test("invalid bounds fail before observing processes", async () => {
  await expect(observeDesktopPerformance(61)).rejects.toThrow("--seconds");
});

test("GPU classification uses an exact process-type token and excludes argument content", () => {
  expect([...gpuProcessIds("1 /helper --type=gpu-process --credential=private\n2 /helper --type=gpu-process-extra\n3 /helper --label=--type=gpu-process")]).toEqual([1]);
  const desktop = { pid: 10, parent: 0, cpuMs: 0, rssKiB: 0, executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" };
  const gpu = { pid: 11, parent: 10, cpuMs: 0, rssKiB: 1024, executable: "/helper/Codex (Service)", gpu: true };
  const result = summarizeProcessInterval([desktop, gpu], [desktop, { ...gpu, cpuMs: 100 }], 1000);
  expect(result.gpu?.cpuPercent).toBe(10);
  expect(result["desktop-service"]).toBeUndefined();
});
