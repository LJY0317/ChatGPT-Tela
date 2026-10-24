import { expect, test } from "bun:test";
import { NativeHistoryBootstrapRequired } from "@chatgpt-tela/codex";
import { classifyWebPreparationErrorKind, classifyWebPreparationFailure } from "./web-preparation-diagnostics";
test("preparation exception shape is reduced to a closed structural category", () => {
  expect(classifyWebPreparationErrorKind(new TypeError("private details"))).toBe("type_error");
  expect(classifyWebPreparationErrorKind(Object.assign(new Error("private details"), { code: "PRIVATE_CODE" }))).toBe("coded_error");
  expect(classifyWebPreparationErrorKind(new Error("private details"))).toBe("error");
  expect(classifyWebPreparationErrorKind({ name: "TypeError", message: "private details" })).toBe("non_error");
});
test("preparation diagnostics classify known boundaries without returning arbitrary exception prose", () => {
  expect(classifyWebPreparationFailure(new NativeHistoryBootstrapRequired())).toBe("history_bootstrap_required");
  expect(classifyWebPreparationFailure(new NativeHistoryBootstrapRequired("unindexed_history")))
    .toBe("history_mode_unindexed");
  const futureWording=Object.assign(new Error("private future wording; no original bytes available"), {
    code:"native_history_bootstrap_required",
  });
  expect(classifyWebPreparationFailure(futureWording)).toBe("history_bootstrap_required");
  expect(classifyWebPreparationFailure(new Error("Native public paginated history is unavailable; full history was not fetched"))).toBe("history_paging_unavailable");
  expect(classifyWebPreparationFailure(new Error("Native compaction history includes unsupported user content"))).toBe("history_user_format_unsupported");
  expect(classifyWebPreparationFailure(new Error("Native input_image content is not supported by the development Web planner yet"))).toBe("request_attachment_unsupported");
  expect(classifyWebPreparationFailure(new Error("Native Web attachment source is not proven inline bytes"))).toBe("request_media_source_unavailable");
  expect(classifyWebPreparationFailure(new Error("Native Web attachment MIME is unsupported"))).toBe("request_media_format_unsupported");
  expect(classifyWebPreparationFailure(new Error("Web media lacks exact Native evidence and physical revision ownership"))).toBe("request_media_owner_unproven");
  expect(classifyWebPreparationFailure(new Error("private user /path secret"))).toBe("unclassified");
  expect(classifyWebPreparationFailure({message:"Native compaction history includes unsupported user content"})).toBe("unclassified");
  expect(classifyWebPreparationFailure(new Error("toString"))).toBe("unclassified");
});


test("typed projection failure is classified without exposing private exception text", () => {
  const error = Object.assign(new Error("PRIVATE message"), { code: "native_projection_unsupported" });
  expect(classifyWebPreparationFailure(error)).toBe("request_projection_unsupported");
  for (const [projectionKind, expected] of [
    ["agent_message_shape", "request_projection_agent_message_shape"],
    ["agent_content_part", "request_projection_agent_content_part"],
    ["input_item_shape", "request_projection_input_item_shape"],
    ["input_item_type", "request_projection_input_item_type"],
    ["input_container", "request_projection_input_container"],
  ] as const) {
    expect(classifyWebPreparationFailure(Object.assign(new Error("PRIVATE body"), {
      code: "native_projection_unsupported", projectionKind,
    }))).toBe(expected);
  }
  expect(classifyWebPreparationFailure(Object.assign(new Error("PRIVATE body"), {
    code: "native_projection_unsupported", projectionKind: "private-raw-type",
  }))).toBe("request_projection_unsupported");
});

test('fit classification uses a closed typed boundary rather than private exception prose',async()=>{
 const {WebContextFitFailed,WEB_CONTEXT_FIT_REASONS}=await import('@chatgpt-tela/core');
 for(const reason of WEB_CONTEXT_FIT_REASONS) expect(classifyWebPreparationFailure(new WebContextFitFailed(reason))).toBe(reason);
 expect(classifyWebPreparationFailure(Object.assign(new Error('private'),{code:'web_context_fit_failed',reason:'private-path'}))).toBe('unclassified');
});
