import { WebContextFitFailed, webContextFitFailureReason, type WebContextFitReason } from "@chatgpt-tela/core";
import { WebObservationUnproven, webObservationFailureReason, type WebObservationReason } from "@chatgpt-tela/core";
import { WebSubmissionUnproven, webSubmissionFailureReason, type WebSubmissionProofReason } from "@chatgpt-tela/core";
import { randomBytes } from "node:crypto";
import { NativeProjectionUnsupported, NativeWebHandoffUnproven } from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import { NativeHistoryBootstrapRequired } from "@chatgpt-tela/codex";
import { WebRetainedContextUnproven, webRetainedContextFailureReason, type WebRetainedContextReason } from "@chatgpt-tela/core";
import { RuntimeTurnChannel } from "./turn-channel";

export interface TurnCapabilityResolver {
  resolve(token: string): RuntimeTurnChannel;
}

export interface RegisteredTurn {
  readonly capability: string;
  readonly channel: RuntimeTurnChannel;
}

/** A negative-only replay denial; never grants Native task or tool authority. */
export class NativeTurnAlreadyRetired extends Error {
  readonly code = "tela_native_turn_already_retired";

  constructor() {
    super("native turn was already retired by this runtime");
    this.name = "NativeTurnAlreadyRetired";
  }
}

function turnKey(binding: NativeTurnBinding): string {
  return `${binding.authority.threadId}\u0000${binding.authority.turnId}`;
}

function routeId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9]{8,32}$/.test(normalized)) {
    throw new Error("turn capability route id must contain 8-32 ASCII alphanumeric characters");
  }
  return normalized;
}

function capability(route: string | undefined): string {
  const secret = randomBytes(32).toString("base64url");
  return route ? `turnr_${route}_${secret}` : `turn_${secret}`;
}

export function turnCapabilityRoute(token: string): string | undefined {
  const match = /^turnr_([A-Za-z0-9]{8,32})_[A-Za-z0-9_-]{40,}$/.exec(token);
  return match?.[1];
}

/**
 * Owns opaque, process-local capabilities for active turns. Human-readable thread/turn ids are not
 * bearer credentials, and an active Native turn may have only one runtime owner.
 */
export class ActiveTurnRegistry {
  readonly #byCapability = new Map<string, RuntimeTurnChannel>();
  readonly #nativeCallIdsByTurn = new Map<string, Set<string>>();
  readonly #capabilityByTurn = new Map<string, string>();
  // A fixed recovery classification only; never retain raw exceptions or request content.
  readonly #retiredTurns = new Map<string, true | "handoff_probable" | "handoff_ambiguous" | "projection_unsupported" | NativeHistoryBootstrapRequired["recoveryReason"] | { readonly retainedContext: WebRetainedContextReason } | { readonly submission: WebSubmissionProofReason } | { readonly observation: WebObservationReason } | { readonly contextFit: WebContextFitReason }>();
  static readonly MAX_RETIRED_TURNS = 256;
  readonly #routeId: string | undefined;

  constructor(options: { readonly routeId?: string } = {}) {
    this.#routeId = options.routeId === undefined ? undefined : routeId(options.routeId);
  }

  register(binding: NativeTurnBinding): RegisteredTurn {
    const key = turnKey(binding);
    if (this.#retiredTurns.has(key)) {
      throw this.retiredError(binding.authority.threadId, binding.authority.turnId);
    }
    const token = capability(this.#routeId);
    const callIds = new Set<string>();
    const channel = new RuntimeTurnChannel(binding, callIds);
    this.#nativeCallIdsByTurn.set(key, callIds);
    this.#byCapability.set(token, channel);
    this.#capabilityByTurn.set(key, token);
    return Object.freeze({ capability: token, channel });
  }

  active(threadId: string, turnId: string): RegisteredTurn | undefined {
    const token = this.#capabilityByTurn.get(`${threadId}\u0000${turnId}`);
    if (!token) return undefined;
    return Object.freeze({ capability: token, channel: this.resolve(token) });
  }

  /** Only for rejecting a previously canonically proven, retired turn. */
  isRetired(threadId: string, turnId: string): boolean {
    return this.#retiredTurns.has(threadId + "\u0000" + turnId);
  }

  retiredError(threadId: string, turnId: string): Error {
    const reason = this.#retiredTurns.get(threadId + "\u0000" + turnId);
    if (reason && typeof reason === "object" && "contextFit" in reason) return new WebContextFitFailed(reason.contextFit);
    if (reason && typeof reason === "object") return "observation" in reason ? new WebObservationUnproven(reason.observation) : "submission" in reason
      ? new WebSubmissionUnproven(reason.submission) : new WebRetainedContextUnproven(reason.retainedContext);
    if (reason === "handoff_probable" || reason === "handoff_ambiguous") return new NativeWebHandoffUnproven(reason === "handoff_ambiguous" ? "ambiguous" : "probable");
    if (reason === "projection_unsupported") return new NativeProjectionUnsupported();
    return reason !== undefined && reason !== true
      ? new NativeHistoryBootstrapRequired(reason) : new NativeTurnAlreadyRetired();
  }

  resolve(token: string): RuntimeTurnChannel {
    const channel = this.#byCapability.get(token);
    if (!channel) throw new Error("unknown or retired turn capability");
    return channel;
  }

  refresh(binding: NativeTurnBinding): RegisteredTurn {
    const token = this.#capabilityByTurn.get(turnKey(binding));
    if (!token) return this.register(binding);
    const channel = this.resolve(token);
    channel.refreshBinding(binding);
    return Object.freeze({ capability: token, channel });
  }

  /** End a delivered response cycle without retiring its still-live canonical Native owner. */
  nextCycle(token: string, binding: NativeTurnBinding): RegisteredTurn {
    const previous = this.resolve(token);
    if (previous.phase !== "completed") throw new Error("response cycle is not completed");
    const nextToken = capability(this.#routeId);
    const channel = new RuntimeTurnChannel(binding, this.#nativeCallIdsByTurn.get(turnKey(binding))!);
    previous.releaseProgress();
    this.#byCapability.delete(token);
    this.#byCapability.set(nextToken, channel);
    this.#capabilityByTurn.set(turnKey(binding), nextToken);
    return Object.freeze({ capability: nextToken, channel });
  }

  retire(token: string, failure?: unknown): void {
    const channel = this.resolve(token);
    const key = turnKey(channel.binding);
    channel.releaseProgress();
    this.#byCapability.delete(token);
    this.#capabilityByTurn.delete(key);
    this.#nativeCallIdsByTurn.delete(key);
    this.#retiredTurns.delete(key);
    const error = failure && typeof failure === "object"
      ? failure as { code?: unknown; recoveryReason?: unknown; proofState?: unknown } : undefined;
    const retainedContext = webRetainedContextFailureReason(failure);
    const submission = webSubmissionFailureReason(failure);
    const observation = webObservationFailureReason(failure);
    const contextFit = webContextFitFailureReason(failure);
    this.#retiredTurns.set(key, contextFit ? { contextFit } : observation ? { observation } : submission ? { submission } : retainedContext ? { retainedContext } : error?.code === "native_history_bootstrap_required"
      ? NativeHistoryBootstrapRequired.normalizeRecoveryReason(error.recoveryReason)
      : error?.code === "native_projection_unsupported" ? "projection_unsupported"
      : error?.code === "native_web_handoff_unproven" ? error.proofState === "ambiguous" ? "handoff_ambiguous" : "handoff_probable" : true);
    while (this.#retiredTurns.size > ActiveTurnRegistry.MAX_RETIRED_TURNS) {
      const oldest = this.#retiredTurns.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#retiredTurns.delete(oldest);
    }
  }

  cancelAll(reason: unknown = new Error("runtime stopped")): void {
    const active = [...this.#byCapability.entries()];
    this.#byCapability.clear();
    this.#capabilityByTurn.clear();
    this.#nativeCallIdsByTurn.clear();
    for (const [token, channel] of active) {
      const key = turnKey(channel.binding);
      try {
        channel.cancel(reason);
      } catch {
        // A concurrently settled channel is already terminal; registry ownership is still retired.
      }
      this.#retiredTurns.delete(key);
      this.#retiredTurns.set(key, true);
      while (this.#retiredTurns.size > ActiveTurnRegistry.MAX_RETIRED_TURNS) {
        const oldest = this.#retiredTurns.keys().next().value as string | undefined;
        if (!oldest) break;
        this.#retiredTurns.delete(oldest);
      }
      channel.releaseProgress();
      void token;
    }
  }

  get size(): number {
    return this.#byCapability.size;
  }
}
