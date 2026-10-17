import { describe, expect, test } from "bun:test";
import { assessWebEpochPressure } from "./web-epoch-pressure";

describe("Web epoch physical pressure", () => {
  test("counts Native logical growth even when retained suffix transport stays small", () => {
    expect(assessWebEpochPressure({
      baseLogicalInputTokens: 40_000,
      baseTransferInputTokens: 20_000,
      rolloverTokenLimit: 95_000,
      contextWindowTokenLimit: 111_193,
      currentLogicalInputTokens: 116_000,
    })).toEqual({
      estimatedEpochInputTokens: 96_000,
      effectiveRolloverTokenLimit: 95_000,
      shouldRollover: true,
    });
  });

  test("a fresh epoch that already starts above soft pressure uses remaining hard-window headroom", () => {
    expect(assessWebEpochPressure({
      baseLogicalInputTokens: 140_000,
      baseTransferInputTokens: 100_000,
      rolloverTokenLimit: 95_000,
      contextWindowTokenLimit: 111_193,
      currentLogicalInputTokens: 145_000,
    })).toEqual({
      estimatedEpochInputTokens: 105_000,
      effectiveRolloverTokenLimit: 111_193,
      shouldRollover: false,
    });
  });

  test("retained logical history below its baseline does not force unnecessary rollover", () => {
    expect(assessWebEpochPressure({
      baseLogicalInputTokens: 80_000,
      baseTransferInputTokens: 20_000,
      rolloverTokenLimit: 95_000,
      contextWindowTokenLimit: 111_193,
      currentLogicalInputTokens: 70_000,
    })).toMatchObject({ estimatedEpochInputTokens: 20_000, shouldRollover: false });
  });

  test("overflowed accumulated estimates are unknown instead of authorizing retention", () => {
    expect(assessWebEpochPressure({
      baseLogicalInputTokens: 0,
      baseTransferInputTokens: Number.MAX_SAFE_INTEGER,
      rolloverTokenLimit: 95_000,
      contextWindowTokenLimit: 111_193,
      currentLogicalInputTokens: 1,
    })).toBeUndefined();
  });
});
