import { describe, expect, test } from "bun:test";
import { DIAGNOSTIC_FAILURE_CLASSES, diagnosticFailureClass, diagnosticFailureFields } from "./diagnostic-failure";

describe("bounded diagnostic failure classifications", () => {
  test("distinguishes observed product failures using only fixed enumerations", () => {
    const cases = [
      ["Tela Chat process operation registry is at capacity; no process was started", "capacity_exhausted"],
      ["process operation store exceeds its byte limit", "storage_capacity"],
      ["Native indexed current-turn proof unavailable; unindexed history was not paged", "history_unindexed"],
      ["process operation request does not match its reserved command and directory", "request_conflict"],
      ["unresolved execution", "owner_unavailable"],
      ["command is empty or too large", "input_rejected"],
    ] as const;
    for (const [message, expected] of cases) {
      expect(diagnosticFailureClass(new Error(message))).toBe(expected);
    }
    expect(diagnosticFailureClass(Object.assign(new Error("private"), { code: "ETIMEDOUT" }))).toBe("timeout");
    expect(diagnosticFailureClass(Object.assign(new Error("private"), { code: "EPIPE" }))).toBe("transport_failure");
    expect(diagnosticFailureClass(Object.assign(new Error("private"), { code: "ENOSPC" }))).toBe("storage_capacity");
    expect(diagnosticFailureClass(Object.assign(new Error("private"), { code: "EACCES" }))).toBe("permission_rejected");
    expect(diagnosticFailureClass(Object.assign(new Error("private"), {
      code: "native_auto_handoff_unavailable",
    }))).toBe("unavailable");
    expect(diagnosticFailureClass(Object.assign(new Error("secret"), { name: "AbortError" }))).toBe("aborted");
  });

  test("never converts arbitrary exception text or unsupported codes into diagnostic data", () => {
    const privateMessage = "run /Users/secret/code --token top-secret for owner foo@example.com";
    for (const value of [new Error(privateMessage), { code: privateMessage, message: privateMessage },
      "throwing a plain secret", null, 42]) {
      const classified = diagnosticFailureClass(value);
      expect(DIAGNOSTIC_FAILURE_CLASSES).toContain(classified);
      expect(classified).toBe("unknown");
      expect(classified).not.toContain("secret");
    }
    expect(diagnosticFailureClass(new Proxy({}, {
      get() { throw new Error("private getter secret must not be propagated"); },
    }))).toBe("unknown");
  });
});

test("bounded cause inspection recovers standard failures without private exception data", () => {
 const error = new Error("PRIVATE_OUTER", {cause:Object.assign(new Error("PRIVATE_FILE"), {code:"ENOENT"})});
 expect(diagnosticFailureFields(error)).toMatchObject({reason_class:"not_found",cause_depth:1,error_inspection_complete:true});
 expect(diagnosticFailureClass(new TypeError("PRIVATE_ARGUMENT"))).toBe("type_error");
 const cycle = new Error("PRIVATE_CYCLE"); Object.assign(cycle,{cause:cycle});
 expect(diagnosticFailureFields(cycle)).toMatchObject({reason_class:"unknown",error_inspection_complete:false});
 let deep:any=Object.assign(new Error("PRIVATE_LEAF"),{code:"ENOENT"});
 for(let i=0;i<8;i++)deep=new Error("PRIVATE_WRAPPER",{cause:deep});
 expect(diagnosticFailureFields(deep)).toMatchObject({reason_class:"unknown",cause_depth:4,error_inspection_complete:false});
 expect(JSON.stringify(diagnosticFailureFields(error))).not.toContain("PRIVATE_");
});
