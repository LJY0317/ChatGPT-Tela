export interface ChatShutdownSignals {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** Coalesce explicit shutdown requests; a refusal keeps the daemon and its signal handling alive.
 * No timer, retry loop, signal escalation or operation cancellation is introduced.
 */
export async function waitForChatShutdown(input: {
  readonly shutdownRequested: Promise<void>;
  readonly signals: ChatShutdownSignals;
  readonly close: () => Promise<void>;
  readonly refused: () => void;
}): Promise<void> {
  let pending = false;
  let wake: (() => void) | undefined;
  const request = () => { pending = true; wake?.(); };
  input.signals.on("SIGINT", request);
  input.signals.on("SIGTERM", request);
  void input.shutdownRequested.then(request);
  try {
    while (true) {
      if (!pending) await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
      pending = false;
      try { await input.close(); return; }
      catch { input.refused(); }
      // Await another explicit request. Refusal never turns into automatic termination/retry.
    }
  } finally {
    wake = undefined;
    input.signals.removeListener("SIGINT", request);
    input.signals.removeListener("SIGTERM", request);
  }
}
