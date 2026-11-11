import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { appOwnedDesktopCatalogPath, publishAppOwnedDesktopCatalog } from "@chatgpt-tela/development-runtime/app-owned-desktop-catalog";
import { buildPackagedPayload, CURRENT_PACKAGED_LIFECYCLE, readOwnershipManifest, resolveProductPaths,
  type ServiceRegistrationCommandResult, type ServiceRegistrationCommandRunner } from "@chatgpt-tela/product-lifecycle";
import { runPackagedLifecycleCommand } from "./lifecycle";
import { runPackagedDesktopProviderCommand } from "./desktop-provider";

test("cold installed producer -> explicit packaged provider registration -> exact restore", async () => {
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
      const stdout = arguments_.includes("show") ? "not-found\n" : arguments_.includes("is-active") ? "inactive\n" : "";
      return { stdout, stderr: "", exitCode: arguments_.includes("show") ? 1 : 0 };
    } };
    const pathOptions = { platform: "linux" as const, home, environment: {} };
    await runPackagedLifecycleCommand(["install", "--apply", "--payload", payload], { ...pathOptions, runner });
    const paths = resolveProductPaths(pathOptions);
    const installId = readOwnershipManifest(paths.installManifest)!.installId;
    const capability = "a".repeat(48);
    const officialEngine = process.env.TELA_OFFICIAL_CODEX_ENGINE;
    const portReservation = officialEngine ? Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => new Response("reserved") }) : undefined;
    const providerPort = portReservation?.port ?? 18744;
    portReservation?.stop(true);
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
    await expect(runPackagedDesktopProviderCommand(["desktop-provider", "register", "--apply"], launcher))
      .rejects.toThrow(); // No manual catalog seed can satisfy first registration.
    expect(readFileSync(configPath, "utf8")).toBe(original);
    const family = { key: chatGptWebFamilyKey("Bound Web Family"), label: "Bound Web Family",
      availableEfforts: ["medium"] as const };
    const engineEnvironment = { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: codexHome };
    const nativeCatalog = officialEngine
      ? JSON.parse(execFileSync(officialEngine, ["debug", "models", "--bundled"],
        { env: engineEnvironment, encoding: "utf8" }))
      : { object: "list", models: [{ slug: "native-fixture", display_name: "Native Fixture",
        visibility: "list", supported_reasoning_levels: [{ effort: "medium", description: "Native" }] }] };
    const nativeModel = (nativeCatalog.models as { slug: string }[])[0]!.slug;
    const catalogPath = await publishAppOwnedDesktopCatalog({ paths, installId,
      nativeCatalog,
      webFamilies: [family], assertCurrentAccount: () => {},
    });
    expect(catalogPath).toBe(appOwnedDesktopCatalogPath(paths));
    const result = await runPackagedDesktopProviderCommand(["desktop-provider", "register", "--apply"], launcher);
    expect(result).toMatchObject({ changed: true, catalogStatus: "installed" });
    const registered = readFileSync(configPath, "utf8");
    const parsed = Bun.TOML.parse(registered) as Record<string, any>;
    expect(parsed.model_catalog_json).toBe(catalogPath);
    expect(parsed.model_provider).toBe("openai");
    expect(parsed.model).toBe("original-model");
    expect(parsed.openai_base_url).toBe(`http://127.0.0.1:${providerPort}/${capability}/v1`);
    expect(JSON.parse(readFileSync(catalogPath, "utf8")).models.map((row: { slug: string }) => row.slug))
      .toContain(chatGptWebModelId(family.key));
    if (officialEngine) {
      const fixture = join(import.meta.dir, "../../../packages/development-runtime/src/fixtures/standard-engine-tool-roundtrip.ts");
      for (const selectedModel of [chatGptWebModelId(family.key), nativeModel]) {
        const proof = Bun.spawn([process.execPath, fixture, "--engine", officialEngine,
          "--catalog", catalogPath, "--first-party-auth", "--builtin-provider", "--configured-home", codexHome,
          "--configured-model", selectedModel, "--expected-native-model", nativeModel,
          "--provider-port", String(providerPort)], { cwd: root, env: { ...engineEnvironment, TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proof.stdout).text(), new Response(proof.stderr).text(), proof.exited,
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        const report = JSON.parse(stdout.trim().split("\n").at(-1)!);
        expect(report).toMatchObject({ productionConfigConsumed: true, nativeModelVisible: true,
          providerId: "openai", threadProvider: "openai", toolCallIdMatched: true, hostToolResultSeen: 1, finalAnswerAccepted: true });
      }
      writeFileSync(configPath, registered);
    }
    expect((await runPackagedDesktopProviderCommand(["desktop-provider", "register", "--apply"], launcher)).catalogStatus)
      .toBe("already-owned");
    expect((await runPackagedDesktopProviderCommand(["desktop-provider", "restore", "--apply"], launcher)))
      .toMatchObject({ changed: true, catalogStatus: "removed" });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(readFileSync(catalogPath, "utf8")).toContain(nativeModel);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
