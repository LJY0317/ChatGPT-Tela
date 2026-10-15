import type {
  NativeGatewayOutcome,
  NativeResponsesGateway,
} from "@chatgpt-tela/runtime";
import {
  encodeNativeResponsesOutcome,
  nativeResponsesSsePlan,
} from "./protocol";
import { NativeProgressStream } from "./live-progress";
import { nativeHistoryRecovery } from "./native-history-recovery";
import { nativeProjectionRecovery } from "./native-projection-recovery";

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

function committedBody(input: {
  readonly chunks: readonly string[];
  readonly commitAfterChunk: number;
  readonly commit: () => void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  let committed = false;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= input.chunks.length) {
        controller.close();
        return;
      }
      const current = index;
      controller.enqueue(encoder.encode(input.chunks[index++]!));
      if (!committed && current === input.commitAfterChunk) {
        input.commit();
        committed = true;
      }
      if (index >= input.chunks.length) controller.close();
    },
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
    return new Response(committedBody({
      chunks: [json],
      commitAfterChunk: 0,
      commit: () => input.gateway.commit(input.outcome),
    }), {
      headers: { "content-type": "application/json" },
    });
  }

  const plan = nativeResponsesSsePlan(input.outcome, encoded);
  return new Response(committedBody({
    chunks: plan.frames,
    commitAfterChunk: plan.commitAfterFrame,
    commit: () => input.gateway.commit(input.outcome),
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
    const pending = gateway.handle(body, progress ? { onProgress: progress.progress, signal: progress.signal.signal } : undefined);
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
    const projectionRecovery = nativeProjectionRecovery(error);
    if (projectionRecovery) return Response.json({ error: projectionRecovery }, { status: 400 });
    // A bounded Native-history bootstrap is a recoverable *context* limit,
    // not a transient network outage. Do not turn it into an opaque 409 or
    // replay the already-retired Native turn. No private exception payloads
    // or historical text are returned to the caller.
    const historyRecovery = nativeHistoryRecovery(error);
    if (historyRecovery) {
      // Keep the HTTP and already-started SSE recovery decisions identical;
      // neither transport may repeat a private Native exception.
      return Response.json({
        error: {
          type: "tela_context_recovery_required",
          ...historyRecovery,
        },
      }, { status: 422 });
    }
    if (record(error)?.code === "tela_native_turn_already_retired") {
      // Native retries UnexpectedStatus (409) but treats InvalidRequest (400) as terminal.
      return Response.json({
        error: {
          type: "invalid_request_error",
          code: "tela_native_turn_already_retired",
          retryable: false,
          message: "This Native turn is already retired. Repeating it cannot recover missing history. Continue with a new, explicitly authorized Native turn and a verified checkpoint or handoff.",
          recovery: {
            kind: "authorized_native_continuation",
            requires_user_action: true,
            requires_new_native_turn: true,
            requires_new_conversation: false,
            reuse_verified_context_first: true,
            prior_execution_settled: "unknown",
          },
        },
      }, { status: 400 });
    }
    if (record(error)?.code === "tela_native_response_cycle_conflict") {
      return Response.json({ error: { type: "chatgpt_tela_runtime_error",
        code: "tela_native_response_cycle_conflict", retryable: false,
        message: error instanceof Error ? error.message : "Native response cycle ownership was not proven",
      } }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({
      error: {
        type: "chatgpt_tela_runtime_error",
        // Only this Tela-owned semantic failure may invalidate a Web catalog across HTTP.
        ...(record(error)?.code === "tela_web_model_unavailable" ? { code: "tela_web_model_unavailable" } : {}),
        message,
      },
    }, { status: 409 });
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
}): Response {
  if (!input.summary.trim() || !input.operationId.trim()) throw new Error("Native summary response is empty");
  const outcome: NativeGatewayOutcome = {
    type: "final", answer: input.summary, delivery: { capability: `compaction-${input.operationId}` },
  };
  const encoded = encodeNativeResponsesOutcome({ outcome, model: input.model });
  if (!input.stream) return Response.json(encoded.response);
  const plan = nativeResponsesSsePlan(outcome, encoded);
  return new Response(plan.frames.join(""), { headers: { "content-type": "text/event-stream" } });
}
