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

/** A caller hint selects a default, never an authorization boundary. Explicit
 * --slot wins; existing jobs retain their recorded thread/profile separately. */
export async function delegationProfileSlot(arguments_: readonly string[], input: {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly findCallerProfile?: (threadId: string) => Promise<number | undefined>;
} = {}): Promise<number> {
  if (arguments_.includes("--slot")) return profileSlotFromArguments(arguments_);
  const environment = input.environment ?? process.env;
  const hint = Number(environment.CHATGPT_TELA_PRODUCT_PROFILE_SLOT);
  if (Number.isSafeInteger(hint) && hint >= 1 && hint <= 99) return hint;
  const caller = environment.CODEX_THREAD_ID && input.findCallerProfile
    ? await input.findCallerProfile(environment.CODEX_THREAD_ID) : undefined;
  return caller ?? DEFAULT_PROFILE_SLOT;
}
