import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { chatGptCheckpointInputTokens } from "@chatgpt-tela/chatgpt";
import type { NativeRequestCheckpointProducer } from "./native-request-planner";
import { NativeHistoryBootstrapRequired } from "@chatgpt-tela/codex";

/** Tela product policy, not a claim about any model's context window. */
export interface CheckpointPreparationPolicy {
  readonly maxModelCalls: number;
  readonly maxInputTokens: number;
  /** Stop admitting new calls after this duration; never abort an uncertain send to save budget. */
  readonly maxElapsedMs: number;
}
export function checkpointPreparationPolicy(value: unknown): CheckpointPreparationPolicy {
  const candidate = value as CheckpointPreparationPolicy | undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || Object.keys(candidate).some(key => !["maxModelCalls", "maxInputTokens", "maxElapsedMs"].includes(key))
    || ![candidate.maxModelCalls, candidate.maxInputTokens, candidate.maxElapsedMs]
      .every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw Error("Invalid checkpoint preparation policy");
  }
  return Object.freeze({ maxModelCalls: candidate.maxModelCalls,
    maxInputTokens: candidate.maxInputTokens, maxElapsedMs: candidate.maxElapsedMs });
}
export class CheckpointPreparationBudgetExceeded extends NativeHistoryBootstrapRequired {
  constructor(readonly budgetReason: "model_calls" | "input_tokens" | "elapsed_time") {
    super("source_budget");
    this.name = "CheckpointPreparationBudgetExceeded";
  }
}

/** One owner per preparation. Completed receipts consume no model-call or input budget. */
export class CheckpointPreparationBudget {
  readonly policy: CheckpointPreparationPolicy;
  readonly #started: number;
  #calls = 0;
  #input = 0;
  readonly #producers = new WeakMap<NativeRequestCheckpointProducer, NativeRequestCheckpointProducer>();
  constructor(stageInputLimit: number, policy?: CheckpointPreparationPolicy,
    private readonly now: () => number = () => performance.now()) {
    this.policy = checkpointPreparationPolicy(policy ?? {
      maxModelCalls: 1, maxInputTokens: stageInputLimit, maxElapsedMs: 10 * 60 * 1000,
    });
    if (!Number.isSafeInteger(stageInputLimit) || stageInputLimit < 1) {
      throw Error("Invalid checkpoint preparation policy");
    }
    this.#started = this.now();
  }
  #reject(reason: CheckpointPreparationBudgetExceeded["budgetReason"]): never {
    emitDiagnosticEvent("chatgpt_tela_codex", "native_checkpoint_preparation_rejected", {
      reason_class: reason, admitted_model_calls: this.#calls, transfer_estimate: this.#input,
      stage_budget: this.policy.maxModelCalls, transfer_budget: this.policy.maxInputTokens,
      elapsed_budget_ms: this.policy.maxElapsedMs,
    });
    throw new CheckpointPreparationBudgetExceeded(reason);
  }
  /** Conservative plan before the first execution claim; estimates never authorize a send. */
  admitPlan(calls: number, inputTokens: number): void {
    if (![calls, inputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw Error("Invalid checkpoint preparation estimate");
    }
    if (this.#calls + calls > this.policy.maxModelCalls) this.#reject("model_calls");
    if (this.#input + inputTokens > this.policy.maxInputTokens) this.#reject("input_tokens");
  }
  beforeClaim(inputTokens: number): void {
    this.admitPlan(1, inputTokens);
    if (this.now() - this.#started >= this.policy.maxElapsedMs) {
      this.#reject("elapsed_time");
    }
  }
  get modelCalls(): number { return this.#calls; }
  recordInvocation(inputTokens: number): void {
    this.admitPlan(1, inputTokens); this.#calls++; this.#input += inputTokens;
  }
  /** Rewrapping by another preparation phase preserves one charge and one underlying invocation. */
  producer(producer: NativeRequestCheckpointProducer, onInvoke?: () => void): NativeRequestCheckpointProducer {
    const original = this.#producers.get(producer) ?? producer;
    const wrapped: NativeRequestCheckpointProducer = (request, preparation) => {
      const tokens = chatGptCheckpointInputTokens(request.physicalContext);
      this.beforeClaim(tokens); this.recordInvocation(tokens);
      onInvoke?.();
      return original(request, preparation);
    };
    this.#producers.set(wrapped, original);
    return wrapped;
  }
}
