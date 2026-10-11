import { analyzeDiagnosticEvents, HOST_SYMPTOMS, listDiagnosticIncidents, readDiagnosticIncident,
  readDiagnosticSources, setPrivateDiagnosticCapture, writeDiagnosticIncident, type HostSymptom } from "./diagnostic-store";
import { join } from "node:path";

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
  const source = readDiagnosticSources(paths);
  const analysis = analyzeDiagnosticEvents({ events: source.events, atMs: at ? Date.parse(at) : Date.now(),
    minutes: Number(option("--minutes") ?? 5), symptom: symptom as HostSymptom,
    ...(operation ? { operationFingerprint: operation } : {}),
    ...(recovered ? { recoveredAtMs: Date.parse(recovered) } : {}),
    ...(output ? { outputStartedAtMs: Date.parse(output) } : {}),
  });
  const result = { ...analysis, sourceCoverage: source.coverage, sourceLimitReached: source.sourceLimitReached, excludedTestEvents: source.excludedTestEvents };
  return command === "record" ? { ...result, ref: writeDiagnosticIncident(root, result) } : result;
}
