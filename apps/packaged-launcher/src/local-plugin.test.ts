import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedInstalledPlugin, refreshInstalledLocalPlugin } from "./local-plugin";
import { resolveProductPaths, createOwnershipManifest, writeOwnershipManifest } from "@chatgpt-tela/product-lifecycle";

test("installed identity comes from the exact local source, not a personal marketplace name or matching title", () => {
  const own = { name: "tela-local-chat", pluginId: "tela-local-chat@personal-name", version: "0.0.3", enabled: true,
    source: { source: "local", path: join(tmpdir(), "owned") } };
  expect(ownedInstalledPlugin({ installed: [own] }, own.source.path)?.pluginId).toBe(own.pluginId);
  expect(ownedInstalledPlugin({ installed: [{ ...own, source: { source: "remote" } }] }, own.source.path)).toBeUndefined();
  expect(ownedInstalledPlugin({ installed: [{ ...own, source: { source: "local", path: join(tmpdir(), "foreign") } }] }, own.source.path)).toBeUndefined();
  expect(() => ownedInstalledPlugin({}, own.source.path)).toThrow();
  expect(() => ownedInstalledPlugin({ installed: [own, own] }, own.source.path)).toThrow();
});

test("ordinary install without explicit plugin preparation does not create a source or host installation", async () => {
  const home = mkdtempSync(join(tmpdir(), "tela-plugin-optional-"));
  try {
    const paths = resolveProductPaths({ home, environment: {} });
    writeOwnershipManifest(paths.installManifest, createOwnershipManifest("test", new Date(), "plugin-optional"));
    expect(await refreshInstalledLocalPlugin({ home, environment: {}, launcherExecutablePath: join(home, "tela") })).toBe("prepare");
    expect(readOwnershipManifestSource(paths.installManifest)).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
function readOwnershipManifestSource(path: string) {
  return JSON.parse(readFileSync(path, "utf8")).resources.some((r: any) => r.id === "local-chat-plugin-source");
}
