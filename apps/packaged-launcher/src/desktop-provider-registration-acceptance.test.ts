import { systemdUnitFixture } from "../../../tests/support/systemd-unit";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackagedPayload, CURRENT_PACKAGED_LIFECYCLE, readOwnershipManifest, resolveProductPaths,
  type ServiceRegistrationCommandResult, type ServiceRegistrationCommandRunner } from "@chatgpt-tela/product-lifecycle";
import { runPackagedLifecycleCommand } from "./lifecycle";
import { runPackagedDesktopProviderCommand } from "./desktop-provider";

test("packaged registration preserves server discovery without a prepared snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-packaged-desktop-cold-"));
  try {
    const home = join(root, "home"), sources = join(root, "sources"), payload = join(root, "payload");
    mkdirSync(home); mkdirSync(sources);
    mkdirSync(join(sources, "electron"));
    writeFileSync(join(sources, "electron", "electron"), "fixture", { mode: 0o755 });
    writeFileSync(join(sources, "runtime.cjs"), "module.exports = {};\n");
    writeFileSync(join(sources, "launcher"), "fixture", { mode: 0o755 });
    buildPackagedPayload({ outputPath: payload, productVersion: "1.0.0", lifecycle: CURRENT_PACKAGED_LIFECYCLE,
      launcherSourcePath: join(sources, "launcher"),
      services: Object.fromEntries((["gateway", "chat", "codex"] as const).map(service => [service,
        { executableSourcePath: join(sources, "launcher") }])) as Record<"gateway" | "chat" | "codex", { executableSourcePath: string }>,
      profileRuntime: { electronBundleSourcePath: join(sources, "electron"),
        electronExecutableRelativePath: "electron", entrypointSourcePath: join(sources, "runtime.cjs"),
        setupEntrypointSourcePath: join(sources, "runtime.cjs") },
    });
    const runner: ServiceRegistrationCommandRunner = { async run(_command, arguments_): Promise<ServiceRegistrationCommandResult> {
      if (arguments_.includes("show")) return systemdUnitFixture();
      return { stdout: arguments_.includes("is-active") ? "inactive\n" : "", stderr: "", exitCode: 0 };
    } };
    const pathOptions = { platform: "linux" as const, home, environment: {} };
    await runPackagedLifecycleCommand(["install", "--apply", "--payload", payload], { ...pathOptions, runner });
    const paths = resolveProductPaths(pathOptions);
    const installId = readOwnershipManifest(paths.installManifest)!.installId;
    const capability = "a".repeat(48);
    const providerPort = 18744;
    mkdirSync(paths.configRoot, { recursive: true });
    writeFileSync(join(paths.configRoot, "product-v1.json"), JSON.stringify({
      version: 1, publicMcpAbi: "stable", exposure: { kind: "existing-https", publicUrl: "https://example.test/mcp",
        localPort: 18743, authentication: "none", allowUnauthenticatedPublicEndpoint: true },
      appOwnedResponses: [{ slot: 1, port: providerPort, capability }],
    }));
    const codexHome = join(home, ".codex"); mkdirSync(codexHome);
    const configPath = join(codexHome, "config.toml");
    const original = 'model_provider = "openai"\nmodel = "original-model"\n# preserve user comment\n';
    writeFileSync(configPath, original);
    const launcher = { payloadRoot: paths.binaryRoot, pathOptions };
    const result = await runPackagedDesktopProviderCommand(["desktop-provider", "register", "--apply"], launcher);
    expect(result).toMatchObject({ changed: true, catalogStatus: "absent" });
    const registered = readFileSync(configPath, "utf8");
    const parsed = Bun.TOML.parse(registered) as Record<string, any>;
    expect(parsed.model_catalog_json).toBeUndefined();
    expect(parsed.model_provider).toBe("openai");
    expect(parsed.model).toBe("original-model");
    expect(parsed.openai_base_url).toBe(`http://127.0.0.1:${providerPort}/${capability}/v1`);
    expect((await runPackagedDesktopProviderCommand(["desktop-provider", "register", "--apply"], launcher)).catalogStatus)
      .toBe("absent");
    expect((await runPackagedDesktopProviderCommand(["desktop-provider", "restore", "--apply"], launcher)))
      .toMatchObject({ changed: true, catalogStatus: "absent" });
    expect(readFileSync(configPath, "utf8")).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
