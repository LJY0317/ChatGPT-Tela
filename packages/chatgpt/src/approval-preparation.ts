/** Mechanical approval preparation only; this scope never dispatches browser input. */
const PREPARATION_TIMEOUT_MS = 5_000;

export async function prepareApprovalWithinDeadline<T>(
  prepare: (signal: AbortSignal) => Promise<T>,
  ownerSignal?: AbortSignal,
  consentDelayMs = 0,
): Promise<T> {
  const scope = new AbortController();
  const forwardAbort = () => scope.abort(ownerSignal!.reason);
  let rejectAborted!: () => void;
  const expired = new Promise<never>((_, reject) => {
    rejectAborted = () => reject(scope.signal.reason);
    scope.signal.addEventListener("abort", rejectAborted, { once: true });
  });
  ownerSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => scope.abort(new DOMException(
    "ChatGPT approval preparation timed out before input dispatch", "TimeoutError",
  )), PREPARATION_TIMEOUT_MS + consentDelayMs);
  if (ownerSignal?.aborted) forwardAbort();
  try {
    // Attach handlers to both outcomes, including a provider which ignores cancellation.
    // Its late scroll/read completion can never reach the caller's dispatch boundary.
    return await Promise.race([expired, Promise.resolve().then(() => {
      scope.signal.throwIfAborted();
      return prepare(scope.signal);
    })]);
  } finally {
    clearTimeout(timer);
    ownerSignal?.removeEventListener("abort", forwardAbort);
    scope.signal.removeEventListener("abort", rejectAborted);
  }
}
