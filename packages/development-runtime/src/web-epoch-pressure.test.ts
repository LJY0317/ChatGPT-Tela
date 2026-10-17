import { describe, expect, test } from "bun:test";
import { assessWebEpochPressure } from "./web-epoch-pressure";

describe("Web epoch physical pressure", () => {
  test("counts the real page's accumulated estimated input and output, not Native archive growth", () => {
    expect(assessWebEpochPressure({
      settledEpochTokens: 75_000,
      nextInputTokens: 17_000,
      outputReserveTokens: 4_096,
      rolloverTokenLimit: 95_000,
      contextWindowTokenLimit: 111_193,
    })).toEqual({
      estimatedEpochInputTokens: 96_096,
      effectiveRolloverTokenLimit: 95_000,
      shouldRollover: true,
    });
  });

  test("new Web generations begin with independent residency; soft rollover stays below hard window", () => {
    expect(assessWebEpochPressure({
      settledEpochTokens: 20_000,
      nextInputTokens: 3_000,
      outputReserveTokens: 4_096,
      rolloverTokenLimit: 95_000,
      contextWindowTokenLimit: 111_193,
    })).toEqual({
      estimatedEpochInputTokens: 27_096,
      effectiveRolloverTokenLimit: 95_000,
      shouldRollover: false,
    });
  });

  test("Native compaction or a checkpoint cannot retroactively reduce resident usage", () => {
    expect(assessWebEpochPressure({
      settledEpochTokens: 92_000,
      nextInputTokens: 100,
      outputReserveTokens: 4_096,
      rolloverTokenLimit: 95_000,
      contextWindowTokenLimit: 111_193,
    })).toMatchObject({ estimatedEpochInputTokens: 96_196, shouldRollover: true });
  });

  test("overflowed accumulated estimates are unknown instead of authorizing retention", () => {
    expect(assessWebEpochPressure({
      settledEpochTokens: Number.MAX_SAFE_INTEGER,
      nextInputTokens: 1,
      outputReserveTokens: 4_096,
      rolloverTokenLimit: 95_000,
      contextWindowTokenLimit: 111_193,
    })).toBeUndefined();
  });
});
