import type {
  NativeGatewayOutcome,
  NativeResponsesGateway,
} from "@chatgpt-tela/runtime";
import {
  encodeNativeResponsesOutcome,
  nativeResponsesSsePlan,
} from "./protocol";

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
  try {
    outcome = await gateway.handle(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({
      error: {
        type: "chatgpt_tela_runtime_error",
        message,
      },
    }, { status: 409 });
  }

  const now = options.now?.() ?? Date.now();
  const createdAt = Math.floor(now / 1000);
  return responseForOutcome({
    outcome,
    gateway,
    model: body.model,
    stream: body.stream === true,
    createdAt,
  });
}
