import { nativeFailure } from "./native-failure";
import { diagnosticContext, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";
import type {
  NativeGatewayOutcome,
  NativeResponsesGateway,
} from "@chatgpt-tela/runtime";
import {
  encodeNativeResponsesOutcome,
  nativeResponsesSsePlan,
} from "./protocol";
import { NativeProgressStream } from "./live-progress";
import { encodeTelaCompactionSummary } from "@chatgpt-tela/codex";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorResponse(status: number, message: string): Response {
  return Response.json({
    error: {
      type: "invalid_request_error",
      message,
    },
  }, { status });
}

function observedBody(input: {
  readonly chunks: readonly string[];
  readonly commitAfterChunk?: number;
  readonly commit?: () => void;
  readonly outcome: NativeGatewayOutcome["type"] | "failed";
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  let committed = false;
  const diagnostics = diagnosticContext();
  const closed = (reason: string) => withDiagnosticContext(diagnostics, () =>
    emitDiagnosticEvent("chatgpt_tela_work", "native_response_body_closed", {
      reason_class: reason, outcome: input.outcome, outcome_committed: committed,
      pulled_frame_count: index, queued_frame_count: input.chunks.length - index,
      delivery: "http_body_consumer", ui_observed: false,
    }));

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        if (index >= input.chunks.length) {
          closed("drained");
          controller.close();
          return;
        }
        const current = index;
        controller.enqueue(encoder.encode(input.chunks[index++]!));
        if (!committed && input.commit && current === input.commitAfterChunk) {
          input.commit();
          committed = true;
        }
        if (index >= input.chunks.length) { closed("drained"); controller.close(); }
      } catch (error) { closed("failed"); throw error; }
    },
    cancel() { closed("consumer_cancelled"); },
  }, { highWaterMark: 0 });
}

function responseForOutcome(input: {
  readonly outcome: NativeGatewayOutcome;
  readonly gateway: NativeResponsesGateway;
  readonly model: string;
  readonly stream: boolean;
  readonly createdAt: number;
}): Response {
  const encoded = encodeNativeResponsesOutcome({
    outcome: input.outcome,
    model: input.model,
    createdAt: input.createdAt,
  });
  if (!input.stream) {
    const json = `${JSON.stringify(encoded.response)}\n`;
    return new Response(observedBody({
      chunks: [json],
      commitAfterChunk: 0,
      commit: () => input.gateway.commit(input.outcome),
      outcome: input.outcome.type,
    }), {
      headers: { "content-type": "application/json" },
    });
  }

  const plan = nativeResponsesSsePlan(input.outcome, encoded);
  return new Response(observedBody({
    chunks: plan.frames,
    commitAfterChunk: plan.commitAfterFrame,
    commit: () => input.gateway.commit(input.outcome),
    outcome: input.outcome.type,
  }), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/**
 * Fetch-compatible `/responses` boundary for the currently proven ChatGPT Tela protocol subset.
 * Transport parsing/serialization stays outside the Native authority and runtime state machines.
 */
export async function handleNativeResponsesHttp(
  request: Request,
  gateway: NativeResponsesGateway,
  options: { readonly now?: () => number } = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Native Responses request body must be valid JSON");
  }
  const body = record(raw);
  if (!body) return errorResponse(400, "Native Responses request body must be an object");
  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    return errorResponse(400, "Native Responses request requires a model");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return errorResponse(400, "Native Responses stream must be a boolean");
  }

  let outcome: NativeGatewayOutcome;
  const createdAt = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const progress = body.stream === true ? new NativeProgressStream(body.model, createdAt) : undefined;
  try {
    const pending = gateway.handle(body, {
      ...(progress ? { onProgress: progress.progress } : {}),
      signal: progress ? AbortSignal.any([request.signal, progress.signal.signal]) : request.signal,
    });
    if (progress) {
      const first = await Promise.race([pending.then(value => ({ value })), progress.firstProgress.then(() => null)]);
      if (first === null) {
        void pending.then(value => progress.finish(value, gateway), error => progress.fail(error))
          .catch(error => progress.fail(error));
        return progress.response();
      }
      outcome = first.value;
      progress.signal.abort();
    } else outcome = await pending;
  } catch (error) {
    // A late SSE failure already committed HTTP 200; a subsequent replay
    // returns the same public cause as a terminal HTTP 400 without re-execution.
    return new Response(observedBody({
      chunks: [JSON.stringify({ error: nativeFailure(error).error })], outcome: "failed",
    }), { status: 400, headers: { "content-type": "application/json" } });
  }

  return responseForOutcome({
    outcome,
    gateway,
    model: body.model,
    stream: body.stream === true,
    createdAt,
  });
}

/** Tool-free summary response. Native commits its own local compaction after complete receipt. */
export function nativeCompactionSummaryResponse(input: {
  readonly summary: string;
  readonly operationId: string;
  readonly model: string;
  readonly stream: boolean;
  readonly remote?: boolean;
}): Response {
  if (!input.summary.trim() || !input.operationId.trim()) throw new Error("Native summary response is empty");
  const outcome: NativeGatewayOutcome = {
    type: "final", answer: input.summary, delivery: { capability: `compaction-${input.operationId}` },
  };
  const encoded = encodeNativeResponsesOutcome({ outcome, model: input.model });
  if (input.remote) {
    const item = { type: "compaction", id: encoded.outputItemId,
      encrypted_content: encodeTelaCompactionSummary(input.summary) };
    const response = { ...encoded.response, output: [item] };
    if (!input.stream) return Response.json(response);
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    const wire = events.map((event, sequence_number) =>
      `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
    return new Response(wire + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }
  if (!input.stream) return Response.json(encoded.response);
  const plan = nativeResponsesSsePlan(outcome, encoded);
  return new Response(plan.frames.join(""), { headers: { "content-type": "text/event-stream" } });
}
