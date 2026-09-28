import {
  transitionTurn,
  type NativeToolCatalogEntry,
  type NativeToolInvocation,
  type NativeToolResult,
  type TurnPhase,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";

interface PendingTool {
  readonly invocation: NativeToolInvocation;
  readonly resolve: (result: NativeToolResult) => void;
  readonly reject: (error: Error) => void;
  nativeDelivery: "queued" | "delivered";
  result?: NativeToolResult;
}

interface ToolWaiter {
  readonly resolve: (invocation: NativeToolInvocation) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

interface StateWaiter {
  readonly afterRevision: number;
  readonly resolve: (state: RuntimeTurnState) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

export interface RuntimeTurnState {
  readonly revision: number;
  readonly phase: TurnPhase;
  readonly toolRoundCount: number;
  readonly outstandingToolCallId?: string;
  readonly outstandingNativeDelivery?: "queued" | "delivered";
  readonly nativeResultReady?: boolean;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("operation aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("operation aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function toolFor(binding: NativeTurnBinding, wireName: string): NativeToolCatalogEntry {
  const tool = binding.tools.exact(wireName);
  if (!tool) throw new Error(`native tool is not advertised for this turn: ${wireName}`);
  return tool;
}

function validateInvocation(
  binding: NativeTurnBinding,
  invocation: NativeToolInvocation,
): NativeToolCatalogEntry {
  if (!invocation.callId.trim()) throw new Error("native tool callId must be non-empty");
  const tool = toolFor(binding, invocation.wireName);
  if (tool.kind === "freeform") {
    if (invocation.mode !== "freeform") {
      throw new Error(`native freeform tool requires raw input: ${tool.wireName}`);
    }
    return tool;
  }
  if (tool.kind === "function" || tool.kind === "discovery" || tool.kind === "gateway") {
    if (invocation.mode !== "structured") {
      throw new Error(`native structured tool requires arguments: ${tool.wireName}`);
    }
    return tool;
  }
  throw new Error(`native tool semantics are not yet executable: ${tool.wireName}`);
}

/**
 * Event-driven causal channel for one exact bound Native turn.
 *
 * The Web/MCP side may request one native tool call at a time. The Native response side receives
 * that exact call, returns one result, and the Web side must then prove continuation before a
 * tool-bearing turn can complete. No timer, polling loop, or implicit resubmission exists here.
 */
export class RuntimeTurnChannel {
  #binding: NativeTurnBinding;
  #phase: TurnPhase = "prepared";
  #pendingTool: PendingTool | undefined;
  #toolWaiter: ToolWaiter | undefined;
  readonly #stateWaiters = new Set<StateWaiter>();
  readonly #usedCallIds = new Set<string>();
  readonly #finalPromise: Promise<string>;
  readonly #resolveFinal: (answer: string) => void;
  readonly #rejectFinal: (error: Error) => void;
  #settled = false;
  #toolRoundCount = 0;
  #stateRevision = 0;

  constructor(binding: NativeTurnBinding) {
    this.#binding = binding;
    let resolveFinal!: (answer: string) => void;
    let rejectFinal!: (error: Error) => void;
    this.#finalPromise = new Promise<string>((resolve, reject) => {
      resolveFinal = resolve;
      rejectFinal = reject;
    });
    // The Native response side may not attach its waiter until after a Web-side failure. Keep the
    // process free of transient unhandled-rejection noise while preserving rejection for every
    // later waitForFinal() caller.
    void this.#finalPromise.catch(() => {});
    this.#resolveFinal = resolveFinal;
    this.#rejectFinal = rejectFinal;
  }

  get binding(): NativeTurnBinding {
    return this.#binding;
  }

  get phase(): TurnPhase {
    return this.#phase;
  }

  get toolRoundCount(): number {
    return this.#toolRoundCount;
  }

  get stateRevision(): number {
    return this.#stateRevision;
  }

  get outstandingToolCallId(): string | undefined {
    return this.#pendingTool?.invocation.callId;
  }

  get outstandingNativeDelivery(): "queued" | "delivered" | undefined {
    return this.#pendingTool?.nativeDelivery;
  }

  state(): RuntimeTurnState {
    return Object.freeze({
      revision: this.#stateRevision,
      phase: this.#phase,
      toolRoundCount: this.#toolRoundCount,
      ...(this.#pendingTool ? {
        outstandingToolCallId: this.#pendingTool.invocation.callId,
        outstandingNativeDelivery: this.#pendingTool.nativeDelivery,
        nativeResultReady: this.#pendingTool.result !== undefined,
      } : {}),
    });
  }

  waitForStateChange(afterRevision: number, signal?: AbortSignal): Promise<RuntimeTurnState> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || afterRevision > this.#stateRevision) {
      return Promise.reject(new Error("turn state revision is invalid"));
    }
    if (this.#stateRevision > afterRevision) return Promise.resolve(this.state());
    if (this.#settled) return Promise.reject(new Error("turn is already settled"));
    if (signal?.aborted) return Promise.reject(new DOMException("turn state wait aborted", "AbortError"));

    return new Promise<RuntimeTurnState>((resolve, reject) => {
      const waiter: StateWaiter = {
        afterRevision,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        waiter.onAbort = () => {
          this.#stateWaiters.delete(waiter);
          reject(new DOMException("turn state wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#stateWaiters.add(waiter);
    });
  }

  /**
   * Replace request-scoped projections only after another canonically bound request proves the same
   * Native turn. This is how deferred tool discovery becomes visible without changing capability
   * identity or carrying a stale bridge-owned catalog forward.
   */
  refreshBinding(next: NativeTurnBinding): void {
    if (this.#pendingTool && !this.#pendingTool.result) {
      throw new Error("cannot refresh a turn binding while a native tool call is awaiting its result");
    }
    if (this.#settled) throw new Error("cannot refresh a settled turn binding");
    if (next.authority.threadId !== this.#binding.authority.threadId
      || next.authority.turnId !== this.#binding.authority.turnId) {
      throw new Error("refreshed binding does not belong to the active Native turn");
    }
    this.#binding = next;
  }

  markSubmitted(): void {
    this.#move("submitted");
  }

  markAccepted(): void {
    this.#move("accepted");
  }

  requestTool(invocation: NativeToolInvocation): Promise<NativeToolResult> {
    if (this.#phase !== "accepted"
      && this.#phase !== "continuing"
      && this.#phase !== "tool-result-delivered") {
      throw new Error(`cannot request a native tool from turn phase ${this.#phase}`);
    }
    if (this.#pendingTool) throw new Error("a native tool call is already outstanding for this turn");
    if (this.#usedCallIds.has(invocation.callId)) {
      throw new Error(`native tool callId was already used: ${invocation.callId}`);
    }
    validateInvocation(this.binding, invocation);

    this.#usedCallIds.add(invocation.callId);
    this.#toolRoundCount += 1;

    const result = new Promise<NativeToolResult>((resolve, reject) => {
      this.#pendingTool = {
        invocation: Object.freeze({ ...invocation }),
        resolve,
        reject,
        nativeDelivery: "queued",
      };
    });
    this.#move("tool-wait");
    this.#notifyToolWaiter();
    return result;
  }

  nextNativeTool(signal?: AbortSignal): Promise<NativeToolInvocation> {
    if (this.#pendingTool) {
      if (this.#pendingTool.nativeDelivery === "queued") return Promise.resolve(this.#pendingTool.invocation);
    }
    if (this.#settled) return Promise.reject(new Error("turn is already settled"));
    if (this.#toolWaiter) return Promise.reject(new Error("native tool consumer is already waiting"));
    if (signal?.aborted) return Promise.reject(new DOMException("tool wait aborted", "AbortError"));

    return new Promise<NativeToolInvocation>((resolve, reject) => {
      const waiter: ToolWaiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          if (this.#toolWaiter === waiter) this.#toolWaiter = undefined;
          reject(new DOMException("tool wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#toolWaiter = waiter;
    });
  }

  markNativeToolDelivered(callId: string): void {
    const pending = this.#pendingTool;
    if (!pending) throw new Error("turn has no outstanding native tool call");
    if (pending.invocation.callId !== callId) {
      throw new Error("native tool delivery does not match the outstanding call");
    }
    if (pending.nativeDelivery === "delivered") {
      throw new Error("native tool call delivery is already committed");
    }
    pending.nativeDelivery = "delivered";
    this.#touchState();
  }

  deliverNativeToolResult(result: NativeToolResult): void {
    const pending = this.#pendingTool;
    if (!pending) throw new Error("turn has no outstanding native tool call");
    if (pending.invocation.callId !== result.callId) {
      throw new Error("native tool result does not match the outstanding call");
    }
    if (pending.result) throw new Error("native tool result was already received for the outstanding call");
    pending.result = Object.freeze({ ...result });
    this.#move("tool-result-delivered");
  }

  /**
   * Release a proven Native result back to the Web/MCP caller only after the Web provider has armed
   * an exact post-result continuation observation. This barrier prevents a fast renderer update from
   * racing ahead of the semantic observer.
   */
  releaseNativeToolResultToWeb(callId: string): void {
    const pending = this.#pendingTool;
    if (!pending || pending.invocation.callId !== callId) {
      throw new Error("Web tool-result release does not match the outstanding call");
    }
    if (this.#phase !== "tool-result-delivered" || !pending.result) {
      throw new Error("native tool result is not ready for Web release");
    }
    this.#pendingTool = undefined;
    pending.resolve(pending.result);
    this.#touchState();
  }

  markWebContinuation(): void {
    this.#move("continuing");
  }

  complete(answer: string): void {
    if (this.#pendingTool) throw new Error("cannot complete a turn with an outstanding native tool call");
    if (this.#toolRoundCount > 0 && this.#phase === "tool-result-delivered") {
      throw new Error("cannot complete a tool-bearing turn before Web continuation is proven");
    }
    this.#move("completed");
    this.#settleFinal({ answer });
  }

  markIndeterminate(reason: unknown): void {
    const error = errorOf(reason);
    this.#move("indeterminate-after-acceptance");
    this.#fail(error);
  }

  cancel(reason: unknown = new Error("turn cancelled")): void {
    const error = errorOf(reason);
    this.#move("cancelled");
    this.#fail(error);
  }

  waitForFinal(signal?: AbortSignal): Promise<string> {
    return waitWithAbort(this.#finalPromise, signal);
  }

  #notifyToolWaiter(): void {
    const waiter = this.#toolWaiter;
    const pending = this.#pendingTool;
    if (!waiter || !pending) return;
    this.#toolWaiter = undefined;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(pending.invocation);
  }

  #move(to: TurnPhase): void {
    this.#phase = transitionTurn(this.#phase, to);
    this.#touchState();
  }

  #touchState(): void {
    this.#stateRevision += 1;
    const snapshot = this.state();
    for (const waiter of [...this.#stateWaiters]) {
      if (this.#stateRevision <= waiter.afterRevision) continue;
      this.#stateWaiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(snapshot);
    }
  }

  #settleFinal(result: { answer: string } | { error: Error }): void {
    if (this.#settled) throw new Error("turn final outcome is already settled");
    this.#settled = true;
    if ("answer" in result) this.#resolveFinal(result.answer);
    else this.#rejectFinal(result.error);
    const waiter = this.#toolWaiter;
    if (waiter) {
      this.#toolWaiter = undefined;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject("error" in result ? result.error : new Error("turn completed without another tool call"));
    }
    for (const stateWaiter of this.#stateWaiters) {
      if (stateWaiter.signal && stateWaiter.onAbort) {
        stateWaiter.signal.removeEventListener("abort", stateWaiter.onAbort);
      }
      stateWaiter.reject(new Error("turn settled before another state change"));
    }
    this.#stateWaiters.clear();
  }

  #fail(error: Error): void {
    const pending = this.#pendingTool;
    this.#pendingTool = undefined;
    pending?.reject(error);
    this.#settleFinal({ error });
  }
}
