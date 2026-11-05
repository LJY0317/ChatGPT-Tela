// Isolate a filesystem failure injection from other test modules.
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalRename = fs.renameSync;
const originalRmdir = fs.rmdirSync;
const originalRemove = fs.rmSync;
const home = fs.mkdtempSync(join(tmpdir(), "tela-plugin-rollback-"));
const root = join(home, "owned");
const launcher = join(home, "tela");
const oldMcp = join(root, "plugins", "tela-local-chat", "mcp.json");
const newMcp = join(root, "plugins", "tela-local-chat", ".mcp.json");
const manifestDir = join(root, "plugins", "tela-local-chat", ".codex-plugin");
const moveFailure = new Error("second move failed");
const cleanupFailure = new Error("rollback cleanup failed");
let injectFailure = false;

mock.module("node:fs", () => ({
  ...fs,
  renameSync(from: string, to: string) {
    if (injectFailure && from === oldMcp && to === newMcp) throw moveFailure;
    return originalRename(from, to);
  },
  rmdirSync(path: string) {
    if (injectFailure && path === manifestDir) throw cleanupFailure;
    return originalRmdir(path);
  }
}));

try {
  const { prepareLocalChatPlugin, normalizeOwnedLocalChatPlugin } = await import("../plugin-package");
  const plugin = prepareLocalChatPlugin(root, launcher).plugin;
  const oldManifest = join(plugin, "plugin.json");
  originalRename(join(plugin, ".codex-plugin", "plugin.json"), oldManifest);
  originalRmdir(manifestDir);
  originalRename(newMcp, oldMcp);
  const value = JSON.parse(fs.readFileSync(oldManifest, "utf8"));
  value.version = "0.0.1";
  fs.writeFileSync(oldManifest, JSON.stringify(value, null, 2) + "\n");

  injectFailure = true;
  let failure: unknown;
  try { normalizeOwnedLocalChatPlugin(root, launcher); } catch (error) { failure = error; }
  assert.ok(failure instanceof AggregateError, "a rollback failure must preserve both exceptions");
  assert.equal(failure.errors[0], moveFailure);
  assert.equal(failure.errors[1], cleanupFailure);
  assert.equal(fs.existsSync(oldManifest), true, "the first file was restored");
  assert.equal(fs.existsSync(oldMcp), true, "the second file was not moved");
  assert.equal(fs.existsSync(manifestDir), true, "cleanup failure remains visible");
} finally {
  originalRemove(home, { recursive: true, force: true });
}
