export const DEFAULT_PROFILE_SLOT = 1;

export function profileSlotFromArguments(
  arguments_: readonly string[],
  fallback = DEFAULT_PROFILE_SLOT,
): number {
  const indexes = arguments_
    .map((value, index) => value === "--slot" ? index : -1)
    .filter(index => index >= 0);
  if (indexes.length > 1) throw new Error("--slot may be specified only once");
  if (indexes.length === 0) return fallback;
  const raw = arguments_[indexes[0]! + 1];
  if (!raw || raw.startsWith("--")) throw new Error("--slot requires a value");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 99) {
    throw new Error("--slot must be an integer from 1 to 99");
  }
  return value;
}
