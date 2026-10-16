import type { DiagnosticScalar } from "@chatgpt-tela/core";

const METHODS = new Map([
  ["remoteControl/status/read", "status_read"],
  ["remoteControl/enable", "enable"],
  ["remoteControl/disable", "disable"],
]);
const STATES = new Set(["disabled", "connecting", "connected", "errored"]);
const LIMIT = 32;

/** Passive protocol observation: no identifiers, bodies, enrollment data or extra RPCs. */
export function remoteControlDiagnostics(emit: (fields: Readonly<Record<string, DiagnosticScalar>>) => void) {
  const pending = new Map<string | number, string>();
  let emitted = 0, previous = "";
  const id = (value: unknown): value is string | number =>
    typeof value === "string" ? value.length > 0 && value.length <= 512 : Number.isSafeInteger(value);
  const record = (kind: string, row: any, error?: any) => {
    if (emitted >= LIMIT) return;
    const fields: Record<string, DiagnosticScalar> = {
      kind, status: error !== undefined ? "rpc_error" : STATES.has(row?.status) ? row.status : "unknown",
    };
    if (error !== undefined && Number.isSafeInteger(error?.code)) fields.error_code = error.code;
    const signature = JSON.stringify(fields);
    if (signature === previous) return;
    previous = signature; emitted++;
    try { emit(fields); } catch { /* Diagnostics never affect official Remote or Native traffic. */ }
  };
  return {
    request(value: any) {
      if (!id(value?.id)) return;
      // An unrelated request reusing an id must not be interpreted as Remote's response.
      pending.delete(value.id);
      const kind = METHODS.get(value?.method);
      if (kind && emitted < LIMIT && pending.size < LIMIT) pending.set(value.id, kind);
    },
    response(value: any) {
      if (value?.method === "remoteControl/status/changed") record("notification", value.params);
      if (!id(value?.id)) return;
      const kind = pending.get(value.id);
      pending.delete(value.id);
      if (kind) record(kind, value.result, value.error);
    },
    close() { pending.clear(); },
  };
}
