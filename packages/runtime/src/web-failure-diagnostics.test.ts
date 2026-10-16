import { WebSubmissionUnproven, WEB_SUBMISSION_PROOF_REASONS } from "@chatgpt-tela/core";
import { expect, test } from "bun:test";
import { webExecutionFailureFields } from "./web-failure-diagnostics";
import { WebRetainedContextUnproven, WEB_RETAINED_CONTEXT_REASONS } from "@chatgpt-tela/core";

test("Native authority termination, observer loss and uncertain proof remain distinct", () => {
  expect(webExecutionFailureFields(new Error("Native turn terminated")).reason_class).toBe("native_terminated");
  expect(webExecutionFailureFields(new Error("Native lifecycle observation disconnected")).reason_class).toBe("native_observer_disconnected");
  expect(webExecutionFailureFields(new Error("Native live turn ownership was revoked")).reason_class).toBe("native_live_owner_revoked");
  expect(webExecutionFailureFields(new Error("Native live turn ownership was not retained")).reason_class).toBe("native_live_owner_unproven");
  expect(webExecutionFailureFields(new Error("Native live turn changed during observation")).reason_class).toBe("native_live_owner_changed");
  expect(webExecutionFailureFields(new Error("consequential action requires proven state; observed ambiguous")).reason_class).toBe("observation_ambiguous");
  expect(webExecutionFailureFields(new Error("ChatGPT conversation changed during the active Web turn")).reason_class).toBe("conversation_changed");
  expect(webExecutionFailureFields(new Error("ChatGPT accepted user identity changed during the active Web turn")).reason_class).toBe("accepted_user_changed");
  expect(webExecutionFailureFields(new Error("ChatGPT assistant parent does not prove the accepted request identity")).reason_class).toBe("assistant_parent_unproven");
  expect(webExecutionFailureFields(new Error("ChatGPT renderer rekey does not prove the accepted request identity")).reason_class).toBe("renderer_rekey_unproven");
  for (const reason of WEB_RETAINED_CONTEXT_REASONS) {
    expect(webExecutionFailureFields(new WebRetainedContextUnproven(reason)).reason_class).toBe(reason);
  }
  const owner = new AbortController(); owner.abort(new Error("Native turn terminated"));
  expect(webExecutionFailureFields(new DOMException("wait aborted", "AbortError"), owner.signal))
    .toEqual({ reason_class: "aborted", owner_aborted: true, abort_reason_class: "native_terminated" });
  const liveOwner = new AbortController();
  liveOwner.abort(new Error("Native live turn ownership was revoked"));
  expect(webExecutionFailureFields(new DOMException("wait aborted", "AbortError"), liveOwner.signal))
    .toEqual({ reason_class: "aborted", owner_aborted: true, abort_reason_class: "native_live_owner_revoked" });
});

test("untrusted exception prose never becomes routine diagnostic data", () => {
  const error = new Error("private@example.invalid /private/file Bearer sensitive-value");
  error.name = "private-name";
  expect(webExecutionFailureFields(error)).toEqual({ reason_class: "unclassified", owner_aborted: false, abort_reason_class: "none" });
  expect(webExecutionFailureFields("private non-error").reason_class).toBe("non_error");
  expect(webExecutionFailureFields(Object.assign(error, { code: "tela_web_retained_context_unproven", reason: "PRIVATE BROWSER TEXT" })).reason_class).toBe("unclassified");
});

test("submission proof diagnostics keep only closed structural reasons", () => {
  for (const reason of WEB_SUBMISSION_PROOF_REASONS) {
    expect(webExecutionFailureFields(new WebSubmissionUnproven(reason)).reason_class).toBe(reason);
  }
  expect(webExecutionFailureFields(Object.assign(new Error("private text"), {
    code: "tela_web_submission_unproven", reason: "private browser content",
  })).reason_class).toBe("unclassified");
});
