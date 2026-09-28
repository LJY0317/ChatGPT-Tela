import { describe, expect, test } from "bun:test";
import { diagnoseDefaultDesktop } from "./doctor";
import type { DefaultDesktopInstallation } from "./platform";

const installation: DefaultDesktopInstallation = {
  platform: "linux",
  chatGptExecutable: "/fixture/ChatGPT",
  codexExecutable: "/fixture/codex",
  codexHome: "/fixture/.codex",
  userDataDir: "/fixture/.config/Codex",
  normalQuitSupported: true,
};

describe("default Desktop doctor", () => {
  test("reports a fully resolved stopped installation as ready-to-start", async () => {
    expect(await diagnoseDefaultDesktop({
      resolveInstallation: () => installation,
      run: () => ({ exitCode: 0, stdout: "codex-cli 1.2.3\n", stderr: "" }),
      processIds: async () => [],
    })).toEqual({
      version: 1,
      ready: true,
      action: "ready-to-start",
      discovery: { state: "ready", installation },
      codexRuntime: { state: "ready", version: "codex-cli 1.2.3" },
      desktop: { state: "stopped" },
    });
  });

  test("one exact running Desktop remains usable but requires the normal restart path", async () => {
    expect(await diagnoseDefaultDesktop({
      resolveInstallation: () => installation,
      run: () => ({ exitCode: 0, stdout: "codex-cli 1.2.3", stderr: "" }),
      processIds: async () => [42],
    })).toMatchObject({ ready: true, action: "restart-required", desktop: { state: "running", pid: 42 } });
  });

  test("multiple exact Desktop processes fail closed without selecting one", async () => {
    expect(await diagnoseDefaultDesktop({
      resolveInstallation: () => installation,
      run: () => ({ exitCode: 0, stdout: "codex-cli 1.2.3", stderr: "" }),
      processIds: async () => [42, 43],
    })).toMatchObject({
      ready: false,
      action: "close-duplicate-desktop-processes",
      desktop: { state: "ambiguous", pids: [42, 43] },
    });
  });

  test("discovery failure does not probe process or runtime state", async () => {
    let ran = false;
    let observed = false;
    const report = await diagnoseDefaultDesktop({
      resolveInstallation: () => { throw new Error("package missing"); },
      run: () => { ran = true; return { exitCode: 0, stdout: "", stderr: "" }; },
      processIds: async () => { observed = true; return []; },
    });
    expect(report).toMatchObject({
      ready: false,
      action: "repair-desktop-installation",
      discovery: { state: "blocked", detail: "package missing" },
      codexRuntime: { state: "not-checked" },
      desktop: { state: "not-checked" },
    });
    expect(ran).toBe(false);
    expect(observed).toBe(false);
  });

  test("non-runnable Codex is reported separately from Desktop discovery", async () => {
    expect(await diagnoseDefaultDesktop({
      resolveInstallation: () => installation,
      run: () => ({ exitCode: 126, stdout: "", stderr: "permission denied\n" }),
      processIds: async () => [],
    })).toMatchObject({
      ready: false,
      action: "repair-codex-runtime",
      discovery: { state: "ready" },
      codexRuntime: { state: "blocked" },
      desktop: { state: "stopped" },
    });
  });

  test("Desktop process inspection failures retain actionable bounded detail", async () => {
    expect(await diagnoseDefaultDesktop({
      resolveInstallation: () => installation,
      run: () => ({ exitCode: 0, stdout: "codex-cli 1.2.3", stderr: "" }),
      processIds: async () => { throw new Error("process inspection unavailable\nsecond line"); },
    })).toMatchObject({
      ready: false,
      action: "repair-desktop-installation",
      discovery: { state: "ready" },
      codexRuntime: { state: "ready" },
      desktop: { state: "blocked", detail: "process inspection unavailable second line" },
    });
  });
});
