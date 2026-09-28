import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";

export const CHATGPT_TELA_PLUGIN_VERSION = "0.3.0";

const APP_ID = /^(?:plugin_asdk_app_|asdk_app_|connector_|templated_apps_)[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SKILL_URL = new URL("../../../integrations/chatgpt-plugin/skills/chatgpt-tela/SKILL.md", import.meta.url);

export function validateChatGptAppId(value: string): string {
  const id = value.trim();
  if (!APP_ID.test(id)) {
    throw new Error(
      "ChatGPT app id must be the exact technical id copied from the registered app (plugin_asdk_app_, asdk_app_, connector_, or templated_apps_ prefix)",
    );
  }
  return id;
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function interfaceMetadata() {
  return {
    displayName: "ChatGPT Tela",
    shortDescription: "Local workspace tools and exact-turn ChatGPT Web delegation",
    longDescription:
      "Use one ChatGPT Tela integration for local project work in ChatGPT and exact active-turn ChatGPT Web delegation in Work/Codex.",
    developerName: "LJY0317",
    category: "developer-tools",
    capabilities: ["Read", "Write"],
    websiteURL: "https://github.com/LJY0317/ChatGPT-Tela",
    defaultPrompt: [
      "Use ChatGPT Tela to inspect and work on my local project.",
      "Use ChatGPT Tela in this Codex task when the active Native turn needs ChatGPT Web delegation.",
    ],
  };
}

export function chatGptTelaPluginFiles(appIdInput: string): ReadonlyMap<string, Buffer> {
  const appId = validateChatGptAppId(appIdInput);
  const description =
    "One ChatGPT Tela plugin for local workspace work in ChatGPT and exact active-turn ChatGPT Web delegation in Work/Codex.";
  const author = {
    name: "LJY0317",
    email: "221252045+LJY0317@users.noreply.github.com",
  };
  const interface_ = interfaceMetadata();
  return new Map([
    ["plugin.json", json({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "chatgpt-tela",
      version: CHATGPT_TELA_PLUGIN_VERSION,
      description,
      author,
      repository: "https://github.com/LJY0317/ChatGPT-Tela",
      license: "MIT",
      keywords: ["chatgpt", "tela", "codex", "mcp", "developer-tools"],
      extensions: {
        "com.openai": {
          apps: "./.app.json",
          interface: interface_,
        },
      },
    })],
    [".codex-plugin/plugin.json", json({
      name: "chatgpt-tela",
      version: CHATGPT_TELA_PLUGIN_VERSION,
      description,
      author,
      repository: "https://github.com/LJY0317/ChatGPT-Tela",
      license: "MIT",
      keywords: ["chatgpt", "tela", "codex", "mcp", "developer-tools"],
      apps: "./.app.json",
      skills: "./skills/",
      interface: interface_,
    })],
    [".app.json", json({
      apps: {
        "chatgpt-tela": {
          id: appId,
          required: true,
        },
      },
    })],
    ["skills/chatgpt-tela/SKILL.md", Buffer.from(readFileSync(SKILL_URL, "utf8"), "utf8")],
  ]);
}

function octal(value: number, width: number): Buffer {
  const text = value.toString(8).padStart(width - 1, "0");
  if (text.length >= width) throw new Error("tar header value exceeds field width");
  return Buffer.from(`${text}\0`, "ascii");
}

function tarHeader(path: string, size: number): Buffer {
  const name = Buffer.from(path, "utf8");
  if (name.length > 100) throw new Error(`plugin archive path exceeds ustar name limit: ${path}`);
  const header = Buffer.alloc(512, 0);
  name.copy(header, 0);
  octal(0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  Buffer.from("        ", "ascii").copy(header, 148);
  header[156] = "0".charCodeAt(0);
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  Buffer.from("chatgpt-tela", "ascii").copy(header, 265);
  Buffer.from("chatgpt-tela", "ascii").copy(header, 297);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  Buffer.from(`${checksumText}\0 `, "ascii").copy(header, 148);
  return header;
}

export function createPluginTar(files: ReadonlyMap<string, Buffer>): Buffer {
  const chunks: Buffer[] = [];
  for (const [path, content] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    chunks.push(tarHeader(path, content.length), content);
    const remainder = content.length % 512;
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

export function createPluginTarGz(appId: string): Buffer {
  return gzipSync(createPluginTar(chatGptTelaPluginFiles(appId)), { level: 9 });
}

export function writeChatGptTelaPluginArchive(input: {
  readonly appId: string;
  readonly outputPath: string;
}): string {
  const outputPath = resolve(input.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, createPluginTarGz(input.appId));
  return outputPath;
}
