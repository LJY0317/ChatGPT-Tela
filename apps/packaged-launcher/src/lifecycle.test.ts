import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPackagedPayload,
  resolveProductPaths,
  type ServiceRegistrationCommandResult,
  type ServiceRegistrationCommandRunner,
} from "@chatgpt-tela/product-lifecycle";
import { parsePackagedLifecycleCommand, runPackagedLifecycleCommand } from "./lifecycle";
import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";

const removeFixture = registerTemporaryFixtureCleanup();

class SystemdFixtureRunner implements ServiceRegistrationCommandRunner {
  readonly loaded = new Set<string>();
  readonly enabled = new Set<string>();

  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    if (command !== "systemctl") throw new Error(`unexpected command ${command}`);
    const unit = arguments_.at(-1) ?? "";
    if (arguments_.includes("show")) {
      const present = this.loaded.has(unit);
      return { exitCode: present ? 0 : 1, stdout: present ? "loaded\n" : "not-found\n", stderr: "" };
    }
    if (arguments_.includes("is-enabled")) {
      const present = this.enabled.has(unit);
      return { exitCode: present ? 0 : 1, stdout: present ? "enabled\n" : "disabled\n", stderr: "" };
    }
    if (arguments_.includes("daemon-reload")) return { exitCode: 0, stdout: "", stderr: "" };
    if (arguments_.includes("enable")) {
      this.loaded.add(unit);
      this.enabled.add(unit);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected systemctl args ${arguments_.join(" ")}`);
  }
}

function fixture(root: string) {
  const input = join(root, "input");
  const payload = join(root, "payload");

  mkdirSync(join(input, "electron", "bin"), { recursive: true });
  writeFileSync(join(input, "launcher"), "launcher\n", { mode: 0o755 });
  for (const service of ["gateway", "chat", "codex"] as const) {
    writeFileSync(join(input, service), `${service}\n`, { mode: 0o755 });
  }
  writeFileSync(join(input, "profile-runtime.cjs"), "module.exports = {};\n");
  writeFileSync(join(input, "electron", "bin", "electron"), "electron\n", { mode: 0o755 });

  buildPackagedPayload({
    outputPath: payload,
    productVersion: "1.2.3",
    launcherSourcePath: join(input, "launcher"),
    services: {
      gateway: { executableSourcePath: join(input, "gateway") },
      chat: { executableSourcePath: join(input, "chat") },
      codex: { executableSourcePath: join(input, "codex") },
    },
    profileRuntime: {
      electronBundleSourcePath: join(input, "electron"),
      electronExecutableRelativePath: "bin/electron",
      entrypointSourcePath: join(input, "profile-runtime.cjs"),
    },
  });
  return { payload };
}

describe("packaged lifecycle CLI", () => {
  test("requires one explicit mutation mode with no release-key arguments", () => {
    expect(() => parsePackagedLifecycleCommand(["install", ]))
      .toThrow("exactly one");
    expect(parsePackagedLifecycleCommand(["install", "--dry-run"]))
      .toEqual({ command: "install", mode: "dry-run" });
    expect(() => parsePackagedLifecycleCommand(["install", "--dry-run", "--apply", ]))
      .toThrow("exactly one");
    expect(() => parsePackagedLifecycleCommand(["install", "--dry-run", "--future"]))
      .toThrow("unknown");
  });

  test("upgrade cancellation requires an explicit retained source package", () => {
    expect(() => parsePackagedLifecycleCommand(["cancel-upgrade", "--dry-run", ]))
      .toThrow("requires --payload");
    expect(parsePackagedLifecycleCommand(["cancel-upgrade", "--dry-run", "--payload", "source-package"]))
      .toEqual({ command: "cancel-upgrade", mode: "dry-run", payloadSourcePath: "source-package" });
  });

  test("dry-runs then applies an install using the reviewed package layout", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-lifecycle-"));
    const home = join(root, "home");
    mkdirSync(home);
    const { payload } = fixture(root);
    const runner = new SystemdFixtureRunner();
    const options = { defaultPayloadRoot: payload, platform: "linux" as const, home, environment: {}, runner };
    try {
      const dryRun = await runPackagedLifecycleCommand([
        "install", "--dry-run", ], options) as { plan: { createCount: number; preservedCount: number } };
      expect(dryRun.plan.createCount).toBeGreaterThan(0);
      expect(dryRun.plan.preservedCount).toBe(0);

      const applied = await runPackagedLifecycleCommand([
        "install", "--apply", ], options) as { apply: { failedCount: number }; verify: { ready: boolean } };
      expect(applied.apply.failedCount).toBe(0);
      expect(applied.verify.ready).toBe(true);
      expect(existsSync(resolveProductPaths({ platform: "linux", home, environment: {} }).installManifest)).toBe(true);
    } finally {
      removeFixture(root);
    }
  });
});
