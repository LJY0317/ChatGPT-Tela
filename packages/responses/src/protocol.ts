import { createHash } from "node:crypto";
import type { NativeGatewayOutcome } from "@chatgpt-tela/runtime";

type ResponseOutputItem = Readonly<Record<string, unknown>>;

export interface NativeResponsesEnvelope {
  readonly id: string;
  readonly object: "response";
  readonly created_at: number;
  readonly status: "in_progress" | "completed";
  readonly model: string;
  readonly output: readonly ResponseOutputItem[];
  readonly usage: null;
}

export interface EncodedNativeResponsesOutcome {
  readonly response: NativeResponsesEnvelope;
  readonly outputItem: ResponseOutputItem;
  readonly responseId: string;
  readonly outputItemId: string;
}

function stableId(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("base64url").slice(0, 24);
  return `${prefix}_${digest}`;
}

function deliveryKey(outcome: NativeGatewayOutcome): string {
  return outcome.type === "tool-call"
    ? `${outcome.delivery.capability}\u0000tool\u0000${outcome.delivery.callId}`
    : `${outcome.delivery.capability}\u0000final`;
}

function completedToolItem(outcome: Extract<NativeGatewayOutcome, { type: "tool-call" }>, id: string): ResponseOutputItem {
  const item = outcome.item;
  if (item.type === "function_call") {
    return Object.freeze({
      type: item.type,
      id,
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
      status: "completed",
      ...(item.namespace ? { namespace: item.namespace } : {}),
    });
  }
  if (item.type === "custom_tool_call") {
    return Object.freeze({
      type: item.type,
      id,
      call_id: item.call_id,
      name: item.name,
      input: item.input,
      status: "completed",
    });
  }
  return Object.freeze({
    type: item.type,
    id,
    call_id: item.call_id,
    execution: "client",
    arguments: item.arguments,
    status: "completed",
  });
}

function completedMessageItem(outcome: Extract<NativeGatewayOutcome, { type: "final" }>, id: string): ResponseOutputItem {
  return Object.freeze({
    type: "message",
    id,
    status: "completed",
    role: "assistant",
    content: Object.freeze([Object.freeze({
      type: "output_text",
      text: outcome.answer,
      annotations: Object.freeze([]),
    })]),
  });
}

export function encodeNativeResponsesOutcome(input: {
  readonly outcome: NativeGatewayOutcome;
  readonly model: string;
  readonly createdAt?: number;
}): EncodedNativeResponsesOutcome {
  if (!input.model.trim()) throw new Error("Native Responses model must be non-empty");
  const key = deliveryKey(input.outcome);
  const responseId = stableId("resp", key);
  const outputItemId = stableId(
    input.outcome.type === "final"
      ? "msg"
      : input.outcome.item.type === "function_call"
        ? "fc"
        : input.outcome.item.type === "custom_tool_call"
          ? "ctc"
          : "tsc",
    key,
  );
  const outputItem = input.outcome.type === "tool-call"
    ? completedToolItem(input.outcome, outputItemId)
    : completedMessageItem(input.outcome, outputItemId);
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error("Native Responses createdAt must be a non-negative safe integer");
  }
  const response = Object.freeze({
    id: responseId,
    object: "response" as const,
    created_at: createdAt,
    status: "completed" as const,
    model: input.model,
    output: Object.freeze([outputItem]),
    usage: null,
  });
  return Object.freeze({ response, outputItem, responseId, outputItemId });
}

function sse(name: string, payload: Readonly<Record<string, unknown>>): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`;
}

function inProgressResponse(encoded: EncodedNativeResponsesOutcome): NativeResponsesEnvelope {
  return Object.freeze({
    ...encoded.response,
    status: "in_progress" as const,
    output: Object.freeze([]),
  });
}

function inProgressItem(encoded: EncodedNativeResponsesOutcome): ResponseOutputItem {
  const item = encoded.outputItem;
  if (item.type === "message") {
    return Object.freeze({
      type: "message",
      id: encoded.outputItemId,
      status: "in_progress",
      role: "assistant",
      content: Object.freeze([]),
    });
  }
  return Object.freeze({ ...item, status: "in_progress" });
}

export interface NativeResponsesSsePlan {
  readonly frames: readonly string[];
  /** Frame index after which enough side-effect identity has been exposed to fail closed on retry. */
  readonly commitAfterFrame: number;
}

export function nativeResponsesSsePlan(
  outcome: NativeGatewayOutcome,
  encoded: EncodedNativeResponsesOutcome,
): NativeResponsesSsePlan {
  let sequence = 0;
  const event = (name: string, payload: Readonly<Record<string, unknown>>) => (
    sse(name, { sequence_number: sequence++, ...payload })
  );
  const frames: string[] = [event("response.created", { response: inProgressResponse(encoded) })];

  if (outcome.type === "tool-call") {
    frames.push(event("response.output_item.added", {
      output_index: 0,
      item: inProgressItem(encoded),
    }));
    const item = outcome.item;
    if (item.type === "function_call") {
      frames.push(event("response.function_call_arguments.done", {
        item_id: encoded.outputItemId,
        output_index: 0,
        arguments: item.arguments,
      }));
    } else if (item.type === "custom_tool_call") {
      frames.push(event("response.custom_tool_call_input.done", {
        item_id: encoded.outputItemId,
        output_index: 0,
        input: item.input,
      }));
    }
    frames.push(event("response.output_item.done", {
      output_index: 0,
      item: encoded.outputItem,
    }));
    frames.push(event("response.completed", { response: encoded.response }));
    frames.push("data: [DONE]\n\n");
    // output_item.added is the first frame that exposes the exact call identity. Once handed to the
    // transport, a retry must not cause the same local tool to execute again.
    return Object.freeze({ frames: Object.freeze(frames), commitAfterFrame: 1 });
  }

  const contentPart = Object.freeze({ type: "output_text", text: "", annotations: Object.freeze([]) });
  const donePart = Object.freeze({
    type: "output_text",
    text: outcome.answer,
    annotations: Object.freeze([]),
  });
  frames.push(event("response.output_item.added", {
    output_index: 0,
    item: inProgressItem(encoded),
  }));
  frames.push(event("response.content_part.added", {
    item_id: encoded.outputItemId,
    output_index: 0,
    content_index: 0,
    part: contentPart,
  }));
  if (outcome.answer.length > 0) {
    frames.push(event("response.output_text.delta", {
      item_id: encoded.outputItemId,
      output_index: 0,
      content_index: 0,
      delta: outcome.answer,
    }));
  }
  frames.push(event("response.output_text.done", {
    item_id: encoded.outputItemId,
    output_index: 0,
    content_index: 0,
    text: outcome.answer,
  }));
  frames.push(event("response.content_part.done", {
    item_id: encoded.outputItemId,
    output_index: 0,
    content_index: 0,
    part: donePart,
  }));
  frames.push(event("response.output_item.done", {
    output_index: 0,
    item: encoded.outputItem,
  }));
  frames.push(event("response.completed", { response: encoded.response }));
  frames.push("data: [DONE]\n\n");
  // Final answers are replay-safe until the complete response snapshot has been handed off.
  return Object.freeze({ frames: Object.freeze(frames), commitAfterFrame: frames.length - 2 });
}
