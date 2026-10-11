import { CHATGPT_FILE_CONNECT_ORIGINS, readChatGptFile } from "./chatgpt-file-source";
import { CHATGPT_TELA_CHAT_CAPABILITY_CALL } from "@chatgpt-tela/mcp";
export const CHATGPT_TELA_IMPORT_RESOURCE_URI = "ui://chatgpt-tela/import/v1.html";

/** File bytes stay in the card; host-only file authorization is isolated in the adapter. */
export const CHATGPT_TELA_IMPORT_WIDGET_HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; padding: 16px; color: CanvasText; background: Canvas; }
main { display: grid; gap: 12px; } h1 { font-size: 16px; margin: 0; }
p { margin: 0; opacity: .7; font-size: 13px; } label { display: grid; gap: 6px; font-size: 13px; }
input, button { font: inherit; padding: 8px; color: inherit; background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; }
button { justify-self: start; cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
#status { overflow-wrap: anywhere; }
</style></head><body><main>
<h1>Save a file to your workspace</h1><p>Choose a file up to 2 MiB. Existing files stay unchanged.</p>
<button id="chatgpt-file" hidden>Choose from ChatGPT</button>
<p id="source-note"></p><label>Or choose a file from this computer<input id="file" type="file"></label>
<label>Destination filename<input id="path" placeholder="folder/example.png" autocomplete="off"></label>
<p>Use a folder that already exists in the connected workspace.</p>
<button id="save" disabled>Save file</button><p id="status" role="status">Connecting…</p>
</main><script type="module">
const file = document.querySelector('#file'), path = document.querySelector('#path');
const save = document.querySelector('#save'), status = document.querySelector('#status');
const hostFile = document.querySelector('#chatgpt-file'), sourceNote = document.querySelector('#source-note');
const readHostFile = ${readChatGptFile.toString()};
const allowedOrigins = ${JSON.stringify(CHATGPT_FILE_CONNECT_ORIGINS)};
let workspace, maxBytes, hostSelection, busy = false, ready = false, id = 0;
const fileHostAvailable = typeof window.openai?.selectFiles === 'function' && typeof window.openai?.getFileDownloadUrl === 'function';
hostFile.hidden = !fileHostAvailable;
sourceNote.textContent = fileHostAvailable ? 'Choose an available ChatGPT file, then confirm its destination.' : 'This ChatGPT host does not provide file selection. Files already attached to the conversation cannot be imported here.';
const pending = new Map();
function request(method, params) {
  const key = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('Connection timed out. Check the destination before retrying.')); }, 20000);
    pending.set(key, { resolve, reject, timer });
    window.parent.postMessage({ jsonrpc: '2.0', id: key, method, params }, '*');
  });
}
function payload(envelope) {
  if (!envelope || typeof envelope !== 'object' || envelope.isError === true) return undefined;
  if (envelope.structuredContent && typeof envelope.structuredContent === 'object') return envelope.structuredContent;
  const text = envelope?.content?.find(item => item.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return undefined; }
}
function update() { save.disabled = !ready || busy || !workspace || (!file.files?.[0] && !hostSelection) || !path.value.trim(); hostFile.disabled = !ready || busy || !workspace; file.disabled = busy; path.disabled = busy; }
function render(envelope) {
  const result = payload(envelope);
  if (typeof result?.workspace_id !== 'string' || result.maxBytes !== 2097152 || busy) return;
  workspace = result.workspace_id; maxBytes = result.maxBytes;
  status.textContent = 'Choose a file and confirm where to save it.'; update();
}
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
  const message = event.data, waiter = pending.get(message.id);
  if (waiter) {
    clearTimeout(waiter.timer); pending.delete(message.id);
    if (message.error) waiter.reject(new Error('The connection refused this request.')); else waiter.resolve(message.result);
  } else if (message.method === 'ui/notifications/tool-result') render(message.params);
});
hostFile.addEventListener('click', async () => {
  if (hostFile.disabled) return;
  busy = true; update();
  try {
    const selected = await window.openai.selectFiles();
    if (!Array.isArray(selected) || selected.length === 0) return;
    if (selected.length !== 1 || typeof selected[0]?.fileId !== 'string' || typeof selected[0]?.fileName !== 'string') throw new Error('Select one file at a time.');
    hostSelection = selected[0]; file.value = ''; path.value = hostSelection.fileName;
    status.textContent = 'Selected: ' + hostSelection.fileName;
  } catch { status.textContent = 'File selection did not complete. Select one file again.'; }
  finally { busy = false; update(); }
});
file.addEventListener('change', () => { const chosen = file.files?.[0]; if (chosen) { hostSelection = undefined; path.value = chosen.name; } update(); });
path.addEventListener('input', update);
save.addEventListener('click', async () => {
  const chosen = file.files?.[0], selected = hostSelection; if (save.disabled || (!chosen && !selected)) return;
  const destination = path.value;
  busy = true; update(); status.textContent = 'Saving…';
  try {
    if (chosen && chosen.size > maxBytes) throw new Error('This file exceeds the 2 MiB limit.');
    const data = selected ? (await readHostFile(window.openai, selected, maxBytes, allowedOrigins)).bytes : new Uint8Array(await chosen.arrayBuffer());
    let binary = ''; for (let start = 0; start < data.length; start += 8192) binary += String.fromCharCode(...data.subarray(start, start + 8192));
    const response = await request('tools/call', { name: '${CHATGPT_TELA_CHAT_CAPABILITY_CALL}', arguments: {
      capability: 'import_file', arguments: { workspace_id: workspace, path: destination, data_base64: btoa(binary) }
    } });
    const result = payload(response);
    if (response?.isError) throw new Error(response.content?.find(item => item.type === 'text')?.text || 'File could not be saved.');
    if (result?.published !== true || result.path !== destination || result.bytes !== data.byteLength) throw new Error('Save outcome is unknown. Check the destination before retrying.');
    status.textContent = result.cleanupComplete ? 'Saved: ' + result.path : 'Saved: ' + result.path + '. Temporary file cleanup needs attention.';
    file.value = ''; path.value = ''; hostSelection = undefined;
  } catch (error) { status.textContent = error.message; }
  finally { busy = false; update(); }
});
const metadata = window.openai?.toolResponseMetadata;
render(metadata?.mcp_tool_result ?? metadata?.call_tool_result ?? { structuredContent: window.openai?.toolOutput });
try {
  await request('ui/initialize', { appInfo: { name: 'chatgpt-tela-import', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' });
  window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
  ready = true;
  if (!workspace) status.textContent = 'Waiting for the connected workspace. Open this card from Tela after opening a workspace.';
  update();
} catch { status.textContent = 'This host cannot open the file import card.'; }
</script></body></html>`;
