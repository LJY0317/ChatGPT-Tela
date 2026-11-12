import { expect, test } from "bun:test";
import { createSuppliedHistorySource } from "./supplied-history";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";

function fixture() {
  let head = "current", metadataReads = 0, closes = 0;
  let changeDuringRead = false;
  const text = "이전 기록😀".repeat(16_000);
  const rpc: CodexAppServerRpc = { async close() { closes++; }, async request(method, params) {
    const p = params as any;
    expect(p.threadId).toBe("thread");
    if (method === "thread/read") {
      metadataReads++;
      return { thread: { id: "thread", historyMode: "paginated", status: { type: "notLoaded" }, cwd: "/fixture", updatedAt: 1 } };
    }
    if (method === "thread/turns/list") return { data: [{ id: head, status: "interrupted", items: [], itemsView: "notLoaded" },
      ...(p.limit > 1 ? [{ id: "old", status: "completed", items: [], itemsView: "notLoaded" }] : [])], nextCursor: null };
    if (method === "thread/items/list") {
      if (changeDuringRead) head = "newer";
      return { data: [{ turnId: "old", item: { type: "userMessage", id: "old-item", content: [{ type: "text", text }] } }], nextCursor: null };
    }
    throw Error("Not a stored read");
  } };
  return { source: createSuppliedHistorySource(async () => rpc), text, set change(value: boolean) { changeDuringRead = value; },
    get closes() { return closes; }, get metadataReads() { return metadataReads; } };
}
const identity = { threadId: "thread", turnId: "current" };
const signal = () => new AbortController().signal;

test("stored snapshot does not require an inspector to own live Native work, and defers whole oversized exchanges", async () => {
  const f = fixture();
  const seed = await f.source.readSeed(identity, 128, signal());
  expect(JSON.parse(seed.content)).toMatchObject({ deferredHistory: { scope: "prior-native-history" }, items: [] });
  expect(seed.sourceItemCount).toBe(0);
  expect(f.closes).toBe(1);
  const index = await f.source.readPage(identity, {}, signal());
  expect(index).toMatchObject({ type: "native_history_index", data: [{ turnId: "old", status: "completed" }] });
  let text = "", selection: any = { turnId: "old" };
  for (;;) {
    const page = await f.source.readPage(identity, selection, signal());
    if (page.type !== "native_history_page") throw Error("Expected original page");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024);
    expect(page.text).not.toContain("�");
    text += page.text;
    if (!page.continuation) break;
    selection = { turnId: "old", ...Object.fromEntries(Object.entries(page.continuation).map(([k,v]) =>
      [k === "offset_bytes" ? "offsetBytes" : k === "page_digest" ? "pageDigest" : k, v])) };
  }
  expect(JSON.parse(text).data[0].item.content[0].text).toBe(f.text);
});

test("stored source refuses current-turn readback and a source that changes during acquisition", async () => {
  const f = fixture();
  await expect(f.source.readPage(identity, { turnId: "current" }, signal())).rejects.toThrow("current");
  f.change = true;
  await expect(f.source.readSeed(identity, 256, signal())).rejects.toMatchObject({ code: "native_history_bootstrap_required", recoveryReason: "source_unavailable" });
  expect(f.closes).toBe(1);
});
