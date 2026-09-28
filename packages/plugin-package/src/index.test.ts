import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
  chatGptTelaPluginFiles,
  createPluginTarGz,
  validateChatGptAppId,
} from "./index";

function tarEntries(archive: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(archive);
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const start = offset + 512;
    entries.set(name, Buffer.from(tar.subarray(start, start + size)));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe("ChatGPT Tela plugin packaging", () => {
  test("references one existing app and never bundles an MCP URL", () => {
    const appId = "plugin_asdk_app_6a4c0062f3b88191855c0a80eac5d53d";
    const files = chatGptTelaPluginFiles(appId);
    expect([...files.keys()].sort()).toEqual([
      ".app.json",
      ".codex-plugin/plugin.json",
      "plugin.json",
      "skills/chatgpt-tela/SKILL.md",
    ].sort());
    expect(files.has("mcp.json")).toBe(false);
    expect(files.has(".mcp.json")).toBe(false);

    const app = JSON.parse(files.get(".app.json")!.toString("utf8"));
    expect(app).toEqual({
      apps: {
        "chatgpt-tela": {
          id: appId,
          required: true,
        },
      },
    });
    const portable = JSON.parse(files.get("plugin.json")!.toString("utf8"));
    expect(portable.extensions["com.openai"].apps).toBe("./.app.json");
    const compatibility = JSON.parse(files.get(".codex-plugin/plugin.json")!.toString("utf8"));
    expect(compatibility.apps).toBe("./.app.json");
    expect(compatibility.skills).toBe("./skills/");
    expect(files.get("skills/chatgpt-tela/SKILL.md")!.toString("utf8"))
      .toContain("Do not invoke Tela for ordinary conversation");
  });

  test("emits a portable tar.gz with only the expected files", () => {
    const archive = createPluginTarGz("asdk_app_A1b2c3");
    const entries = tarEntries(archive);
    expect([...entries.keys()].sort()).toEqual([
      ".app.json",
      ".codex-plugin/plugin.json",
      "plugin.json",
      "skills/chatgpt-tela/SKILL.md",
    ].sort());
    expect(entries.get("plugin.json")!.toString("utf8")).toContain('"displayName": "ChatGPT Tela"');
    const flattened = [...entries.values()].map(value => value.toString("utf8")).join("\n");
    expect(flattened).not.toContain("mcpServers");
    expect(flattened).not.toContain("streamable-http");
    expect(flattened).not.toContain("taile");
    expect(flattened).not.toContain("Bearer ");
  });

  test("keeps accepted app ids opaque and rejects other strings", () => {
    for (const id of [
      "plugin_asdk_app_Abc123",
      "asdk_app_Abc123",
      "connector_Abc123",
      "templated_apps_Abc123",
    ]) {
      expect(validateChatGptAppId(id)).toBe(id);
    }
    expect(() => validateChatGptAppId("https://example.com/mcp")).toThrow("technical id");
    expect(() => validateChatGptAppId("plugin_asdk_app_")).toThrow("technical id");
  });
});
