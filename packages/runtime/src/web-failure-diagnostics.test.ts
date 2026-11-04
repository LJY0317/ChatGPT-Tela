import { WebObservationUnproven, WebSubmissionUnproven, WEB_SUBMISSION_PROOF_REASONS } from "@chatgpt-tela/core";
import { expect, test } from "bun:test";
import { requireProven } from "@chatgpt-tela/chatgpt";
import { webExecutionFailureFields } from "./web-failure-diagnostics";
import { WebRetainedContextUnproven, WEB_RETAINED_CONTEXT_REASONS } from "@chatgpt-tela/core";

test("Native authority termination, observer loss and uncertain proof remain distinct", () => {
  expect(webExecutionFailureFields(new Error("Native turn terminated")).reason_class).toBe("native_terminated");
  expect(webExecutionFailureFields(new Error("Native lifecycle observation disconnected")).reason_class).toBe("native_observer_disconnected");
  expect(webExecutionFailureFields(new Error("Native live turn ownership was revoked")).reason_class).toBe("native_live_owner_revoked");
  expect(webExecutionFailureFields(new Error("Native live turn ownership was not retained")).reason_class).toBe("native_live_owner_unproven");
  expect(webExecutionFailureFields(new Error("Native live turn changed during observation")).reason_class).toBe("native_live_owner_changed");
  let ambiguousFailure: unknown;
  try {
    requireProven({ state: "ambiguous", candidates: [], evidence: [], reason: "unknown" });
  } catch (error) { ambiguousFailure = error; }
  expect(webExecutionFailureFields(ambiguousFailure).reason_class).toBe("observation_ambiguous");
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

test("probable observations preserve closed evidence provenance without exposing evidence text", () => {
  let failure: unknown;
  try {
    requireProven({ state: "probable", value: "unused", evidence: [
      "composer readback did not prove the exact prepared payload",
    ], reason: "composer_readback_unproven" });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("consequential action requires proven state; observed probable");
  const fields = webExecutionFailureFields(failure);
  expect(fields).toMatchObject({
    reason_class: "observation_probable",
    observation_state: "probable",
    observation_evidence_class: "composer_readback_unproven",
    observation_evidence_count: 1,
  });
  expect(JSON.stringify(fields)).not.toContain("composer readback");

  let ambiguous: unknown;
  try {
    requireProven({ state: "ambiguous", candidates: ["a", "b"], evidence: ["unknown structural evidence"] });
  } catch (error) { ambiguous = error; }
  expect(webExecutionFailureFields(ambiguous)).toMatchObject({
    reason_class: "observation_ambiguous",
    observation_state: "ambiguous",
    observation_evidence_class: "unknown",
    observation_evidence_count: 1,
  });
});

test("ambiguous observations preserve their producer reason", () => {
  let failure: unknown;
  try {
    requireProven({ state: "ambiguous", candidates: ["a", "b"], evidence: ["multiple new assistant lineages"],
      reason: "assistant_lineages_multiple" });
  } catch (error) { failure = error; }
  expect(webExecutionFailureFields(failure)).toMatchObject({
    reason_class: "observation_ambiguous",
    observation_state: "ambiguous",
    observation_evidence_class: "assistant_lineages_multiple",
    observation_evidence_count: 1,
  });
});

test("observation reasons remain closed at the shared error boundary", () => {
  const error = Object.assign(new WebObservationUnproven("unknown", "private detail", {
    state: "probable", evidenceCount: 1,
  }), { reason: "private browser detail" });
  const fields = webExecutionFailureFields(error);
  expect(fields).toMatchObject({
    reason_class: "observation_probable",
    observation_evidence_class: "unknown",
    observation_evidence_count: 1,
  });
  expect(JSON.stringify(fields)).not.toContain("private");
});

test("throwing observation error getters cannot replace the original failure during classification", () => {
  const diagnosticFailure = new WebObservationUnproven("unknown");
  Object.defineProperty(diagnosticFailure, "diagnostic", { get() { throw new Error("private diagnostic getter"); } });
  expect(webExecutionFailureFields(diagnosticFailure)).toEqual({
    reason_class: "unclassified", owner_aborted: false, abort_reason_class: "none",
  });

  const reasonFailure = new WebObservationUnproven("unknown", "original proof failure");
  Object.defineProperty(reasonFailure, "reason", { get() { throw new Error("private reason getter"); } });
  expect(webExecutionFailureFields(reasonFailure)).toEqual({
    reason_class: "unclassified", owner_aborted: false, abort_reason_class: "none",
  });

  const diagnosticReasonFailure = new WebObservationUnproven("unknown", "original proof failure", {
    state: "probable", evidenceCount: 1,
  });
  Object.defineProperty(diagnosticReasonFailure, "reason", { get() { throw new Error("private diagnostic reason getter"); } });
  expect(webExecutionFailureFields(diagnosticReasonFailure)).toEqual({
    reason_class: "unclassified", owner_aborted: false, abort_reason_class: "none",
  });
});

test("public failure projection contains a throwing observation code getter", () => {
  const failure = new WebObservationUnproven("unknown", "original proof failure");
  Object.defineProperty(failure, "code", { get() { throw new Error("private code getter"); } });
  expect(webExecutionFailureFields(failure)).toEqual({
    reason_class: "unclassified", owner_aborted: false, abort_reason_class: "none",
  });
});

test("observation diagnostics count the complete evidence set", () => {
  const evidence = Array.from({length: 20}, () => "composer readback did not prove the exact prepared payload");
  let failure: unknown;
  try { requireProven({ state: "probable", value: "unused", evidence, reason: "composer_readback_unproven" }); }
  catch (error) { failure = error; }
  expect(webExecutionFailureFields(failure)).toMatchObject({
    reason_class: "observation_probable",
    observation_state: "probable",
    observation_evidence_class: "composer_readback_unproven",
    observation_evidence_count: 20,
  });
});
