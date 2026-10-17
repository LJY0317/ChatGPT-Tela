export interface WebEpochPressureInput {
  /** Monotonic accumulated input and conservatively estimated output of this physical page. */
  readonly settledEpochTokens: number;
  readonly nextInputTokens: number;
  readonly outputReserveTokens: number;
  readonly rolloverTokenLimit: number;
  readonly contextWindowTokenLimit: number;
  /** Proven fresh seed itself exceeded soft runway, independently of later output growth. */
  readonly oversizedFreshSeed?: boolean;
}

export interface WebEpochPressure {
  readonly estimatedEpochInputTokens: number;
  readonly effectiveRolloverTokenLimit: number;
  readonly shouldRollover: boolean;
}

/** Estimate physical Web occupancy; Native compaction never releases a resident Web token. */
export function assessWebEpochPressure(input: WebEpochPressureInput): WebEpochPressure | undefined {
  const values = [
    input.settledEpochTokens,
    input.nextInputTokens,
    input.outputReserveTokens,
    input.rolloverTokenLimit,
    input.contextWindowTokenLimit,
  ];
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return undefined;
  if (input.rolloverTokenLimit <= 0
    || input.contextWindowTokenLimit <= 0
    || input.contextWindowTokenLimit < input.rolloverTokenLimit) return undefined;

  const estimatedEpochInputTokens = input.settledEpochTokens + input.nextInputTokens
    + input.outputReserveTokens;
  // An overflowed estimate cannot safely decide to keep a retained conversation.
  if (!Number.isSafeInteger(estimatedEpochInputTokens)) return undefined;
  // Soft runway cannot be met by re-creating an irreducible seed. Only an
  // explicitly proven oversized fresh seed may use remaining hard capacity.
  const effectiveRolloverTokenLimit = input.oversizedFreshSeed
    ? input.contextWindowTokenLimit : input.rolloverTokenLimit;
  return Object.freeze({
    estimatedEpochInputTokens,
    effectiveRolloverTokenLimit,
    shouldRollover: estimatedEpochInputTokens >= effectiveRolloverTokenLimit,
  });
}
