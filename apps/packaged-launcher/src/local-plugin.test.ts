import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookActivation, ownedInstalledPlugin, refreshInstalledLocalPlugin } from "./local-plugin";
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

test("only the exact enabled, approved hook is ready; discovery and installation never imply approval", () => {
  const hook = { pluginId: "actual-id", source: "plugin", eventName: "postToolUse", handlerType: "command",
    command: "owned-command", async: true, matcher: "close_agent$", enabled: true, trustStatus: "trusted" };
  const state = (change: object) => hookActivation({ data: [{ hooks: [{ ...hook, ...change }] }] }, "actual-id", "owned-command");
  expect(state({})).toBe("ready");
  expect(state({ trustStatus: "untrusted" })).toBe("review");
  expect(state({ trustStatus: "modified" })).toBe("review");
  expect(state({ enabled: false })).toBe("disabled");
  expect(state({ command: "another-command" })).toBe("unavailable");
  expect(state({ pluginId: "another-plugin" })).toBe("unavailable");
  expect(state({ trustStatus: "unknown" })).toBe("unavailable");
  expect(hookActivation({ data: [] }, "actual-id", "owned-command")).toBe("unavailable");
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
