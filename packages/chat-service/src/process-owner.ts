import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { startWebHttpServer } from "@chatgpt-tela/http-host";

const MAX_BODY_BYTES = 72 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_IN_FLIGHT = 16;
const MAX_WRITES = 256;

export interface ProcessOwnerBinding {
  readonly ownerId: string;
  readonly operationId: string;
  readonly workspaceId: string;
}
export interface ProcessOwnerDescriptor extends ProcessOwnerBinding {
  readonly version: 1;
  readonly endpoint: string;
  readonly secret: string;
}
export type ProcessOwnerAction = "status" | "wait" | "stdin" | "cancel";
export interface ProcessOwnerRequest {
  readonly action: ProcessOwnerAction;
  readonly requestId?: string;
  readonly chars?: string;
  readonly yieldTimeMs?: number;
}
export interface ProcessOwnerAuthority {
  status(): unknown;
  wait(yieldTimeMs: number, observationSignal: AbortSignal): Promise<unknown>;
  write(chars: string): void;
  /** Supply only when the adapter can terminate its proven owned execution tree. */
  cancelOwnedExecution?(): Promise<unknown>;
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function signature(secret: string, body: string, direction: "request" | "response"): string {
  return createHmac("sha256", secret).update(`tela-process-owner-${direction}-v1\0`).update(body).digest("hex");
}
function validBinding(binding: ProcessOwnerBinding): void {
  for (const value of [binding.ownerId, binding.operationId, binding.workspaceId]) {
    if (typeof value !== "string" || !value || value.length > 256 || /[\u0000\r\n]/.test(value)) throw new Error("invalid process owner binding");
  }
}
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("process owner response is missing");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("process owner response exceeds its bound");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Operation-scoped IPC only. It starts no command, grants no folder permission and polls nothing. */
export async function startProcessOwnerControl(input: {
  readonly binding: ProcessOwnerBinding;
  readonly secret: string;
  readonly authority: ProcessOwnerAuthority;
}) {
  validBinding(input.binding);
  if (!/^[a-f0-9]{64}$/.test(input.secret)) throw new Error("invalid process owner secret");
  let inFlight = 0;
  let closing = false;
  const pendingResponses = new Set<Promise<void>>();
  const writes = new Set<string>();
  let cancellation: Promise<unknown> | undefined;
  const server = await startWebHttpServer({ hostname: "127.0.0.1", port: 0, maxRequestBodyBytes: MAX_BODY_BYTES,
    async fetch(request, lifecycle) {
      if (closing) return new Response(null, { status: 503 });
      if (request.headers.has("origin")) return new Response(null, { status: 403 });
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/operation") return new Response(null, { status: 404 });
      if (inFlight >= MAX_IN_FLIGHT) return new Response(null, { status: 429 });
      inFlight++;
      let finish!: () => void;
      const delivered = new Promise<void>(resolve => { finish = resolve; });
      pendingResponses.add(delivered);
      let settled = false;
      const responseFinished = () => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener("abort", responseFinished);
        pendingResponses.delete(delivered);
        inFlight--;
        finish();
      };
      lifecycle.afterResponse(responseFinished);
      request.signal.addEventListener("abort", responseFinished, { once: true });
      if (request.signal.aborted) responseFinished();
      try {
        const text = await request.text();
        if (!same(request.headers.get("x-tela-owner-request-signature") ?? "", signature(input.secret, text, "request"))) {
          return new Response(null, { status: 401 });
        }
        const body = JSON.parse(text) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body) || body.version !== 1
          || body.ownerId !== input.binding.ownerId || body.operationId !== input.binding.operationId
          || body.workspaceId !== input.binding.workspaceId) return new Response(null, { status: 409 });
        if (typeof body.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.requestId)) return new Response(null, { status: 400 });
        let result: unknown;
        switch (body.action) {
          case "status": result = input.authority.status(); break;
          case "wait": {
            const duration = body.yieldTimeMs ?? 0;
            if (!Number.isSafeInteger(duration) || (duration as number) < 0 || (duration as number) > 12_000) return new Response(null, { status: 400 });
            // A disconnected waiter must never imply execution cancellation.
            result = await input.authority.wait(duration as number, request.signal);
            break;
          }
          case "stdin":
            if (typeof body.chars !== "string" || Buffer.byteLength(body.chars, "utf8") > 64 * 1024) return new Response(null, { status: 400 });
            if (writes.has(body.requestId) || writes.size >= MAX_WRITES) return new Response(null, { status: 409 });
            writes.add(body.requestId); // Reserve before a possibly accepted write; never retry uncertain input.
            input.authority.write(body.chars);
            result = input.authority.status();
            break;
          case "cancel":
            if (!input.authority.cancelOwnedExecution) return new Response(null, { status: 409 });
            cancellation ??= Promise.resolve().then(() => input.authority.cancelOwnedExecution!());
            result = await cancellation;
            break;
          default: return new Response(null, { status: 400 });
        }
        const response = JSON.stringify({ version: 1, ...input.binding, requestId: body.requestId, result });
        if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) return new Response(null, { status: 413 });
        return new Response(response, { headers: { "content-type": "application/json", "x-tela-owner-signature": signature(input.secret, response, "response") } });
      } catch { return new Response(null, { status: 409 }); }
    },
  });
  const descriptor: ProcessOwnerDescriptor = Object.freeze({ version: 1, ...input.binding,
    endpoint: `http://127.0.0.1:${server.port}/v1/operation`, secret: input.secret });
  let stopping: Promise<void> | undefined;
  return Object.freeze({ descriptor, close() {
    closing = true;
    // Deliver admitted terminal observations before tearing down their transport.
    stopping ??= Promise.all([...pendingResponses]).then(() => server.stop());
    return stopping;
  } });
}

export function validateProcessOwnerDescriptor(descriptor: ProcessOwnerDescriptor): URL {
  validBinding(descriptor);
  const url = new URL(descriptor.endpoint);
  if (descriptor.version !== 1 || !/^[a-f0-9]{64}$/.test(descriptor.secret) || url.protocol !== "http:"
    || url.hostname !== "127.0.0.1" || url.pathname !== "/v1/operation" || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid process owner descriptor");
  }
  return url;
}

/** One attempt only; uncertain mutating calls require observation rather than automatic replay. */
export async function callProcessOwner(descriptor: ProcessOwnerDescriptor, input: ProcessOwnerRequest, signal?: AbortSignal): Promise<unknown> {
  const url = validateProcessOwnerDescriptor(descriptor);
  const requestId = input.requestId ?? randomUUID();
  const body = JSON.stringify({ ...input, version: 1, ownerId: descriptor.ownerId, operationId: descriptor.operationId,
    workspaceId: descriptor.workspaceId, requestId });
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("process owner request exceeds its bound");
  const response = await fetch(url, { method: "POST", redirect: "error", headers: { "x-tela-owner-request-signature": signature(descriptor.secret, body, "request"),
    "content-type": "application/json" }, body, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`process owner refused request (${response.status})`);
  const text = await boundedText(response);
  if (!same(response.headers.get("x-tela-owner-signature") ?? "", signature(descriptor.secret, text, "response"))) throw new Error("process owner response authentication failed");
  const record = JSON.parse(text) as Record<string, unknown>;
  if (record.version !== 1 || record.ownerId !== descriptor.ownerId || record.operationId !== descriptor.operationId
    || record.workspaceId !== descriptor.workspaceId || record.requestId !== requestId) throw new Error("process owner response binding mismatch");
  return record.result;
}
