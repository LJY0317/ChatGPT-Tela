import { createHash } from "node:crypto";
import { webObservationFailureReason, startTurnDiagnosticSummary, diagnosticContext, capturePrivateDiagnosticValue, nativeTextHash, diagnosticFailureClass, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";
import {
  bindNativeTurnRequest,
  extractNativeToolResults,
  parseNativeTurnReplayIdentity,
  type CanonicalCurrentTurnSource,
  type NativeTurnTerminationWatch,
  type NativeResponsesToolCallItem,
} from "@chatgpt-tela/codex";
import { ActiveTurnRegistry, NativeTurnAlreadyRetired, type RegisteredTurn } from "./registry";
import {
  acceptBoundNativeRoundRequest,
  nextNativeResponsesToolCall,
} from "./native-round";

export type NativeGatewayOutcome =
  | {
      readonly type: "tool-call";
      readonly item: NativeResponsesToolCallItem;
      readonly delivery: {
        readonly capability: string;
        readonly progressCursor?: number;
        readonly callId: string;
      };
    }
  | {
      readonly type: "final";
      readonly answer: string;
      readonly delivery: {
        readonly capability: string;
        readonly progressCursor?: number;
      };
    };

export type StartWebTurn = (turn: RegisteredTurn, nativeRequest: unknown, nativeSignal?: AbortSignal) => Promise<unknown>;

interface NativeLifetime {
  diagnostics?: ReturnType<typeof startTurnDiagnosticSummary>;
  readonly controller: AbortController;
  current: RegisteredTurn;
  watch: NativeTurnTerminationWatch | undefined;
  delivered: boolean;
  requestHash: string;
  answerHash?: string;
  readonly consumedInputs: Set<string>;
}

function requestHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function requestMessages(body: unknown): readonly { role: string; hash: string }[] {
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) return [];
  return input.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (item.type !== undefined && item.type !== "message") return [];
    if (item.role !== "user" && item.role !== "assistant") return [];
    let text: string;
    if (typeof item.content === "string") text = item.content;
    else if (Array.isArray(item.content)) {
      const parts = item.content as Record<string, unknown>[];
      if (parts.some(part => !part || typeof part.text !== "string"
        || !["input_text", "output_text", "text"].includes(String(part.type)))) return [{ role: item.role, hash: "unproven" }];
      text = parts.map(part => part.text).join("\n");
    } else return [{ role: item.role, hash: "unproven" }];
    return [{ role: item.role, hash: nativeTextHash(text) }];
  });
}

function never(): Promise<never> {
  return new Promise(() => {});
}

function terminalPhase(phase: string): boolean {
  return phase === "completed"
    || phase === "failed-before-acceptance"
    || phase === "indeterminate-after-acceptance"
    || phase === "cancelled";
}

/**
 * Semantic Native Responses gateway. HTTP/SSE framing is deliberately outside this class.
 *
 * A request is canonically bound before ownership lookup. The first request starts one Web turn;
 * later requests either return a pending tool result, refresh current-turn projections, or replay a
 * not-yet-committed outcome. Delivery is two-phase so a socket/write failure cannot silently turn an
 * undelivered Native tool call into an executed one.
 */
export class NativeResponsesGateway {
  readonly #controller = new AbortController();
  readonly #launches = new Map<string, Promise<unknown>>();
  readonly #lifetimes = new Map<string, NativeLifetime>();
  readonly #closingWatches = new Set<Promise<void>>();
  readonly #issuedFinals = new Map<string, string>();
  readonly #admissions = new Map<string, Promise<unknown>>();
  readonly #responseObservers = new Map<string, AbortController>();
  readonly #settlingByTask = new Map<string, Promise<unknown>>();

  constructor(
    readonly source: CanonicalCurrentTurnSource,
    readonly turns: ActiveTurnRegistry,
    readonly startWebTurn: StartWebTurn,
  ) {}

  async handle(body: unknown, presentation?: {
    readonly onProgress?: (summary: string) => void | boolean;
    readonly signal?: AbortSignal;
  }): Promise<NativeGatewayOutcome> {
    this.#controller.signal.throwIfAborted();
    const identity = parseNativeTurnReplayIdentity(body);
    const key = `${identity.threadId}\u0000${identity.turnId}`;
    // Admission is serialized by conversation, including cancel/edit into a NEW
    // Native turn. Response observation remains independently reconnectable.
    const admissionKey = identity.threadId;
    const prior = this.#admissions.get(admissionKey) ?? Promise.resolve();
    const admission = prior.catch(() => {}).then(() => this.#admit(body, key));
    this.#admissions.set(admissionKey, admission);
    let registered: RegisteredTurn;
    try { registered = await admission; }
    finally { if (this.#admissions.get(admissionKey) === admission) this.#admissions.delete(admissionKey); }

    // Native turn execution outlives HTTP/SSE connections. Only one connection may own
    // its response waiter; a canonically admitted reconnect supersedes that observation.
    const observer = new AbortController();
    const previous = this.#responseObservers.get(registered.capability);
    previous?.abort(new DOMException("Native response observer replaced", "AbortError"));
    this.#responseObservers.set(registered.capability, observer);
    const authority = registered.channel.binding.authority;
    withDiagnosticContext({ scope_fingerprint: diagnosticFingerprint(authority.threadId),
      turn_fingerprint: diagnosticFingerprint(authority.turnId) }, () =>
      emitDiagnosticEvent("chatgpt_tela_work", "native_response_observer_started", {
        turn_phase: registered.channel.phase, current_authority_proven: true,
      }));
    const signal = AbortSignal.any([observer.signal, this.#controller.signal,
      ...(presentation?.signal ? [presentation.signal] : [])]);
    const observerStopped = () => withDiagnosticContext({
      scope_fingerprint: diagnosticFingerprint(authority.threadId),
      turn_fingerprint: diagnosticFingerprint(authority.turnId),
    }, () => emitDiagnosticEvent("chatgpt_tela_work", "native_response_observer_ended", {
      reason_class: this.#controller.signal.aborted ? "gateway_shutdown"
        : observer.signal.aborted ? "observer_replaced_or_closed"
          : presentation?.signal?.aborted ? "client_cancel_or_disconnect" : "unknown",
      execution_restarted: false,
    }));
    signal.addEventListener("abort", observerStopped, { once: true });
    if (previous) {
      const authority = registered.channel.binding.authority;
      withDiagnosticContext({ scope_fingerprint: diagnosticFingerprint(authority.threadId),
        turn_fingerprint: diagnosticFingerprint(authority.turnId) }, () =>
        emitDiagnosticEvent("chatgpt_tela_work", "native_response_observer_replaced", {
          turn_phase: registered.channel.phase, execution_restarted: false,
        }));
    }
    let progressCursor = registered.channel.progressTransportCursor;
    const unsubscribe = presentation?.onProgress && !signal.aborted
      ? registered.channel.subscribeProgress((summary, sequence) => {
        withDiagnosticContext({ scope_fingerprint: diagnosticFingerprint(authority.threadId),
          turn_fingerprint: diagnosticFingerprint(authority.turnId) }, () => {
          const accepted = presentation.onProgress!(summary) !== false;
          emitDiagnosticEvent("chatgpt_tela_work", "public_progress_transport_observed", {
            progress_sequence: sequence, progress_characters: summary.length, accepted,
            delivery: "local_stream_callback_returned",
          });
          if (!accepted) throw new Error("progress transport did not accept event");
        });
        progressCursor = sequence;
      }) : () => {};
    signal.addEventListener("abort", unsubscribe, { once: true });
    try {
      signal.throwIfAborted();
      const outcome = await this.#nextOutcome(registered, signal);
      signal.throwIfAborted();
      return outcome.type === "tool-call"
        ? { ...outcome, delivery: { ...outcome.delivery, progressCursor } }
        : { ...outcome, delivery: { ...outcome.delivery, progressCursor } };
    }
    finally {
      unsubscribe();
      signal.removeEventListener("abort", unsubscribe);
      signal.removeEventListener("abort", observerStopped);
      observer.abort();
      if (this.#responseObservers.get(registered.capability) === observer) this.#responseObservers.delete(registered.capability);
    }
  }

  async #admit(body: unknown, key: string): Promise<RegisteredTurn> {
    // An already-retired turn was previously registered against canonical
    // Native authority. Rejecting that *same* claim never grants new
    // authority. Avoid repeating a multi-second public Desktop history read
    // for each retry after a large cold-history bootstrap fails.
    const identity = parseNativeTurnReplayIdentity(body);
    if (this.turns.isRetired(identity.threadId, identity.turnId)) {
      // Fixed structural fields only. Never log claimed Native identifiers,
      // raw prompts, model inputs or tool data from an unverified replay.
      withDiagnosticContext({
        scope_fingerprint: diagnosticFingerprint(identity.threadId),
        turn_fingerprint: diagnosticFingerprint(identity.turnId),
      }, () => emitDiagnosticEvent("chatgpt_tela_work", "native_replay_rejected", {
        reason_class: "retired_turn",
        native_source_probe: "skipped",
        current_authority_proven: false,
        retryable: false,
      }));
      throw this.turns.retiredError(identity.threadId, identity.turnId);
    }
    let binding = await bindNativeTurnRequest(body, this.source);
    this.#controller.signal.throwIfAborted();
    const priorRuns: Promise<unknown>[] = [];
    for (const [oldKey, old] of this.#lifetimes) {
      if (oldKey === key || old.current.channel.binding.authority.threadId !== binding.authority.threadId) continue;
      const running = this.#launches.get(old.current.capability);
      if (running) priorRuns.push(running);
      this.#retire(oldKey, new Error("A new canonical Native turn superseded this owner"), "owner_changed");
    }
    const cleanup = this.#settlingByTask.get(binding.authority.threadId);
    if (cleanup) priorRuns.push(cleanup);
    if (priorRuns.length) {
      await Promise.allSettled(priorRuns);
      // Authority may change while old physical cleanup is finishing.
      binding = await bindNativeTurnRequest(body, this.source);
      this.#controller.signal.throwIfAborted();
      withDiagnosticContext({ scope_fingerprint: diagnosticFingerprint(binding.authority.threadId),
        turn_fingerprint: diagnosticFingerprint(binding.authority.turnId) }, () =>
        emitDiagnosticEvent("chatgpt_tela_work", "native_prior_execution_settled", { prior_run_count: priorRuns.length,
          execution_restarted: false, current_authority_proven: true }));
    }
    let registered = this.turns.active(binding.authority.threadId, binding.authority.turnId);

    // Canonical environment/lineage cannot change under an existing Native owner.
    if (registered && (JSON.stringify(registered.channel.binding.authority) !== JSON.stringify(binding.authority)
      || registered.channel.binding.canonicalEvidence.parentThreadId !== binding.canonicalEvidence.parentThreadId
      || registered.channel.binding.canonicalEvidence.agentName !== binding.canonicalEvidence.agentName)) {
      this.#retire(key, new Error("Native owner changed"), "owner_changed");
      throw new Error("Native owner changed under the active response cycle");
    }
    let lifetime = this.#lifetimes.get(key);
    if (registered && lifetime?.delivered) {
      lifetime.watch?.signal.throwIfAborted();
      const messages = requestMessages(body);
      const finalIndex = messages.map(message => message.role === "assistant" && message.hash === lifetime!.answerHash).lastIndexOf(true);
      const newMessages = finalIndex < 0 ? [] : messages.slice(finalIndex + 1).filter(message => message.role === "user");
      const inputs = lifetime.watch?.inputs?.() ?? [];
      const fresh = inputs.filter(input => !lifetime!.consumedInputs.has(input.id)
        && newMessages.some(message => message.hash === input.textHash));
      if (!fresh.length || newMessages.length !== fresh.length || newMessages.some(message => !fresh.some(input => input.textHash === message.hash))) {
        // Failure-triggered structural evidence distinguishes an absent final anchor,
        // no new user message, and an absent/mismatched canonical input witness.
        withDiagnosticContext({ scope_fingerprint: diagnosticFingerprint(identity.threadId), turn_fingerprint: diagnosticFingerprint(identity.turnId) }, () =>
          emitDiagnosticEvent("chatgpt_tela_work", "native_cycle_proof_rejected", {
            reason_class: finalIndex < 0 ? "prior_final_missing" : !newMessages.length ? "new_input_missing"
              : !fresh.length ? "input_witness_missing" : "input_witness_mismatch",
            prior_final_present: finalIndex >= 0,
            new_message_count: newMessages.length,
            observed_input_count: inputs.length,
            fresh_input_count: fresh.length,
            unconsumed_input_count: inputs.filter(input => !lifetime!.consumedInputs.has(input.id)).length,
            exact_request_replay: lifetime!.requestHash === requestHash(body),
          }));
        this.#rejectCycle(identity, "missing_input_proof", "Native response cycle continuation lacks proven new input and prior final delivery");
      }
      // A final answer may reach Native before browser/context settlement. Never overlap planners.
      await this.#launches.get(registered.capability);
      lifetime.watch?.signal.throwIfAborted();
      if (this.turns.active(identity.threadId, identity.turnId)?.capability !== registered.capability) {
        throw new NativeTurnAlreadyRetired();
      }
      this.#launches.delete(registered.capability);
      registered = this.turns.nextCycle(registered.capability, binding);
      lifetime.current = registered;
      lifetime.delivered = false;
      delete lifetime.answerHash;
      lifetime.requestHash = requestHash(body);
      for (const input of fresh) lifetime.consumedInputs.add(input.id);
      withDiagnosticContext({ scope_fingerprint: diagnosticFingerprint(identity.threadId), turn_fingerprint: diagnosticFingerprint(identity.turnId) }, () =>
        emitDiagnosticEvent("chatgpt_tela_work", "native_steering_cycle_started", { input_count: fresh.length,
          current_authority_proven: true, prior_final_present: true }));
    } else if (registered && terminalPhase(registered.channel.phase)) {
      if (!lifetime || lifetime.requestHash !== requestHash(body)) {
        this.#rejectCycle(identity, "uncommitted_delivery", "Completed response may only replay its exact uncommitted request");
      }
      return registered;
    }
    if (!registered || registered.channel.phase === "prepared" && !this.#launches.has(registered.capability)) {
      if (!registered) {
        registered = this.turns.register(binding);
        lifetime = { controller: new AbortController(), current: registered, watch: undefined, delivered: false, requestHash: requestHash(body), consumedInputs: new Set() };
        this.#lifetimes.set(key, lifetime);
        try {
          lifetime.watch = await this.source.watchTurn?.(identity.threadId, identity.turnId, this.#controller.signal);
          this.#controller.signal.throwIfAborted();
          if (this.source.watchTurn && !lifetime.watch) throw new Error("Native lifecycle observation was not proven");
          lifetime.watch?.signal.throwIfAborted();
          if (lifetime.watch) {
            const signal = lifetime.watch.signal;
            signal.addEventListener("abort", () => this.#retire(key, signal.reason, "owner_signal"), { once: true });
            for (const input of lifetime.watch.inputs?.() ?? []) {
              if (requestMessages(body).some(message => message.role === "user" && message.hash === input.textHash)) lifetime.consumedInputs.add(input.id);
            }
          }
        } catch (error) {
          withDiagnosticContext({ scope_fingerprint: diagnosticFingerprint(identity.threadId), turn_fingerprint: diagnosticFingerprint(identity.turnId) }, () => {
            capturePrivateDiagnosticValue("web_preparation_failure", { phase: "native_watch", request: body,
              error: error instanceof Error ? { name: error.name, message: error.message } : { name: "unknown" } });
            emitDiagnosticEvent("chatgpt_tela_work", "web_preparation_failed", { phase: "native_watch", reason_class: "unclassified", tool_round_count: 0 });
          });
          this.#retire(key, error, "watch_failed"); throw error;
        }
      }
      const owned = registered;
      lifetime!.diagnostics?.finish();
      lifetime!.diagnostics = startTurnDiagnosticSummary(diagnosticFingerprint(owned.channel.binding.authority.threadId),
        diagnosticFingerprint(owned.channel.binding.authority.turnId), diagnosticContext().request_fingerprint);
      const launch = Promise.resolve().then(() => this.startWebTurn(owned, body, AbortSignal.any([this.#controller.signal, lifetime!.controller.signal, ...(lifetime?.watch ? [lifetime.watch.signal] : [])]))).catch(error => {
        const failedOwner = owned.channel.binding.authority;
        withDiagnosticContext({
          scope_fingerprint: diagnosticFingerprint(failedOwner.threadId),
          turn_fingerprint: diagnosticFingerprint(failedOwner.turnId),
        }, () => emitDiagnosticEvent("chatgpt_tela_work", "native_execution_failed", {
          status: diagnosticFailureClass(error),
          ...(webObservationFailureReason(error) ? { reason_class: webObservationFailureReason(error)! } : {}),
          turn_phase: owned.channel.phase,
          tool_round_count: owned.channel.toolRoundCount,
        }));
        // A settled execution failure owns no future tool authority. Revoke it here even when
        // preparation failed before submission (and the Native failure watcher already closed).
        // Successful cycles remain replayable until delivery; Native lifecycle owns final retirement.
        if (!terminalPhase(owned.channel.phase)) {
          if (owned.channel.phase === "prepared") owned.channel.failBeforeAcceptance(error);
          else if (owned.channel.phase === "submitted") owned.channel.cancel(error);
          else owned.channel.markIndeterminate(error);
        }
        const authority = owned.channel.binding.authority;
        if (owned.channel.phase !== "completed"
          && this.turns.active(authority.threadId, authority.turnId)?.capability === owned.capability) {
          this.#retire(key, error, "execution_failed");
        }
        throw error;
      });
      // The launch is observed both here and by the outcome race; this prevents process-level
      // unhandled rejections if the Native client disconnects before awaiting the gateway result.
      void launch.catch(() => {});
      this.#launches.set(registered.capability, launch);
      void launch.finally(() => {
        const authority = owned.channel.binding.authority;
        if (!this.turns.active(authority.threadId, authority.turnId)) {
          this.#launches.delete(owned.capability);
        }
      }).catch(() => {});
    } else if (!terminalPhase(registered.channel.phase)) {
      const outstanding = registered.channel.outstandingToolCallId;
      if (outstanding) {
        const hasMatchingResult = extractNativeToolResults(body)
          .some(result => result.callId === outstanding);
        if (hasMatchingResult) {
          acceptBoundNativeRoundRequest(registered.channel, binding, body);
          if (lifetime) lifetime.requestHash = requestHash(body);
        } else if (registered.channel.outstandingNativeDelivery === "delivered") {
          throw new Error("Native tool call was already delivered; the follow-up request must contain its result");
        }
        // An uncommitted queued call is intentionally left on the old binding so the exact same
        // output can be replayed after a transport failure. It is not a new Native round yet.
      } else {
        registered = this.turns.refresh(binding);
        if (lifetime) lifetime.requestHash = requestHash(body);
        const waitingInputs = lifetime?.watch?.inputs?.().filter(input => !lifetime!.consumedInputs.has(input.id)).length ?? 0;
        if (waitingInputs) withDiagnosticContext({ scope_fingerprint: diagnosticFingerprint(identity.threadId), turn_fingerprint: diagnosticFingerprint(identity.turnId) }, () =>
          emitDiagnosticEvent("chatgpt_tela_work", "native_steering_deferred", { input_count: waitingInputs,
            turn_phase: registered!.channel.phase, execution_restarted: false }));
      }
    }

    return registered;
  }

  #rejectCycle(identity: { threadId: string; turnId: string }, reason: string, message: string): never {
    withDiagnosticContext({ scope_fingerprint: diagnosticFingerprint(identity.threadId), turn_fingerprint: diagnosticFingerprint(identity.turnId) }, () =>
      emitDiagnosticEvent("chatgpt_tela_work", "native_replay_rejected", {
        reason_class: reason, native_source_probe: "proven", current_authority_proven: true, retryable: false,
      }));
    throw Object.assign(new Error(message), { code: "tela_native_response_cycle_conflict", retryable: false });
  }

  #retire(
    key: string,
    reason?: unknown,
    cause: "owner_changed" | "owner_signal" | "watch_failed" | "execution_failed" | "gateway_closed" = "gateway_closed",
  ): void {
    const lifetime = this.#lifetimes.get(key);
    if (!lifetime) return;
    // Snapshot before cancellation; later phases cannot describe the boundary
    // where original ownership was lost. No Host execution proof is inferred.
    const priorState = lifetime.current.channel.state();
    this.#lifetimes.delete(key);
    lifetime.controller.abort(reason ?? new Error("Native owner retired"));
    const owned = lifetime.current;
    if (!terminalPhase(owned.channel.phase)) owned.channel.cancel(reason);
    const authority = owned.channel.binding.authority;
    if (this.turns.active(authority.threadId, authority.turnId)?.capability === owned.capability) {
      this.turns.retire(owned.capability, reason);
      withDiagnosticContext({
        scope_fingerprint: diagnosticFingerprint(authority.threadId),
        turn_fingerprint: diagnosticFingerprint(authority.turnId),
      }, () => emitDiagnosticEvent("chatgpt_tela_work", "native_turn_retired", {
        reason_class: cause,
        turn_phase: priorState.phase,
        tool_round_count: priorState.toolRoundCount,
        tool_pending: priorState.outstandingToolCallId !== undefined,
        native_delivery_committed: priorState.outstandingNativeDelivery === "delivered",
        result_received: priorState.nativeResultReady === true,
        execution_proven: false,
        retryable: false,
      }));
    }

    lifetime.diagnostics?.finish();
    const launch = this.#launches.get(owned.capability);
    this.#launches.delete(owned.capability);
    const previousSettlement = this.#settlingByTask.get(authority.threadId);
    const settlement = Promise.allSettled([...(previousSettlement ? [previousSettlement] : []), ...(launch ? [launch] : [])]);
    this.#settlingByTask.set(authority.threadId, settlement);
    void settlement.finally(() => {
      if (this.#settlingByTask.get(authority.threadId) === settlement) this.#settlingByTask.delete(authority.threadId);
    });
    // Observation owns Native lifetime; Web cleanup still finishes before closing its observer.
    const closing = (launch ?? Promise.resolve()).catch(() => {})
      .then(() => lifetime.watch?.close()).then(() => {});
    this.#closingWatches.add(closing);
    void closing.finally(() => this.#closingWatches.delete(closing)).catch(() => {});
  }

  async close(): Promise<void> {
    this.#controller.abort(new Error("Native gateway closed"));
    for (const key of [...this.#lifetimes.keys()]) this.#retire(key, new Error("Native gateway closed"), "gateway_closed");
    await Promise.allSettled([...this.#closingWatches]);
  }

  commit(outcome: NativeGatewayOutcome): void {
    let channel;
    try { channel = this.turns.resolve(outcome.delivery.capability); }
    catch (error) {
      // A late final transport ACK may follow Native completion or a newer cycle. It grants no authority.
      if (outcome.type === "final" && this.#issuedFinals.get(outcome.delivery.capability) === nativeTextHash(outcome.answer)) return;
      throw error;
    }
    if (outcome.type === "final" && this.#issuedFinals.get(outcome.delivery.capability) !== nativeTextHash(outcome.answer)) throw new Error("final outcome was not issued by this response cycle");
    const authority = channel.binding.authority;
    channel.commitProgressTransport(outcome.delivery.progressCursor ?? channel.progressTransportCursor);
    if (outcome.type === "tool-call") {
      this.turns.resolve(outcome.delivery.capability)
        .markNativeToolDelivered(outcome.delivery.callId);
    } else {
      const key = `${authority.threadId}\u0000${authority.turnId}`;
      const lifetime = this.#lifetimes.get(key);
      if (!lifetime || lifetime.current.capability !== outcome.delivery.capability) throw new Error("final delivery does not own the current response cycle");
      lifetime.delivered = true;
      lifetime.answerHash = nativeTextHash(outcome.answer);
    }
    // Emit only after the corresponding local owner/transport state has been
    // committed. Rejected/ambiguous deliveries are not success witnesses.
    withDiagnosticContext({
      scope_fingerprint: diagnosticFingerprint(authority.threadId),
      turn_fingerprint: diagnosticFingerprint(authority.turnId),
    }, () => emitDiagnosticEvent("chatgpt_tela_work", "native_outcome_committed", {
      outcome: outcome.type === "final" ? "final" : "tool_call",
      turn_phase: channel.phase,
      tool_round_count: channel.toolRoundCount,
      native_terminal_observed: false,
    }));
    if (outcome.type === "final") this.#lifetimes.get(`${authority.threadId}\u0000${authority.turnId}`)?.diagnostics?.finish();
    // Without a lifecycle observer the owner remains uncertain until explicit gateway shutdown.
    // Such inert/test sources can never authorize another response cycle.
  }

  async #nextOutcome(registered: RegisteredTurn, signal: AbortSignal): Promise<NativeGatewayOutcome> {
    const channel = registered.channel;
    const final = channel.waitForFinal(signal).then(answer => {
      this.#issuedFinals.set(registered.capability, nativeTextHash(answer));
      while (this.#issuedFinals.size > ActiveTurnRegistry.MAX_RETIRED_TURNS) this.#issuedFinals.delete(this.#issuedFinals.keys().next().value!);
      return Object.freeze({
        type: "final" as const,
        answer,
        delivery: Object.freeze({ capability: registered.capability }),
      });
    });
    if (terminalPhase(channel.phase)) return final;

    const tool = nextNativeResponsesToolCall(channel, signal)
      .then(item => Object.freeze({
        type: "tool-call" as const,
        item,
        delivery: Object.freeze({
          capability: registered.capability,
          callId: item.call_id,
        }),
      }))
      .catch(error => {
        if (error instanceof Error && error.message === "turn completed without another tool call") {
          return never();
        }
        return Promise.reject(error);
      });

    const launch = this.#launches.get(registered.capability);
    const launchFailure = launch
      ? launch.then(() => never(), error => Promise.reject(error))
      : never();

    return Promise.race([tool, final, launchFailure]);
  }
}
