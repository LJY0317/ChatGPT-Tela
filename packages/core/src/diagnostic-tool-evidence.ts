import { createHmac, randomBytes } from "node:crypto";
import type { NativeToolCatalogEntry } from "./tools";
import type { DiagnosticScalar } from "./diagnostic-events";

const key = randomBytes(32);
/** Contract-only, salted fingerprints. Never hash invocation arguments or result bodies. */
export function diagnosticToolContract(tool: NativeToolCatalogEntry): Readonly<Record<string, DiagnosticScalar>> {
  try {
    let nodes = 0, bytes = 0;
    const normalize = (value: unknown, depth = 0): unknown => {
      if (++nodes > 512 || depth > 12) throw Error("diagnostic contract budget");
      if (typeof value === "string") { bytes += Buffer.byteLength(value); if (bytes > 65536) throw Error("diagnostic contract budget"); return value; }
      if (value == null || typeof value === "boolean" || typeof value === "number") return value;
      if (Array.isArray(value)) { if (value.length > 128) throw Error("diagnostic contract budget"); return value.map(entry => normalize(entry, depth + 1)); }
      if (typeof value === "object") {
        const keys = Object.keys(value).sort(); if (keys.length > 128) throw Error("diagnostic contract budget");
        return keys.map(name => [normalize(name, depth + 1), normalize((value as Record<string, unknown>)[name], depth + 1)]);
      }
      throw Error("unsupported diagnostic contract");
    };
    if (tool.wireName.length > 16384) throw Error("diagnostic identity budget");
    const fingerprint = (text: string) => createHmac("sha256", key).update(text).digest("hex").slice(0, 24);
    return { tool_fingerprint: fingerprint(tool.wireName), schema_fingerprint: fingerprint(JSON.stringify(normalize(tool.inputSchema ?? null))),
      kind: tool.kind, namespace_present: Boolean(tool.namespace), contract_observed: true };
  } catch { return { contract_observed: false }; }
}

/** Inspect an already received ERROR only; a message signal never proves its generating layer. */
export function diagnosticToolFailureEvidence(value: unknown): Readonly<Record<string, DiagnosticScalar>> {
  let observed = false, complete = true, nodes = 0, remaining = 16384;
  const seen = new Set<object>();
  const scan = (item: unknown) => {
    if (++nodes > 32 || remaining <= 0) { complete = false; return; }
    if (typeof item === "string") {
      const text = item.slice(0, remaining); if (text.length < item.length) complete = false;
      remaining -= text.length;
      if (text.includes("couldn't determine the safety status of the request")) observed = true;
    } else if (item && typeof item === "object") {
      if (seen.has(item)) { complete = false; return; } seen.add(item);
      if (Array.isArray(item)) { if (item.length > 16) complete = false; for (const entry of item.slice(0,16)) scan(entry); }
      else for (const name of ["message", "content", "text"]) {
        const entry = (item as Record<string, unknown>)[name]; if (entry !== undefined) scan(entry);
      }
    }
  };
  try { scan(value); } catch { complete = false; }
  return { reason_class: observed ? "safety_status_undetermined" : "unknown", message_signal_observed: observed,
    inspection_complete: complete, origin_proven: false, execution_proven: false };
}
