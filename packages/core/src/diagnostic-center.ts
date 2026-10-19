import { analyzeDiagnosticEvents, HOST_SYMPTOMS, HOST_REPORT_ORIGINS, listDiagnosticIncidents, readDiagnosticIncident,
  readDiagnosticSources, setPrivateDiagnosticCapture, writeDiagnosticIncident, structuralDiagnosticEvent, type HostSymptom, type HostReportOrigin } from "./diagnostic-store";
import { join } from "node:path";
import { summarizeContextContinuity } from "./diagnostic-context-continuity";

export function diagnosticSourcePaths(logsRoot: string): readonly string[] {
  return Object.freeze(["gateway", "chat", "codex"].flatMap(service => {
    const source = join(logsRoot, `${service}.log.diagnostics.jsonl`);
    const packaged = join(logsRoot, `${service}.diagnostics.jsonl`);
    return [source, `${source}.1`, packaged, `${packaged}.1`];
  }));
}

/** One canonical entry point; raw private artifacts are never embedded in a report. */
export function diagnosticCenter(root: string, paths: readonly string[], command: string | undefined,
  option: (name: string) => string | undefined): unknown {
  if (command === "list") return { privacy: "structural-only", incidents: listDiagnosticIncidents(root) };
  if (command === "inspect") return readDiagnosticIncident(root, option("--ref") ?? "");
  if (command === "context") {
    const atMs = option("--at") ? Date.parse(option("--at")!) : Date.now();
    const minutes = Number(option("--minutes") ?? 120), scope = option("--scope");
    if (!Number.isFinite(atMs) || !Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw Error("invalid context report window");
    const view=option("--view")??"full",limit=Number(option("--limit")??(view==="summary"?8:64));
    if(!["full","summary"].includes(view)||!Number.isInteger(limit)||limit<1||limit>64)throw Error("invalid context report view or limit");
    const source = readDiagnosticSources(paths, { fromMs: atMs - minutes * 60000, toMs: atMs });
    const archived = listDiagnosticIncidents(root).filter(record=>record.stage==='native_cycle_summary').flatMap(record=>{
      const incident=readDiagnosticIncident(root,record.ref);
      const timeline=incident&&typeof incident==='object'&&'timeline' in incident&&Array.isArray(incident.timeline)?incident.timeline:[];
      return timeline.flatMap((row:unknown)=>{
        const safe=structuralDiagnosticEvent(row);
        return safe&&Date.parse(safe.ts)>=atMs-minutes*60000&&Date.parse(safe.ts)<=atMs?[safe]:[];
      });
    });
    const merged=[...new Map([...source.events,...archived].map(row=>[
      JSON.stringify(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))),row])).values()].sort((a,b)=>a.ts.localeCompare(b.ts));
    // A scoped audit must not lose its sparse archive to another chat's traffic
    // before the report's event budget is applied. Keep correlated owners too,
    // so ambiguous request/operation attribution remains visible.
    const scoped=merged.filter(row=>row.scope_fingerprint===scope);
    const requests=new Set(scoped.map(row=>row.request_fingerprint).filter(Boolean));
    const operations=new Set(scoped.map(row=>row.operation_fingerprint).filter(Boolean));
    const selectedEvents=scope?merged.filter(row=>row.scope_fingerprint===scope
      || requests.has(row.request_fingerprint)||operations.has(row.operation_fingerprint)):merged;
    const report=summarizeContextContinuity({ events: selectedEvents, atMs, ...(scope ? { scope } : {}) });
    const selected=report.turns.slice(-limit);
    return { ...report,view,selection:{turnLimit:limit,turnsOmitted:report.turns.length-selected.length},
      turns:view==="full"?selected:selected.map(t=>({scopeFingerprint:t.scopeFingerprint,turnFingerprint:t.turnFingerprint,
        outcome:t.outcome,completionEvidence:t.completionEvidence,summary:t.summary,cycleReceipts:t.cycleReceipts.slice(-1)})),
      sourceCoverage: source.coverage, archivedCycleEvents:archived.length, sourceLimitReached: source.sourceLimitReached, excludedTestEvents: source.excludedTestEvents };
  }
  if (command === "capture") {
    const mode = option("--mode"), minutes = option("--minutes");
    if (mode !== undefined && (mode !== "until-disabled" || minutes !== undefined)) throw new Error("capture requires --minutes 0..60 or --mode until-disabled, not both");
    return setPrivateDiagnosticCapture(root, mode === "until-disabled" ? mode : Number(minutes ?? 0));
  }
  if (command !== "record" && command !== "activity") return undefined;
  const at = option("--at");
  if (command === "record" && !at) throw new Error("record requires --at <ISO-time> and an explicit host symptom");
  const symptom = option("--symptom") ?? "unknown";
  if (!(HOST_SYMPTOMS as readonly string[]).includes(symptom)) throw new Error("invalid host symptom");
  const operation = option("--operation"); const recovered = option("--recovered-at"); const output = option("--output-started-at");
  const reportOrigin = option("--report-origin");
  if (reportOrigin !== undefined && !(HOST_REPORT_ORIGINS as readonly string[]).includes(reportOrigin)) throw new Error("invalid host report origin");
  const atMs = at ? Date.parse(at) : Date.now(), minutes = Number(option("--minutes") ?? 5);
  if (!Number.isFinite(atMs) || !Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new Error("invalid incident window");
  // Select the incident interval before the per-source event cap, within the same byte budget.
  const source = readDiagnosticSources(paths, { fromMs: atMs - minutes * 60000, toMs: atMs + minutes * 60000 });
  const analysis = analyzeDiagnosticEvents({ events: source.events, atMs,
    minutes, symptom: symptom as HostSymptom,
    ...(reportOrigin ? { reportOrigin: reportOrigin as HostReportOrigin } : {}),
    ...(operation ? { operationFingerprint: operation } : {}),
    ...(recovered ? { recoveredAtMs: Date.parse(recovered) } : {}),
    ...(output ? { outputStartedAtMs: Date.parse(output) } : {}),
  });
  const result = { ...analysis, sourceCoverage: source.coverage, sourceLimitReached: source.sourceLimitReached, excludedTestEvents: source.excludedTestEvents };
  return command === "record" ? { ...result, ref: writeDiagnosticIncident(root, result) } : result;
}
