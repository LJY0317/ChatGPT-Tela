/** Setup owns a login window, never a Native turn. Failed proof must leave login available. */
export function createSetupCompletion(input: {
  readonly verify: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly needsLogin: () => Promise<void>;
}) {
  let pending: Promise<void> | undefined;
  let closed = false;
  const run = (verify: boolean): Promise<void> => {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    // Publish the pending operation before close() can synchronously emit another window event.
    pending = Promise.resolve().then(async () => {
      if (verify) {
        try { await input.verify(); }
        catch { await input.needsLogin(); return; }
      }
      await input.close();
      closed = true;
      input.exit(verify ? 0 : 2);
    }).finally(() => { pending = undefined; });
    return pending;
  };
  return { finish: () => run(true), cancel: () => run(false) };
}
