import {
  chatGptWebPhysicalLimits, chatGptWebCheckpointSourceTokenLimit,
  type ChatGptWebEffort, type ChatGptWebPhysicalLimits,
} from "@chatgpt-tela/chatgpt";
import type { CheckpointPreparationPolicy } from "./checkpoint-preparation-budget";

/**
 * Tela operational targets, NOT discovered ChatGPT browser capacity or Native model limits.
 * Hard refusal, resident rollover, first task seed and preparation spending are separate budgets.
 * Ordinary Web planning and Native local compaction resolve the same policy.
 */
export interface WebWorkingContextPolicy {
  readonly capacityEvidence: "conservative-browser-calibration";
  readonly hard: ChatGptWebPhysicalLimits;
  readonly checkpointSourceTokens: number;
  readonly firstMessageTargetTokens: number;
  readonly checkpointTargetTokens: number;
  readonly suffixTargetTokens: number;
  readonly outputReserveTokens: number;
  readonly preparation?: CheckpointPreparationPolicy;
}

export function webWorkingContextPolicy(effort: ChatGptWebEffort,
  preparation?: CheckpointPreparationPolicy,
  hard: ChatGptWebPhysicalLimits = chatGptWebPhysicalLimits(effort)): WebWorkingContextPolicy {
  const source = chatGptWebCheckpointSourceTokenLimit(effort);
  if (![hard.rolloverTokenLimit, hard.contextWindowTokenLimit, hard.composerCharLimit]
    .every(value => Number.isSafeInteger(value) && value > 0)
    || hard.rolloverTokenLimit > hard.contextWindowTokenLimit) throw Error("Invalid Web capacity calibration");
  // The calibrated rollover boundary is deliberately NOT a first-message target.
  const first = Math.max(1, Math.min(24_000, Math.floor(hard.rolloverTokenLimit / 3)));
  const checkpoint = Math.max(1, Math.floor(first / 3));
  const suffix = Math.max(1, first - checkpoint - Math.min(2_048, Math.floor(first / 8)));
  return Object.freeze({
    capacityEvidence: "conservative-browser-calibration" as const,
    hard, checkpointSourceTokens: source,
    firstMessageTargetTokens: first,
    checkpointTargetTokens: checkpoint,
    suffixTargetTokens: suffix,
    outputReserveTokens: 2_048,
    ...(preparation ? { preparation } : {}),
  });
}
