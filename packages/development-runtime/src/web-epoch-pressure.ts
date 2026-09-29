export interface WebEpochPressureInput {
  readonly baseLogicalInputTokens: number;
  readonly baseTransferInputTokens: number;
  readonly rolloverTokenLimit: number;
  readonly contextWindowTokenLimit: number;
  readonly currentLogicalInputTokens: number;
}

export interface WebEpochPressure {
  readonly estimatedEpochInputTokens: number;
  readonly effectiveRolloverTokenLimit: number;
  readonly shouldRollover: boolean;
}

/** Estimate disposable Web pressure without changing Native logical history. */
export function assessWebEpochPressure(input: WebEpochPressureInput): WebEpochPressure | undefined {
  const values = [
    input.baseLogicalInputTokens,
    input.baseTransferInputTokens,
    input.rolloverTokenLimit,
    input.contextWindowTokenLimit,
    input.currentLogicalInputTokens,
  ];
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return undefined;
  if (input.rolloverTokenLimit <= 0
    || input.contextWindowTokenLimit <= 0
    || input.contextWindowTokenLimit < input.rolloverTokenLimit) return undefined;

  const estimatedEpochInputTokens = input.baseTransferInputTokens + Math.max(
    0,
    input.currentLogicalInputTokens - input.baseLogicalInputTokens,
  );
  const effectiveRolloverTokenLimit = input.baseTransferInputTokens >= input.rolloverTokenLimit
    ? input.contextWindowTokenLimit
    : input.rolloverTokenLimit;
  return Object.freeze({
    estimatedEpochInputTokens,
    effectiveRolloverTokenLimit,
    shouldRollover: estimatedEpochInputTokens >= effectiveRolloverTokenLimit,
  });
}
