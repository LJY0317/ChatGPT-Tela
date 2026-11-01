import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnershipManifest, prepareOwnedDirectory, registerLocalMarketplace,
  resolveProductPaths, writeOwnershipManifest } from "@chatgpt-tela/product-lifecycle";
import { runProductUninstall } from "./index";

test("personal local marketplace registration preserves other entries and resumes owned uninstall", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-marketplace-"));
  try {
    const home = join(root, "home"), options = { platform: "linux" as const, home, environment: {} };
    const paths = resolveProductPaths(options), manifest = createOwnershipManifest("1", new Date(), "fixture");
    writeOwnershipManifest(paths.installManifest, manifest);
    const plugin = join(paths.stateRoot, "install", "local-chat-plugin");
    await prepareOwnedDirectory({ manifestPath: paths.installManifest, installId: manifest.installId,
      productVersion: manifest.productVersion, resource: { kind: "directory", id: "local-chat-plugin-source",
        owner: "product", path: plugin, dataClass: "binary" } });
    mkdirSync(join(plugin, "plugins", "tela-local-chat"), { recursive: true });
    mkdirSync(join(plugin, ".agents", "plugins"), { recursive: true });
    for (const file of ["plugin.json", "mcp.json"]) {
      writeFileSync(join(plugin, "plugins", "tela-local-chat", file), "{}");
    }
    writeFileSync(join(plugin, ".agents", "plugins", "marketplace.json"), "{}");
    writeFileSync(join(plugin, "README.md"), "generated");
    const marketplace = join(home, ".agents", "plugins", "marketplace.json");
    mkdirSync(join(home, ".agents", "plugins"), { recursive: true });
    writeFileSync(marketplace, JSON.stringify({ name: "personal", extra: { untouched: true },
      plugins: [{ name: "other", custom: 7 }] }));
    const register = () => registerLocalMarketplace({ manifestPath: paths.installManifest,
      marketplacePath: marketplace, pluginPath: join(plugin, "plugins", "tela-local-chat") });
    expect(await register()).toBe("registered");
    expect(await register()).toBe("already-registered");
    let parsed = JSON.parse(readFileSync(marketplace, "utf8"));
    expect(parsed.extra).toEqual({ untouched: true });
    expect(parsed.plugins[0]).toEqual({ name: "other", custom: 7 });
    parsed.plugins.push({ name: "user-added", enabled: false });
    writeFileSync(marketplace, JSON.stringify(parsed));
    const dry = await runProductUninstall({ mode: "dry-run", ...options }) as { steps: { resourceId: string; action: string }[] };
    expect(dry.steps.find(x => x.resourceId === "local-chat-personal-marketplace")?.action).toBe("remove");
    const applied = await runProductUninstall({ mode: "apply", removeData: true, ...options });
    expect(applied.removedCount).toBeGreaterThan(0);
    parsed = JSON.parse(readFileSync(marketplace, "utf8"));
    expect(parsed.plugins).toEqual([{ name: "other", custom: 7 }, { name: "user-added", enabled: false }]);
    expect(parsed.extra).toEqual({ untouched: true });
    expect(await runProductUninstall({ mode: "apply", removeData: true, ...options })).toMatchObject({ status: "not-installed-by-manifest" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("user modification to Tela marketplace entry is preserved on uninstall", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-marketplace-drift-"));
  try {
    const home = join(root, "home"), options = { platform: "linux" as const, home, environment: {} };
    const paths = resolveProductPaths(options), manifest = createOwnershipManifest("1", new Date(), "fixture");
    writeOwnershipManifest(paths.installManifest, manifest);
    const marketplace = join(home, ".agents", "plugins", "marketplace.json");
    expect(await registerLocalMarketplace({ manifestPath: paths.installManifest,
      marketplacePath: marketplace, pluginPath: join(root, "plugin") })).toBe("registered");
    const edited = JSON.parse(readFileSync(marketplace, "utf8"));
    edited.plugins[0].userOption = true;
    writeFileSync(marketplace, JSON.stringify(edited));
    expect(await registerLocalMarketplace({ manifestPath: paths.installManifest,
      marketplacePath: marketplace, pluginPath: join(root, "plugin") })).toBe("preserved-user-change");
    const applied = await runProductUninstall({ mode: "apply", removeData: true, ...options });
    expect(applied.preservedCount).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(marketplace, "utf8")).plugins[0].userOption).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
