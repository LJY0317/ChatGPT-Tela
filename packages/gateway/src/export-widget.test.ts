import { expect, test } from "bun:test";
import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { CHATGPT_TELA_EXPORT_WIDGET_HTML } from "./export-widget";

class Element {
  textContent = ""; disabled = true; href = ""; download = "";
  listeners: Record<string, () => void> = {};
  appendChild(_: Element) {} remove() {} click() {}
  addEventListener(name: string, callback: () => void) { this.listeners[name] = callback; }
  set innerHTML(_: string) { throw new Error("HTML injection"); }
}
const bytes = Buffer.from([0, 255, 128, 10]);
const file = { name: "output.bin", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), dataBase64: bytes.toString("base64") };
function card(initial?: unknown) {
  const elements = new Map<string, Element>(); const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const listeners: Record<string, (event: any) => void> = {};
  const hashes: Promise<ArrayBuffer>[] = [];
  const blobs: Blob[] = [], revoked: string[] = [], downloads: string[] = [];
  const parent = { postMessage() {} };
  runInNewContext(CHATGPT_TELA_EXPORT_WIDGET_HTML.match(/<script type="module">([\s\S]*?)<\/script>/)![1]!, {
    document: { querySelector: el, body: new Element(), createElement: () => { const link = new Element(); link.click = () => downloads.push(link.download); return link; } },
    window: { parent, openai: { toolResponseMetadata: initial }, addEventListener(name: string, callback: (event: any) => void) { listeners[name] = callback; } },
    URL: { createObjectURL(blob: Blob) { blobs.push(blob); return "blob:fixture"; }, revokeObjectURL(url: string) { revoked.push(url); } },
    Blob, Uint8Array, atob, btoa,
    crypto: { subtle: { digest(algorithm: string, data: Uint8Array) { const promise = webcrypto.subtle.digest(algorithm, data); hashes.push(promise); return promise; } } },
    setTimeout() { return 1; }, clearTimeout() {},
  });
  return { el, blobs, revoked, downloads,
    result(value: unknown, source: unknown = parent) { listeners.message!({ source, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: value } }); },
    async settle() { await Promise.all(hashes); await Promise.resolve(); },
    pagehide() { listeners.pagehide!({}); },
  };
}
const envelope = (data: unknown) => ({ _meta: { "tela/fileExport": data } });

test("card receives private bytes, verifies hash, and downloads only on click without rendering content", async () => {
  const c = card({ mcp_tool_result: envelope(file) }); await c.settle();
  expect(c.el("#download").disabled).toBe(false);
  expect(c.blobs).toHaveLength(0);
  c.el("#download").listeners.click!();
  expect(c.downloads).toEqual(["output.bin"]);
  expect(c.blobs[0]!.type).toBe("application/octet-stream");
  expect(Buffer.from(await c.blobs[0]!.arrayBuffer())).toEqual(bytes);
  c.el("#download").listeners.click!(); expect(c.blobs).toHaveLength(1);
  c.pagehide(); expect(c.revoked).toEqual(["blob:fixture"]);
  expect(c.el("#download").disabled).toBe(true);
});

test("failed/mismatched results disable stale downloads and reject foreign messages", async () => {
  const c = card({ call_tool_result: envelope(file) }); await c.settle();
  c.result({ isError: true }, {}); expect(c.el("#download").disabled).toBe(false);
  c.el("#download").listeners.click!();
  c.result({ isError: true, _meta: { "tela/fileExport": file } }); await c.settle();
  expect(c.el("#download").disabled).toBe(true); expect(c.revoked).toHaveLength(1);
  for (const invalid of [{ ...file, sha256: "0".repeat(64) }, { ...file, bytes: 5 }, { ...file, dataBase64: "%%%" }, { ...file, name: "../outside" }, { ...file, bytes: 2 * 1024 * 1024 + 1 }]) {
    c.result(envelope(invalid)); await c.settle();
    expect(c.el("#download").disabled).toBe(true);
    expect(c.el("#status").textContent).toContain("File unavailable");
  }
});

test("late integrity verification cannot restore an older file after a newer error", async () => {
  const c = card(); c.result(envelope(file)); c.result({ isError: true }); await c.settle();
  expect(c.el("#download").disabled).toBe(true);
  expect(c.el("#status").textContent).toContain("File unavailable");
});
