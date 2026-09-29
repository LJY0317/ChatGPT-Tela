import type { ChatGptWebEffort } from "./model-picker";

/**
 * Conservative browser-transport calibration inherited from the downstream Web harness.
 * These values govern disposable Web state only; they never define or truncate Native context.
 * Keep them isolated so future live calibration can replace them without touching task semantics.
 */
export interface ChatGptWebPhysicalLimits {
  readonly rolloverTokenLimit: number;
  readonly contextWindowTokenLimit: number;
  readonly composerCharLimit: number;
}

const PLATFORM_RESERVE_TOKENS = 8_192;
const STANDARD_MESSAGE_TOKEN_LIMIT = 103_000;
const MAX_MESSAGE_TOKEN_LIMIT = 104_000;
const CONSERVATIVE_ROLLOVER_TOKEN_LIMIT = 95_000;

export function chatGptWebPhysicalLimits(effort: ChatGptWebEffort): ChatGptWebPhysicalLimits {
  if (effort === "max") {
    return Object.freeze({
      rolloverTokenLimit: CONSERVATIVE_ROLLOVER_TOKEN_LIMIT,
      contextWindowTokenLimit: MAX_MESSAGE_TOKEN_LIMIT + PLATFORM_RESERVE_TOKENS + 1,
      composerCharLimit: 1_635_000,
    });
  }
  if (effort === "low") {
    return Object.freeze({
      rolloverTokenLimit: CONSERVATIVE_ROLLOVER_TOKEN_LIMIT,
      contextWindowTokenLimit: STANDARD_MESSAGE_TOKEN_LIMIT + PLATFORM_RESERVE_TOKENS + 1,
      composerCharLimit: 545_000,
    });
  }
  return Object.freeze({
    rolloverTokenLimit: CONSERVATIVE_ROLLOVER_TOKEN_LIMIT,
    contextWindowTokenLimit: STANDARD_MESSAGE_TOKEN_LIMIT + PLATFORM_RESERVE_TOKENS + 1,
    composerCharLimit: 500_000,
  });
}
