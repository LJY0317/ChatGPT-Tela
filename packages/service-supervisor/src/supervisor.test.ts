import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import { LocalServiceSupervisor } from "./index";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function isolatedProductEnvironment(home: string, installId: string): Record<string, string> {
  if (process.platform === "win32") {
    return {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      CHATGPT_TELA_INSTALL_ID: installId,
    };
  }
  if (process.platform === "linux") {
    return {
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_RUNTIME_DIR: join(home, ".runtime"),
      CHATGPT_TELA_INSTALL_ID: installId,
    };
  }
  return { HOME: home, CHATGPT_TELA_INSTALL_ID: installId };
}

describe("local service supervisor", () => {
  test("starts, reuses, and normally shuts down one exact Chat daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "tela-supervisor-"));
    const environment = isolatedProductEnvironment(home, "supervisor-install-1");
    const paths = resolveProductPaths({ platform: process.platform, home, environment });
    const descriptorPath = join(paths.serviceRuntime("chat"), "descriptor.json");
    const logPath = join(paths.logsRoot, "chat-supervisor-test.log");
    const supervisor = new LocalServiceSupervisor({ installId: "supervisor-install-1" });
    const input = {
      service: "chat" as const,
      descriptorPath,
      command: [process.execPath, resolve(repoRoot, "apps/chat-daemon/src/main.ts")] as const,
      cwd: repoRoot,
      environment,
      logPath,
    };
    try {
      const first = await supervisor.ensure(input);
      expect(first.status.state).toBe("ready");
      expect(first.descriptor.service).toBe("chat");
      const second = await supervisor.ensure(input);
      expect(second.descriptor.pid).toBe(first.descriptor.pid);
      expect(await supervisor.shutdown({ service: "chat", descriptorPath })).toBe(true);
      expect(existsSync(descriptorPath)).toBe(false);
      expect(await supervisor.current({ service: "chat", descriptorPath })).toBeUndefined();
    } finally {
      const running = await supervisor.current({ service: "chat", descriptorPath }).catch(() => undefined);
      if (running) await supervisor.shutdown({ service: "chat", descriptorPath }).catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("supervises Gateway, Chat, and Codex as independent process failure domains", async () => {
    const home = mkdtempSync(join(tmpdir(), "tela-supervisor-split-"));
    const common = isolatedProductEnvironment(home, "supervisor-split-install");
    const paths = resolveProductPaths({ platform: process.platform, home, environment: common });
    const supervisor = new LocalServiceSupervisor({ installId: "supervisor-split-install" });
    const descriptor = (service: "gateway" | "chat" | "codex") => join(paths.serviceRuntime(service), "descriptor.json");
    try {
      const chat = await supervisor.ensure({
        service: "chat",
        descriptorPath: descriptor("chat"),
        command: [process.execPath, resolve(repoRoot, "apps/chat-daemon/src/main.ts")],
        cwd: repoRoot,
        environment: common,
        logPath: join(paths.logsRoot, "chat-split-test.log"),
      });
      const codex = await supervisor.ensure({
        service: "codex",
        descriptorPath: descriptor("codex"),
        command: [process.execPath, resolve(repoRoot, "apps/codex-daemon/src/main.ts")],
        cwd: repoRoot,
        environment: {
          ...common,
          CHATGPT_TELA_CODEX_MULTI_PROFILE_LAUNCHER_CLI: process.platform === "win32" ? process.execPath : "/bin/true",
          CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_EXECUTABLE: process.platform === "win32" ? process.execPath : "/bin/true",
          CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_ENTRYPOINT: process.platform === "win32" ? "--version" : "/tmp/tela-unused-profile-runtime",
        },
        logPath: join(paths.logsRoot, "codex-split-test.log"),
      });
      const gateway = await supervisor.ensure({
        service: "gateway",
        descriptorPath: descriptor("gateway"),
        command: [process.execPath, resolve(repoRoot, "apps/gateway-daemon/src/main.ts")],
        cwd: repoRoot,
        environment: common,
        logPath: join(paths.logsRoot, "gateway-split-test.log"),
      });
      expect(chat.status.state).toBe("ready");
      expect(codex.status.state).toBe("ready");
      expect(gateway.status.state).toBe("ready");

      const backendStatus = async () => {
        const response = await fetch(new URL("v1/backends", gateway.descriptor.endpoint), {
          headers: { authorization: `Bearer ${gateway.descriptor.bearerToken}` },
        });
        expect(response.status).toBe(200);
        return await response.json() as { backends: Array<{ service: string; availability: string }> };
      };
      expect((await backendStatus()).backends.map(item => [item.service, item.availability])).toEqual([
        ["chat", "ready"],
        ["codex", "ready"],
      ]);

      await supervisor.shutdown({ service: "chat", descriptorPath: descriptor("chat") });
      expect((await backendStatus()).backends.map(item => [item.service, item.availability])).toEqual([
        ["chat", "unavailable"],
        ["codex", "ready"],
      ]);
      expect((await supervisor.current({ service: "gateway", descriptorPath: descriptor("gateway") }))?.status.state).toBe("ready");

      await supervisor.shutdown({ service: "codex", descriptorPath: descriptor("codex") });
      expect((await backendStatus()).backends.map(item => [item.service, item.availability])).toEqual([
        ["chat", "unavailable"],
        ["codex", "unavailable"],
      ]);
      expect((await supervisor.current({ service: "gateway", descriptorPath: descriptor("gateway") }))?.status.state).toBe("ready");
      await supervisor.shutdown({ service: "gateway", descriptorPath: descriptor("gateway") });
    } finally {
      for (const service of ["gateway", "chat", "codex"] as const) {
        await supervisor.shutdown({ service, descriptorPath: descriptor(service) }).catch(() => {});
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
