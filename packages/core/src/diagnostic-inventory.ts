import { createHmac, randomBytes } from "node:crypto";
import type { NativeToolCatalogEntry } from "./tools";
import { emitDiagnosticEvent } from "./diagnostic-events";
const key = randomBytes(32);
const snapshots = new Map<string, {fingerprint: string; count: number; at: number}>();
/** On-call, bounded inventory changes; names/schemas never enter diagnostics. */
export function observeDiagnosticInventory(scope: string, tools: readonly NativeToolCatalogEntry[]): void {
  try {
    const now=Date.now();
    for (const [entry,row] of snapshots) if (row.at<now-6*3600000) snapshots.delete(entry);
    const fingerprint=createHmac("sha256",key).update(JSON.stringify(tools.map(tool=>[tool.wireName,tool.kind,tool.namespace,tool.inputSchema]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest("hex").slice(0,24);
    const previous=snapshots.get(scope);
    snapshots.delete(scope); snapshots.set(scope,{fingerprint,count:tools.length,at:now});
    while (snapshots.size>256) snapshots.delete(snapshots.keys().next().value!);
    if (previous?.fingerprint===fingerprint) return;
    emitDiagnosticEvent("chatgpt_tela_work","native_inventory_observed",{ inventory_fingerprint:fingerprint, count:tools.length,
      changed:previous!==undefined, count_delta:tools.length-(previous?.count??0),
      freeform_count:tools.filter(tool=>tool.kind==="freeform").length,
      namespace_count:new Set(tools.map(tool=>tool.namespace).filter(Boolean)).size,
    });
  } catch { /* No effect on Native authority. */ }
}

const pressure = new Map<string, { estimate: number; revisions: number; at: number }>();
/** Context estimates are local pressure evidence, never measured/billed Web tokens. */
export function observeDiagnosticContextPressure(scope: string, estimate: number, revisions: number, summaryPresent: boolean, details: { toolResultCount?: number; toolResultBytes?: number } = {}): void {
  try {
    const now=Date.now();
    for (const [id,row] of pressure) if (row.at<now-6*3600000) pressure.delete(id);
    const previous=pressure.get(scope);
    pressure.delete(scope); pressure.set(scope,{estimate,revisions,at:now});
    while(pressure.size>256) pressure.delete(pressure.keys().next().value!);
    emitDiagnosticEvent("chatgpt_tela_work","context_pressure_observed",{ logical_estimate:estimate, revision_count:revisions,
      summary_present:summaryPresent, prior_observed:previous!==undefined,
      tool_result_count:details.toolResultCount??0, tool_result_bytes:details.toolResultBytes??0,
      estimate_delta:estimate-(previous?.estimate??estimate), revision_delta:revisions-(previous?.revisions??revisions),
    });
  } catch { /* Diagnostics are not context/compaction authority. */ }
}
