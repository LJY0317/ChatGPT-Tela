import { BROWSER_PAGE_AUTOMATION } from "./page-automation";
import { BROWSER_READ_ONLY_PREVIEW, type BrowserSurfaceLease } from "./index";
import { configuredDiagnosticRoot, diagnosticContext, diagnosticFingerprint, emitDiagnosticEvent, privateDiagnosticCaptureEnabled, writeDiagnosticIncident, structuralDiagnosticEvent, writePrivateDiagnosticArtifact } from "@chatgpt-tela/core";

const recent = new Map<string,number>();
/** Diagnostic-only DOM structure. No screenshot/HTML is requested without explicit private capture. */
export const DIAGNOSTIC_DOM_CAPTURE = String.raw`function(privateCapture) {
  const passwordCount = document.querySelectorAll('input[type="password"],input[type="email"]').length;
  const authRoute = /\/(?:auth|login|signin)(?:\/|$)/i.test(location.pathname);
  const safe = passwordCount === 0 && !authRoute;
  const result = { element_count: document.querySelectorAll('*').length,
    dialog_count: document.querySelectorAll('[role="dialog"]').length,
    button_count: document.querySelectorAll('button,[role="button"]').length,
    enabled_button_count: document.querySelectorAll('button:not(:disabled)').length,
    form_count: document.forms.length, capture_safe: safe };
  // Failure-only capability census. Counts distinguish an absent/virtualized user turn
  // from a changed renderer marker without exposing text, attributes or turn identifiers.
  const groups = [...document.querySelectorAll('[data-turn-key]')];
  result.keyed_turn_count = groups.length;
  // Independent renderer facts help diagnose a stalled phase/lineage projection.
  // They do not prove task ownership or authorize completion or approval.
  const visible = node => node.getClientRects().length > 0
    && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
  const sends = [...document.querySelectorAll('form [data-testid="send-button"], form button[type="submit"]')].filter(visible);
  result.composer_send_count = sends.length;
  result.enabled_composer_send_count = sends.filter(node => !node.disabled).length;
  result.composer_stop_count = [...document.querySelectorAll('form [data-testid="stop-button"]')].filter(visible).length;
  const bodies = [...document.querySelectorAll('[data-markdown-text-style="assistant-message"]')];
  result.assistant_body_count = bodies.length;
  result.visible_assistant_body_count = bodies.filter(visible).length;
  const userMarkers = {
    user_bubble: '[data-user-message-bubble]',
    user_author: '[data-message-author-role="user"]',
    user_conversation: '[data-conversation-role="user"]',
    user_markdown: '[data-markdown-text-style="user-message"]',
  };
  for (const [name, selector] of Object.entries(userMarkers)) {
    const nodes = [...document.querySelectorAll(selector)];
    result[name + '_count'] = nodes.length;
    result[name + '_keyed_count'] = nodes.filter(node => node.closest('[data-turn-key]')).length;
    result[name + '_group_self_count'] = groups.filter(group => group.matches(selector)).length;
  }
  // Read the nearest rendered turn viewport, without scrolling or changing the document.
  // A missing user at a nonzero offset can then be distinguished from a top-of-thread miss.
  let ancestor = groups.at(-1)?.parentElement;
  let viewport;
  for (let depth = 0; ancestor && depth < 16; depth++, ancestor = ancestor.parentElement) {
    if (typeof getComputedStyle === 'function' && /^(?:auto|scroll)$/.test(getComputedStyle(ancestor).overflowY)
      && ancestor.scrollHeight > ancestor.clientHeight) { viewport = ancestor; break; }
  }
  result.turn_viewport_observed = !!viewport;
  if (viewport) {
    result.turn_scroll_above_px = Math.max(0, Math.floor(viewport.scrollTop));
    result.turn_scroll_below_px = Math.max(0, Math.floor(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop));
    result.turn_viewport_height_px = Math.max(0, Math.floor(viewport.clientHeight));
  }
  const shell = [];
  try {
    const tags = ['div','article','section','main','button','span','body','html'];
    for (let node = groups.at(-1), depth = 0; node && depth < 8; node = node.parentElement, depth++) {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node), tag = node.tagName.toLowerCase();
      shell.push({ depth, kind: tags.includes(tag) ? tag : 'other',
        x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height),
        scroll_height: node.scrollHeight, client_height: node.clientHeight,
        hidden: style.display === 'none' || style.visibility === 'hidden',
        overflow_clips: /^(hidden|clip|auto|scroll)$/.test(style.overflowY),
        button_count: node.querySelectorAll('button,[role="button"]').length,
        status_count: node.querySelectorAll('[role="status"],[aria-live]').length,
        expanded_count: node.querySelectorAll('[aria-expanded="true"]').length,
        collapsed_count: node.querySelectorAll('[aria-expanded="false"]').length,
      });
    }
    result.shell_probe_available = true;
  } catch { result.shell_probe_available = false; }
  result.shell_nodes = shell;
  // A public prose region can be a sibling of the disclosure/title shell. Record
  // relationships and visibility only; no prose, IDs, class names or attributes.
  const progressBranches = [];
  try {
    const latest = groups.at(-1);
    const starts = latest ? [...latest.querySelectorAll('[data-chatgpt-agent-turn-start]')] : [];
    let parent = starts.length === 1 ? starts[0].parentElement : undefined;
    for (let depth = 0; parent && latest.contains(parent) && depth < 4; depth++, parent = parent.parentElement) {
      for (const [index, node] of [...parent.children].slice(0,64).entries()) {
        if (progressBranches.length >= 64) break;
        const style = getComputedStyle(node);
        const paragraphs = [...node.querySelectorAll('p')];
        progressBranches.push({ depth, child_index: index, child_count: node.children.length,
          contains_start: node === starts[0] || node.contains(starts[0]),
          disclosure_count: node.querySelectorAll('button[aria-expanded][aria-labelledby]').length,
          paragraph_count: paragraphs.length,
          rendered_paragraph_count: paragraphs.filter(p => p.getClientRects().length > 0
            && getComputedStyle(p).visibility !== 'hidden' && getComputedStyle(p).display !== 'none').length,
          contains_user: node.matches('[data-user-message-bubble]') || !!node.querySelector('[data-user-message-bubble]'),
          contains_answer: node.matches('[data-markdown-text-style="assistant-message"]') || !!node.querySelector('[data-markdown-text-style="assistant-message"]'),
          nested_turn_count: node.querySelectorAll('[data-turn-key]').length,
          has_rects: node.getClientRects().length > 0, display_contents: style.display === 'contents',
          hidden: node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none'
            || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0',
        });
      }
      if (progressBranches.length >= 64) break;
    }
    result.progress_branch_probe_available = true;
  } catch { result.progress_branch_probe_available = false; }
  result.progress_branches = progressBranches;
  const resources = performance.getEntriesByType('resource').slice(-64);
  result.resource_count = resources.length;
  result.resource_status_observed_count = resources.filter(row => Number(row.responseStatus) > 0).length;
  result.resource_failed_count = resources.filter(row => Number(row.responseStatus) >= 400).length;
  result.resource_slow_count = resources.filter(row => row.duration >= 10000).length;
  result.resource_inflight_count = resources.filter(row => row.responseEnd === 0).length;
  if (privateCapture && safe) {
    const serialize = source => {
      const clone = source.cloneNode(true);
      for (const element of clone.querySelectorAll('script,noscript,iframe,object,embed')) element.remove();
      for (const element of [clone, ...clone.querySelectorAll('*')]) {
        for (const attribute of [...element.attributes]) {
          if (/^(?:value|href|src|srcset|action|formaction|nonce|on.*)$/i.test(attribute.name)
            || /token|secret|password|authorization|cookie|csrf/i.test(attribute.name)) element.removeAttribute(attribute.name);
        }
        if (element.tagName === 'TEXTAREA') element.textContent = '';
      }
      return clone.outerHTML.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{16,}/g,'[REDACTED]');
    };
    const html = serialize(document.documentElement);
    result.html_truncated = html.length > 1000000;
    result.html = html.slice(0,1000000);
    // The latest turn can fall beyond a large prompt's document-prefix budget.
    // Capture its local renderer shell separately, without expanding or clicking it.
    const latest = groups.at(-1);
    const focused = latest?.parentElement ?? latest;
    if (focused) {
      const html = serialize(focused);
      result.focus_html_truncated = html.length > 1000000;
      result.focus_html = html.slice(-1000000);
    }
  }
  return result;
}`;

async function captureEvidence(surface: BrowserSurfaceLease, reason: "model_picker_failed" | "web_preparation_failed" | "turn_failure" | "approval_anomaly" | "surface_anomaly" | "completion_deferred" | "progress_description_missing" | "progress_prose_unmapped" | "before_submit" | "turn_accepted" | "approval_pending" | "approval_resolution" | "approval_preparation_failed"): Promise<void> {
  const root=configuredDiagnosticRoot(); if (!root) return;
  const operation=diagnosticContext().operation_fingerprint ?? diagnosticFingerprint([surface.taskId,surface.epochId].join("\n"));
  const key=operation+reason; const now=Date.now();
  if ((recent.get(key) ?? 0)>now-60000) return;
  recent.set(key,now); for (const [entry,at] of recent) if (recent.size>128 || at<now-600000) recent.delete(entry);
  const page=surface.capability(BROWSER_PAGE_AUTOMATION); if (!page) return;
  const enabled=privateDiagnosticCaptureEnabled(root);
  const controller=new AbortController();
  let onAbort: (()=>void) | undefined;
  const timeout=setTimeout(()=>controller.abort(),3000); timeout.unref?.();
  const run=async()=>{
    const snapshot=await page.evaluate<boolean,Record<string,unknown>>(DIAGNOSTIC_DOM_CAPTURE,enabled,controller.signal);
    if (controller.signal.aborted) return;
    const fields: Record<string,number|boolean|string>={ reason_class:reason };
    for (const key of ["element_count","dialog_count","button_count","enabled_button_count","form_count","resource_count","resource_status_observed_count","resource_failed_count","resource_slow_count","resource_inflight_count", "keyed_turn_count", "composer_send_count", "enabled_composer_send_count", "composer_stop_count", "assistant_body_count", "visible_assistant_body_count", "turn_scroll_above_px", "turn_scroll_below_px", "turn_viewport_height_px",
      ...["user_bubble", "user_author", "user_conversation", "user_markdown"].flatMap(name => [name + "_count", name + "_keyed_count", name + "_group_self_count"])]) {
      const value=snapshot[key]; if (typeof value==="number" && Number.isSafeInteger(value) && value>=0) fields[key]=value;
    }
    fields.private_capture=enabled; fields.capture_safe=snapshot.capture_safe===true;
    fields.turn_viewport_observed=snapshot.turn_viewport_observed===true;
    fields.html_truncated=snapshot.html_truncated===true;
    fields.focus_html_truncated=snapshot.focus_html_truncated===true;
    fields.focus_capture_present=typeof snapshot.focus_html==="string";
    fields.shell_probe_available=snapshot.shell_probe_available===true;
    fields.progress_branch_probe_available=snapshot.progress_branch_probe_available===true;
    emitDiagnosticEvent("chatgpt_tela_browser","browser_snapshot_observed",fields);
    if (Array.isArray(snapshot.shell_nodes)) for (const node of snapshot.shell_nodes.slice(0,8)) {
      if (!node || typeof node !== "object") continue;
      const evidence: Record<string, string|number|boolean> = { reason_class: reason };
      for (const [name, value] of Object.entries(node)) {
        if (typeof value==="boolean" || typeof value==="number" && Number.isSafeInteger(value)) evidence[name]=value;
        else if (name==="kind" && typeof value==="string" && ["div","article","section","main","button","span","body","html","other"].includes(value)) evidence.kind=value;
      }
      emitDiagnosticEvent("chatgpt_tela_browser","browser_shell_observed",evidence);
    }
    if (Array.isArray(snapshot.progress_branches)) for (const node of snapshot.progress_branches.slice(0,64)) {
      if (!node || typeof node !== "object") continue;
      const evidence: Record<string, string|number|boolean> = { reason_class: reason };
      for (const [name,value] of Object.entries(node)) {
        if (typeof value === "boolean" || typeof value === "number" && Number.isSafeInteger(value) && value >= 0) evidence[name] = value;
      }
      emitDiagnosticEvent("chatgpt_tela_browser","browser_progress_branch_observed",evidence);
    }
    if (!enabled || snapshot.capture_safe!==true) return;
    let retained=0, omitted=0;
    // A stuck delivery boundary must not lose its renderer evidence to routine tool traces.
    // Reuse the existing failure-priority retention, with the same byte/age budget.
    const failure = reason === "completion_deferred" ? { evidenceClass: "failure" as const } : {};
    const record=(ref: string | undefined)=>{ if(ref) retained++; else omitted++; };
    if (typeof snapshot.html==="string") record(writePrivateDiagnosticArtifact(root,{ kind:"html",bytes:Buffer.from(snapshot.html),operationFingerprint:operation,captureScope:"document", ...failure }));
    if (typeof snapshot.focus_html==="string") record(writePrivateDiagnosticArtifact(root,{ kind:"html",bytes:Buffer.from(snapshot.focus_html),operationFingerprint:operation,captureScope:"latest_turn_shell", ...failure }));
    const preview=surface.capability(BROWSER_READ_ONLY_PREVIEW);
    if (preview) {
      const bytes=await preview.captureJpeg();
      if (!controller.signal.aborted) record(writePrivateDiagnosticArtifact(root,{kind:"jpg",bytes,operationFingerprint:operation,...failure}));
    }
    const stage=retained ? "private_capture_recorded" : "private_capture_omitted";
    emitDiagnosticEvent("chatgpt_tela_browser",stage,{...fields,retained_count:retained,omitted_count:omitted});
    const row=structuralDiagnosticEvent({ ts:new Date().toISOString(), event:"chatgpt_tela_browser", stage, operation_fingerprint:operation, ...fields, retained_count:retained, omitted_count:omitted });
    if (row && !controller.signal.aborted) writeDiagnosticIncident(root,{stage:row.stage,observedAt:row.ts,timeline:[row]});
  };
  try {
    await Promise.race([run(),new Promise<void>(resolve=> { onAbort=()=>resolve(); controller.signal.addEventListener("abort",onAbort,{once:true}); })]);
  } catch { emitDiagnosticEvent("chatgpt_tela_browser","browser_evidence_unavailable",{ reason_class:reason }); }
  finally { clearTimeout(timeout); controller.abort(); if (onAbort) controller.signal.removeEventListener("abort",onAbort); }
}

/** Diagnostic failure never changes the browser turn result or approval policy. */
export async function captureBrowserDiagnosticEvidence(surface: BrowserSurfaceLease, reason: "model_picker_failed" | "web_preparation_failed" | "turn_failure" | "approval_anomaly" | "surface_anomaly" | "completion_deferred" | "progress_description_missing" | "progress_prose_unmapped" | "before_submit" | "turn_accepted" | "approval_pending" | "approval_resolution" | "approval_preparation_failed"): Promise<void> {
  try { await captureEvidence(surface, reason); } catch { /* Best effort, including missing capabilities. */ }
}

export async function captureBrowserDiagnosticCheckpoint(surface: BrowserSurfaceLease, reason: "before_submit" | "turn_accepted" | "surface_anomaly" | "completion_deferred" | "progress_description_missing" | "progress_prose_unmapped" | "approval_pending" | "approval_resolution" | "approval_preparation_failed"): Promise<void> {
  const root=configuredDiagnosticRoot();
  if (root && privateDiagnosticCaptureEnabled(root)) await captureBrowserDiagnosticEvidence(surface,reason);
}
