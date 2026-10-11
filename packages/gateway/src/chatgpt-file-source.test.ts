import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CHATGPT_FILE_CONNECT_ORIGINS, readChatGptFile } from "./chatgpt-file-source";
import { CHATGPT_TELA_IMPORT_WIDGET_HTML } from "./import-widget";

const selected = { fileId: "opaque-fixture", fileName: "image.bin" };
const host = { async getFileDownloadUrl() { return { downloadUrl: "https://files.oaiusercontent.com/file?private=fixture" }; } };

test("card's serialized adapter transfers binary without exporting a signed URL", async () => {
  const browserAdapter = runInNewContext(`(${readChatGptFile.toString()})`, {
    URL, AbortController, setTimeout, clearTimeout, Uint8Array,
  }) as typeof readChatGptFile;
  let requested: RequestInit | undefined;
  const bytes = new Uint8Array([0, 255, 128]);
  const result = await browserAdapter(host, selected, 3, CHATGPT_FILE_CONNECT_ORIGINS,
    (async (_url, options) => { requested = options; return new Response(bytes); }));
  expect(Array.from(result.bytes)).toEqual([0, 255, 128]);
  expect(result.name).toBe("image.bin");
  expect(requested).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
  expect(Object.keys(result).sort()).toEqual(["bytes", "name"]);
  expect(CHATGPT_TELA_IMPORT_WIDGET_HTML).toContain("window.openai.selectFiles()");
});

test("unrecognized origins and credentials are refused before network access", async () => {
  let calls = 0;
  for (const downloadUrl of ["https://files.oaiusercontent.com.evil.test/a", "http://files.oaiusercontent.com/a",
    "https://user:secret@files.oaiusercontent.com/a", "https://files.oaiusercontent.com:444/a",
    "https://files.oaiusercontent.com/a#fragment", "https://127.0.0.1/a"]) {
    await expect(readChatGptFile({ async getFileDownloadUrl() { return { downloadUrl }; } }, selected,
      3, CHATGPT_FILE_CONNECT_ORIGINS, (async () => { calls++; return new Response(); }))).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test("streaming enforces byte budget without trusting missing or false length", async () => {
  for (const headers of [{}, { "content-length": "1" }, { "content-length": "4" }]) {
    await expect(readChatGptFile(host, selected, 3, CHATGPT_FILE_CONNECT_ORIGINS,
      (async () => new Response(new Uint8Array(4), { headers })))).rejects.toThrow("limit");
  }
  const empty = await readChatGptFile(host, selected, 3, CHATGPT_FILE_CONNECT_ORIGINS,
    (async () => new Response(new Uint8Array())));
  expect(empty.bytes.byteLength).toBe(0);
});

test("network and host failures do not expose URLs or raw error payloads", async () => {
  const secret = "https://files.oaiusercontent.com/file?private=secret";
  await expect(readChatGptFile(host, selected, 3, CHATGPT_FILE_CONNECT_ORIGINS,
    (async () => { throw new Error(secret); }))).rejects.toThrow("Select the file again");
  await expect(readChatGptFile({ async getFileDownloadUrl() { throw new Error(secret); } }, selected,
    3, CHATGPT_FILE_CONNECT_ORIGINS)).rejects.toThrow("Select the file again");
});

async function cardFixture(html = CHATGPT_TELA_IMPORT_WIDGET_HTML, options: {
  initial?: "metadata" | "structured" | "error";
  files?: unknown[];
  saveResult?: Record<string, unknown>;
} = {}) {
  const elements = new Map<string, { value: string; disabled: boolean; hidden: boolean; textContent: string;
    files: unknown[]; events: Record<string, () => Promise<void>>; addEventListener(event: string, fn: () => Promise<void>): void }>();
  for (const id of ["file", "path", "save", "status", "chatgpt-file", "source-note"]) {
    elements.set(`#${id}`, { value: "", disabled: true, hidden: false, textContent: "", files: [], events: {},
      addEventListener(event, fn) { this.events[event] = fn; } });
  }
  let receive: (event: unknown) => void = () => {};
  const calls: unknown[] = [];
  const parent = { postMessage(message: { method: string; id: number; params: unknown }) {
    if (message.method === "ui/notifications/initialized") return;
    if (message.method === "tools/call") calls.push(message.params);
    const result = message.method === "tools/call"
      ? { content: [{ type: "text", text: JSON.stringify(options.saveResult ?? { published: true, cleanupComplete: true, path: "image.bin", bytes: 2 }) }] } : {};
    queueMicrotask(() => receive({ source: parent, data: { jsonrpc: "2.0", id: message.id, result } }));
  } };
  const window = { parent, addEventListener(_event: string, fn: typeof receive) { receive = fn; }, openai: {
    ...host, async selectFiles() { return options.files ?? [selected]; },
    toolOutput: options.initial === "structured" ? { workspace_id: "fixture", maxBytes: 2097152 } : undefined,
    toolResponseMetadata: options.initial === "structured" ? undefined : { mcp_tool_result: {
      isError: options.initial === "error",
      content: [{ type: "text", text: JSON.stringify({ workspace_id: "fixture", maxBytes: 2097152 }) }],
    } },
  } };
  const script = html.split('<script type="module">')[1]!.split("</script>")[0];
  await runInNewContext(`(async () => { ${script} })()`, {
    window, document: { querySelector(id: string) { return elements.get(id); } },
    URL, AbortController, Uint8Array, setTimeout, clearTimeout, btoa,
    fetch: async () => new Response(new Uint8Array([0, 255])),
  });
  return { elements, calls };
}

test("card selects host file, then sends bytes only after explicit Save", async () => {
  const { elements, calls } = await cardFixture();
  await elements.get("#chatgpt-file")!.events.click!();
  expect(calls).toEqual([]);
  expect(elements.get("#save")!.disabled).toBe(false);
  await elements.get("#save")!.events.click!();
  expect(calls).toMatchObject([{ arguments: { capability: "import_file", arguments: {
    workspace_id: "fixture", path: "image.bin", data_base64: "AP8=",
  } } }]);
  expect(JSON.stringify(calls)).not.toContain("downloadUrl");
  expect(elements.get("#status")!.textContent).toBe("Saved: image.bin");
});

test("initial structured results work; errors and cancelled selections do not enable Save", async () => {
  const structured = await cardFixture(CHATGPT_TELA_IMPORT_WIDGET_HTML, { initial: "structured" });
  await structured.elements.get("#chatgpt-file")!.events.click!();
  expect(structured.elements.get("#save")!.disabled).toBe(false);
  const cancelled = await cardFixture(CHATGPT_TELA_IMPORT_WIDGET_HTML, { files: [] });
  await cancelled.elements.get("#chatgpt-file")!.events.click!();
  expect(cancelled.elements.get("#save")!.disabled).toBe(true);
  expect(cancelled.calls).toEqual([]);
  const failed = await cardFixture(CHATGPT_TELA_IMPORT_WIDGET_HTML, { initial: "error" });
  expect(failed.elements.get("#chatgpt-file")!.disabled).toBe(true);
  expect(failed.elements.get("#save")!.disabled).toBe(true);
});

test("unproven or mismatched Save receipt never reports success", async () => {
  const card = await cardFixture(CHATGPT_TELA_IMPORT_WIDGET_HTML, { saveResult: {
    published: true, cleanupComplete: true, path: "other.bin", bytes: 2,
  } });
  await card.elements.get("#chatgpt-file")!.events.click!();
  await card.elements.get("#save")!.events.click!();
  expect(card.elements.get("#status")!.textContent).toContain("outcome is unknown");
  expect(card.calls).toHaveLength(1);
});

test("packaged compilation preserves executable card adapter without hidden bundle bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-card-build-"));
  try {
    const source = fileURLToPath(new URL("./import-widget.ts", import.meta.url));
    const entry = join(root, "entry.ts"), binary = join(root, process.platform === "win32" ? "card.exe" : "card");
    writeFileSync(entry, `import { CHATGPT_TELA_IMPORT_WIDGET_HTML } from ${JSON.stringify(source)};\nprocess.stdout.write(CHATGPT_TELA_IMPORT_WIDGET_HTML);\n`);
    const build = spawnSync(process.execPath, ["build", entry, "--compile", `--outfile=${binary}`], { encoding: "utf8", timeout: 30000 });
    expect(build.status).toBe(0);
    if (process.platform === "darwin") {
      const sign = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", binary], { encoding: "utf8", timeout: 10000 });
      expect(sign.status).toBe(0);
    }
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 5000 });
    expect(run.error).toBeUndefined();
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    const card = await cardFixture(run.stdout);
    await card.elements.get("#chatgpt-file")!.events.click!();
    await card.elements.get("#save")!.events.click!();
    expect(card.elements.get("#status")!.textContent).toBe("Saved: image.bin");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 45000);
