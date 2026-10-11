import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { CHATGPT_TELA_REVIEW_WIDGET_HTML } from "./review-widget";

class Element {
  textContent = "";
  value = "";
  className = "";
  hidden = false;
  style: Record<string, string> = {};
  children: Element[] = [];
  listeners: Record<string, () => void> = {};
  append(...items: Element[]) { this.children.push(...items); }
  appendChild(item: Element) { this.children.push(item); }
  replaceChildren() { this.children = []; }
  addEventListener(name: string, callback: () => void) { this.listeners[name] = callback; }
  set innerHTML(_: string) { throw new Error("Unsafe HTML rendering"); }
}
function card(initial: unknown, options: { synchronous?: boolean } = {}) {
  const elements = new Map<string, Element>();
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  let listener: (event: unknown) => void = () => {};
  let expire: (() => void) | undefined;
  const sent: any[] = [];
  let cleared = false;
  const parent = { postMessage(message: any) {
    sent.push(message);
    if (options.synchronous && message.id) listener({ source: parent, data: { jsonrpc: "2.0", id: message.id, result: {} } });
  } };
  const script = CHATGPT_TELA_REVIEW_WIDGET_HTML.match(/<script type="module">([\s\S]*?)<\/script>/)![1]!;
  const done: Promise<void> = runInNewContext("(async () => {" + script + "})()", {
    document: { querySelector: el, createElement: () => new Element() },
    window: { parent, openai: initial, addEventListener(_: string, cb: typeof listener) { listener = cb; } },
    setTimeout(cb: () => void) { expire = cb; return 1; }, clearTimeout() { cleared = true; },
  });
  return { el, sent, done, get cleared() { return cleared; }, expire() { expire!(); },
    result(value: unknown, source: unknown = parent) { listener({ source, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: value } }); } };
}
const summary = { files: 1, additions: 2, removals: 1, complete: true };

test("renders canonical metadata, filters literal untrusted paths, accepts structured updates", async () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const c = card({ toolResponseMetadata: { mcp_tool_result: { content: [{ type: "text", text: JSON.stringify({ reviewDelta: { available: true, since: "last_shown", files: [{ path: malicious, additions: 2, removals: 1 }], summary, patch: malicious } }) }] } } }, { synchronous: true });
  await c.done;
  expect(c.cleared).toBe(true);
  expect(c.sent.at(-1).method).toBe("ui/notifications/initialized");
  expect(c.el("#files").children[0]!.children[0]!.textContent).toBe(malicious);
  expect(c.el("#patch").textContent).toBe(malicious);
  c.el("#filter").value = "missing"; c.el("#filter").listeners.input!();
  expect(c.el("#files").children).toHaveLength(0);
  c.result({ structuredContent: { summary, patch: "updated" } }, {});
  expect(c.el("#patch").textContent).toBe(malicious);
  c.result({ structuredContent: { summary, patch: "updated" } });
  expect(c.el("#patch").textContent).toBe("updated");
});

test("saved reviews expose captured status and new content without binary/base64 expansion", async () => {
  const c = card({ toolOutput: { historical: true, summary, status: '?? "file name"', patch: "", untracked: [{ path: "file name", encoding: "utf8", content: "<script>literal</script>" }, { path: "data", encoding: "base64", content: "secretbase64", size: 3 }] } }, { synchronous: true });
  await c.done;
  expect(c.el("#scope").textContent).toBe("Saved review");
  expect(c.el("#status").textContent).toBe('?? "file name"');
  expect(c.el("#status-section").hidden).toBe(false);
  expect(c.el("#untracked").children[0]!.children[1]!.textContent).toBe("<script>literal</script>");
  expect(c.el("#untracked").children[1]!.children[1]!.textContent).toBe("Binary file · 3 bytes");
});

test("partial comparisons never claim empty; failed results clear previous review", async () => {
  const c = card({ toolOutput: { summary: { ...summary, files: 0, complete: false }, reviewDelta: { available: false, reason: "private path" } } });
  expect(c.el("#notice").textContent).toContain("Comparison unavailable");
  expect(c.el("#notice").textContent).not.toContain("private path");
  expect(c.el("#empty").style.display).toBe("none");
  c.result({ isError: true, structuredContent: { summary }, content: [{ type: "text", text: "private error" }] });
  expect(c.el("#files-count").textContent).toBe("—");
  expect(c.el("#notice").textContent).toContain("could not be loaded");
  c.expire(); await c.done;
  expect(c.el("#notice").textContent).toContain("could not be loaded");
});

test("bridge timeout finishes without logging payloads or hiding an already captured review", async () => {
  const waiting = card({}); waiting.expire(); await waiting.done;
  expect(waiting.el("#notice").textContent).toContain("Waiting for a review");
  const captured = card({ toolOutput: { summary, patch: "captured" } });
  captured.expire(); await captured.done;
  expect(captured.el("#patch").textContent).toBe("captured");
  expect(captured.el("#notice").style.display).toBe("none");
});
