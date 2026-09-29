export const CHATGPT_TELA_REVIEW_RESOURCE_URI = "ui://chatgpt-tela/review/v1.html";
export const CHATGPT_TELA_REVIEW_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Self-contained MCP Apps review surface. It intentionally has no network access and treats every tool result
 * as untrusted data. All workspace paths and patch text are rendered through textContent, never HTML injection.
 */
export const CHATGPT_TELA_REVIEW_WIDGET_HTML = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; color: CanvasText; background: Canvas; }
    main { display: grid; gap: 10px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    h1 { margin: 0; font-size: 15px; font-weight: 650; }
    #scope { opacity: .65; font-size: 12px; white-space: nowrap; }
    #summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .metric { border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 8px 10px; }
    .metric strong { display: block; font-size: 15px; }
    .metric span { display: block; opacity: .62; font-size: 11px; margin-top: 2px; }
    #notice { display: none; font-size: 12px; opacity: .72; }
    #files { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
    #files li { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    #files .path { overflow-wrap: anywhere; }
    #files .stat { white-space: nowrap; opacity: .68; }
    details { border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent); padding-top: 8px; }
    summary { cursor: pointer; font-size: 12px; font-weight: 600; }
    pre { max-height: 360px; overflow: auto; white-space: pre; tab-size: 2; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 8px 0 0; padding: 9px; border-radius: 7px; background: color-mix(in srgb, CanvasText 6%, Canvas); }
    #empty { display: none; font-size: 12px; opacity: .68; }
  </style>
</head>
<body>
  <main>
    <header><h1>Tela Chat review</h1><span id="scope">Review</span></header>
    <section id="summary">
      <div class="metric"><strong id="files-count">0</strong><span>Files</span></div>
      <div class="metric"><strong id="additions-count">+0</strong><span>Additions</span></div>
      <div class="metric"><strong id="removals-count">-0</strong><span>Removals</span></div>
    </section>
    <div id="notice"></div>
    <ul id="files"></ul>
    <div id="empty">No changes in this review.</div>
    <details id="patch-section"><summary>Patch</summary><pre id="patch"></pre></details>
  </main>
  <script type="module">
    const filesCount = document.querySelector("#files-count");
    const additionsCount = document.querySelector("#additions-count");
    const removalsCount = document.querySelector("#removals-count");
    const scope = document.querySelector("#scope");
    const notice = document.querySelector("#notice");
    const files = document.querySelector("#files");
    const empty = document.querySelector("#empty");
    const patchSection = document.querySelector("#patch-section");
    const patch = document.querySelector("#patch");

    function toolPayload(envelope) {
      if (!envelope || typeof envelope !== "object") return undefined;
      const items = Array.isArray(envelope.content) ? envelope.content : [];
      const text = items.find((item) => item && item.type === "text" && typeof item.text === "string")?.text;
      if (typeof text !== "string") return undefined;
      try { return JSON.parse(text); } catch { return undefined; }
    }

    function render(envelope) {
      const result = toolPayload(envelope);
      if (!result || typeof result !== "object") return;
      const delta = result.reviewDelta?.available === true ? result.reviewDelta : undefined;
      const summary = delta?.summary ?? result.summary;
      if (!summary || typeof summary !== "object") return;
      filesCount.textContent = String(Number.isFinite(summary.files) ? summary.files : 0);
      additionsCount.textContent = "+" + String(Number.isFinite(summary.additions) ? summary.additions : 0);
      removalsCount.textContent = "-" + String(Number.isFinite(summary.removals) ? summary.removals : 0);
      scope.textContent = delta?.since === "workspace_open" ? "Since workspace open" : delta ? "Since last review" : "Current workspace";
      notice.style.display = summary.complete === false ? "block" : "none";
      notice.textContent = summary.complete === false ? "Line counts are partial because this review includes binary or uncaptured content." : "";
      files.replaceChildren();
      const rows = Array.isArray(delta?.files) ? delta.files : [];
      for (const row of rows) {
        if (!row || typeof row.path !== "string") continue;
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.className = "path";
        name.textContent = row.path;
        const stat = document.createElement("span");
        stat.className = "stat";
        stat.textContent = row.binary === true ? "binary" : "+" + String(row.additions ?? 0) + " -" + String(row.removals ?? 0);
        li.append(name, stat);
        files.appendChild(li);
      }
      const patchText = typeof delta?.patch === "string" ? delta.patch : typeof result.patch === "string" ? result.patch : "";
      patch.textContent = patchText;
      const noChanges = Number(summary.files ?? 0) === 0 && patchText.length === 0;
      empty.style.display = noChanges ? "block" : "none";
      patchSection.style.display = patchText ? "block" : "none";
    }

    let rpcId = 0;
    const pending = new Map();
    function request(method, params) {
      const id = ++rpcId;
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    }
    function notify(method, params) {
      window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
    }
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.id !== undefined && pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(message.error); else waiter.resolve(message.result);
        return;
      }
      if (message.method === "ui/notifications/tool-result") render(message.params);
    }, { passive: true });

    const metadata = window.openai?.toolResponseMetadata;
    render(metadata?.mcp_tool_result ?? metadata?.call_tool_result ?? metadata);
    try {
      await request("ui/initialize", {
        appInfo: { name: "chatgpt-tela-review", version: "1.0.0" },
        appCapabilities: {},
        protocolVersion: "2026-01-26",
      });
      notify("ui/notifications/initialized", {});
    } catch (error) {
      console.error("Tela review UI bridge initialization failed", error);
    }
  </script>
</body>
</html>`;
