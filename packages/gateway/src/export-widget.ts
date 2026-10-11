export const CHATGPT_TELA_EXPORT_RESOURCE_URI = "ui://chatgpt-tela/export/v1.html";
export const CHATGPT_TELA_EXPORT_WIDGET_HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme:light dark; font-family:system-ui,sans-serif; }
body { margin:0; padding:16px; background:Canvas; color:CanvasText; }
h1 { font-size:16px; margin:0 0 12px; overflow-wrap:anywhere; }
p { font-size:13px; opacity:.7; } button { font:inherit; padding:8px 14px; cursor:pointer; }
</style></head><body><h1 id="name">Download a workspace file</h1><p id="status">Waiting for a file.</p><button id="download" disabled>Download file</button>
<script type="module">
const name = document.querySelector("#name"), status = document.querySelector("#status"), button = document.querySelector("#download");
let file, url, generation = 0, initialized = false, timer;
function clear() {
  file = undefined; button.disabled = true;
  if (url) URL.revokeObjectURL(url);
  url = undefined;
}
async function render(envelope) {
  const current = ++generation;
  clear();
  name.textContent = "Download a workspace file";
  status.textContent = "Preparing file…";
  try {
    const data = envelope?.isError === true ? undefined : envelope?._meta?.["tela/fileExport"];
    if (!data || typeof data.name !== "string" || !data.name || /[\u0000-\u001f\u007f/\\]/.test(data.name)
      || !Number.isSafeInteger(data.bytes) || data.bytes < 0 || data.bytes > 2 * 1024 * 1024
      || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)
      || typeof data.dataBase64 !== "string" || data.dataBase64.length > 4 * Math.ceil(2 * 1024 * 1024 / 3)) throw new Error();
    const binary = atob(data.dataBase64);
    if (binary.length !== data.bytes || btoa(binary) !== data.dataBase64) throw new Error();
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    if (Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") !== data.sha256) throw new Error();
    if (current !== generation) return;
    file = { name: data.name, bytes };
    name.textContent = data.name;
    status.textContent = data.bytes.toLocaleString() + " bytes · captured from your workspace. Later edits do not change this download.";
    button.disabled = false;
  } catch {
    if (current === generation) status.textContent = "File unavailable. Ask Tela to prepare the download again.";
  }
}
button.addEventListener("click", () => {
  if (!file) return;
  try {
    if (!url) url = URL.createObjectURL(new Blob([file.bytes], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url; link.download = file.name; document.body.appendChild(link); link.click(); link.remove();
    status.textContent = "If the download did not start, your host may block downloads from this card.";
  } catch { status.textContent = "This host could not start the download. Your workspace file is unchanged."; }
});
window.addEventListener("pagehide", () => { ++generation; clear(); clearTimeout(timer); });
window.addEventListener("message", event => {
  if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
  const message = event.data;
  if (message.method === "ui/notifications/tool-result") void render(message.params);
  if (message.id === 1 && !initialized) {
    initialized = true; clearTimeout(timer);
    if (!message.error) window.parent.postMessage({ jsonrpc:"2.0", method:"ui/notifications/initialized", params:{} }, "*");
  }
});
const metadata = window.openai?.toolResponseMetadata;
const initial = metadata?.mcp_tool_result ?? metadata?.call_tool_result;
if (initial) void render(initial);
timer = setTimeout(() => {
  if (!generation) status.textContent = "Waiting for a file. Ask Tela to prepare the download again.";
}, 10000);
window.parent.postMessage({ jsonrpc:"2.0", id:1, method:"ui/initialize", params:{ appInfo:{ name:"chatgpt-tela-export", version:"1.0.0" }, appCapabilities:{}, protocolVersion:"2026-01-26" } }, "*");
</script></body></html>`;
