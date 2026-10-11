import { expect, test } from "bun:test";
import { webExecutionFailureFields } from "./web-failure-diagnostics";

test("Native authority termination, observer loss and uncertain proof remain distinct", () => {
  expect(webExecutionFailureFields(new Error("Native turn terminated")).reason_class).toBe("native_terminated");
  expect(webExecutionFailureFields(new Error("Native lifecycle observation disconnected")).reason_class).toBe("native_observer_disconnected");
  expect(webExecutionFailureFields(new Error("consequential action requires proven state; observed ambiguous")).reason_class).toBe("observation_ambiguous");
  expect(webExecutionFailureFields(new Error("ChatGPT conversation changed during the active Web turn")).reason_class).toBe("conversation_changed");
  expect(webExecutionFailureFields(new Error("ChatGPT accepted user identity changed during the active Web turn")).reason_class).toBe("accepted_user_changed");
  expect(webExecutionFailureFields(new Error("ChatGPT assistant parent does not prove the accepted request identity")).reason_class).toBe("assistant_parent_unproven");
  expect(webExecutionFailureFields(new Error("ChatGPT renderer rekey does not prove the accepted request identity")).reason_class).toBe("renderer_rekey_unproven");
  expect(webExecutionFailureFields(new Error("retained ChatGPT conversation no longer contains its committed answer")).reason_class).toBe("retained_answer_mismatch");
  const owner = new AbortController(); owner.abort(new Error("Native turn terminated"));
  expect(webExecutionFailureFields(new DOMException("wait aborted", "AbortError"), owner.signal))
    .toEqual({ reason_class: "aborted", owner_aborted: true, abort_reason_class: "native_terminated" });
});

test("untrusted exception prose never becomes routine diagnostic data", () => {
  const error = new Error("private@example.invalid /private/file Bearer sensitive-value");
  error.name = "private-name";
  expect(webExecutionFailureFields(error)).toEqual({ reason_class: "unclassified", owner_aborted: false, abort_reason_class: "none" });
  expect(webExecutionFailureFields("private non-error").reason_class).toBe("non_error");
});
