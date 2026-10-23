import { createHash } from "node:crypto";
import { diagnosticFingerprint } from "@chatgpt-tela/core";

const KNOWN_TYPES = new Set([
  "message", "agent_message", "function_call", "function_call_output", "custom_tool_call",
  "custom_tool_call_output", "tool_search_call", "tool_search_output", "mcp_tool_call_output",
  "context_compaction", "compaction", "compaction_summary", "reasoning", "additional_tools",
]);
const QUESTION_TOOL = "request_user_input";
const KNOWN_PART_TYPES = new Set([
  "input_text", "output_text", "text", "input_image", "input_file", "image", "file",
  "resource", "resource_link", "audio", "input_audio", "encrypted_content",
]);
const QUESTION_NAMES = new Set([QUESTION_TOOL, "functions.request_user_input",
  "request_user_input_async", "functions.request_user_input_async"]);

type Scalar = string | number | boolean;
export type NativeProjectionEvidence = Readonly<Record<string, Scalar>>;
export type NativeProjectionError = Error & {
  readonly projectionKind?: string;
  readonly projectionEvidence?: NativeProjectionEvidence;
  readonly projectionPrivateShape?: Readonly<Record<string, unknown>>;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function shape(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "record";
  if (typeof value === "string") return "string";
  return "scalar";
}

function safeFingerprint(value: string): string {
  // Arbitrary Native type names are never emitted and never sent to a log unbounded.
  return diagnosticFingerprint(createHash("sha256").update(value).digest("hex"));
}

function typeClass(value: unknown, known: Set<string>): string {
  if (value === undefined) return "absent";
  if (typeof value !== "string") return "invalid";
  return known.has(value) ? value : "unknown";
}

function questionEvidence(items: readonly unknown[]): { question_call_count: number;
  question_answer_count: number; question_relation: string; question_item_count: number } {
  const callIds = new Set<string>();
  let callCount = 0, questionItemCount = 0, answerCount = 0;
  for (const raw of items) {
    const item = object(raw);
    if (!item) continue;
    if (QUESTION_NAMES.has(String(item.type))) questionItemCount++;
    if (!QUESTION_NAMES.has(String(item.name))) continue;
    questionItemCount++;
    if (!["function_call", "custom_tool_call", "tool_search_call"].includes(String(item.type))) continue;
    callCount++;
    if (typeof item.call_id === "string") callIds.add(item.call_id);
  }
  for (const raw of items) {
    const item = object(raw);
    if (item && ["function_call_output", "custom_tool_call_output", "mcp_tool_call_output",
      "tool_search_output"].includes(String(item.type))
      && typeof item.call_id === "string" && callIds.has(item.call_id)) answerCount++;
  }
  return {
    question_call_count: callCount, question_answer_count: answerCount,
    question_relation: questionItemCount === 0 ? "absent"
      : answerCount ? "matched" : callCount ? "call_only" : "item_only",
    question_item_count: questionItemCount,
  };
}

/** Failure-only structure; no user text, tool arguments, or arbitrary type names cross the log boundary. */
export function nativeProjectionFailureFields(input: unknown, index?: number, partIndex?: number): NativeProjectionEvidence {
  const items = Array.isArray(input) ? input : undefined;
  const item = index === undefined ? undefined : object(items?.[index]);
  const type = item?.type;
  const known = typeof type === "string" && KNOWN_TYPES.has(type);
  const content = item?.content;
  const partValue = Array.isArray(content) && partIndex !== undefined ? content[partIndex] : undefined;
  const part = object(partValue);
  const partType = part?.type;
  const knownPart = typeof partType === "string" && KNOWN_PART_TYPES.has(partType);
  return {
    input_item_count: items?.length ?? 0,
    ...(index === undefined ? {} : { input_item_index: index }),
    ...(partIndex === undefined ? {} : { input_part_index: partIndex }),
    input_container_kind: shape(input),
    input_item_kind: index === undefined ? "none" : shape(items?.[index]),
    input_type_class: typeClass(type, KNOWN_TYPES),
    ...(typeof type === "string" && !known ? { input_type_fingerprint: safeFingerprint(type) } : {}),
    ...(item ? { input_field_count: Object.keys(item).length,
      input_fields_fingerprint: safeFingerprint(Object.keys(item).sort().join("\0")) } : {}),
    input_role_kind: ["system", "developer", "user", "assistant"].includes(String(item?.role)) ? item!.role as string
      : item?.role === undefined ? "absent" : "other",
    input_role_present: item ? Object.hasOwn(item, "role") : false,
    input_body_present: item ? Object.hasOwn(item, "content") : false,
    input_body_kind: shape(content),
    input_author_present: typeof item?.author === "string" && !!item.author.trim(),
    input_recipient_present: typeof item?.recipient === "string" && !!item.recipient.trim(),
    ...(Array.isArray(content) ? { input_part_count: content.length } : {}),
    ...(partIndex === undefined ? {} : {
      input_part_kind: shape(partValue),
      input_part_type_class: typeClass(partType, KNOWN_PART_TYPES),
      input_part_text_present: typeof part?.text === "string",
      ...(part ? { input_part_field_count: Object.keys(part).length,
        input_part_fields_fingerprint: safeFingerprint(Object.keys(part).sort().join("\0")) } : {}),
      ...(typeof partType === "string" && !knownPart ? { input_part_type_fingerprint: safeFingerprint(partType) } : {}),
    }),
    ...questionEvidence(items ?? []),
  };
}

/** Private-local diagnostic stores a bounded *shape* only, never request parts or their values. */
export function nativeProjectionPrivateShape(input: unknown, index?: number, partIndex?: number) {
  const items = Array.isArray(input) ? input : undefined;
  const item = object(index === undefined ? undefined : items?.[index]);
  const part = object(Array.isArray(item?.content) && partIndex !== undefined ? item.content[partIndex] : undefined);
  const boundedKeys = (value: Record<string, unknown> | undefined) =>
    value ? Object.keys(value).sort().slice(0, 24).map(key => key.slice(0, 80)) : [];
  const boundedType = (value: unknown) =>
    typeof value === "string" ? value.slice(0, 128) : undefined;
  return { item_type: boundedType(item?.type), item_keys: boundedKeys(item),
    part_type: boundedType(part?.type), part_keys: boundedKeys(part) };
}

export function annotateNativeProjectionFailure(error: unknown, input: unknown, index?: number, partIndex?: number): unknown {
  if (!(error instanceof Error)) return error;
  const annotated = error as NativeProjectionError;
  if (annotated.projectionEvidence) return error;
  try {
    Object.assign(annotated, {
      projectionEvidence: nativeProjectionFailureFields(input, index, partIndex),
      projectionPrivateShape: nativeProjectionPrivateShape(input, index, partIndex),
    });
  } catch { /* Telemetry cannot change the primary projection failure. */ }
  return error;
}

/** Request fingerprint is computed only on failure; bytes are never persisted. */
export function failedNativeRequestFingerprint(request: unknown): string | undefined {
  try {
    const value = JSON.stringify(request);
    return value === undefined ? undefined : safeFingerprint(value);
  } catch { return undefined; }
}
