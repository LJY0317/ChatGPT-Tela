import { createHash } from "node:crypto";
import type { CodexAppServerRpc, CodexAppServerRpcFactory } from "@chatgpt-tela/codex";

type Snapshot = { readonly type: string; readonly email?: string; readonly container?: string } | null;
export type NativeAccountInvalidation = "signed_out" | "account_changed" | "observation_unavailable";
function fingerprint(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 512) return undefined;
  return createHash("sha256").update(value).digest("hex");
}
function snapshot(value: unknown): Snapshot {
  if (!value || typeof value !== "object") throw new Error("Invalid Native account observation");
  const row = value as { account?: { type?: unknown; email?: unknown } | null; workspaceRouting?: { chatgptAccountId?: unknown } };
  if (row.account === null) return null;
  if (!row.account || typeof row.account.type !== "string" || !row.account.type) throw new Error("Invalid Native account observation");
  const email = fingerprint(row.account.email);
  const container = fingerprint(row.workspaceRouting?.chatgptAccountId);
  return { type: row.account.type, ...(email ? { email } : {}), ...(container ? { container } : {}) };
}
function changed(before: Snapshot, after: Snapshot): boolean {
  if (!before || !after) return before !== after;
  return before.type !== after.type
    || !!(before.email && after.email && before.email !== after.email)
    || !!(before.container && after.container && before.container !== after.container);
}

/** Event-driven observation; hashed comparison fields stay in memory and never establish user equality. */
export function startNativeAccountLifecycle(input: {
  readonly connect: CodexAppServerRpcFactory;
  readonly signal: AbortSignal;
  readonly invalidate: (reason: NativeAccountInvalidation) => Promise<void>;
}): { readonly ready: Promise<void>; stop(): Promise<void> } {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  let rpc: CodexAppServerRpc | undefined;
  let closedRpc: CodexAppServerRpc | undefined;
  const closeCurrent = async () => {
    if (!rpc || closedRpc === rpc) return;
    closedRpc = rpc;
    await rpc.close();
  };
  let unsubscribe: (() => void) | undefined;
  const detach = () => { unsubscribe?.(); unsubscribe = undefined; };
  let previous: Snapshot | undefined;
  let revision = 0;
  let reading: Promise<void> | undefined;
  let revoking: Promise<void> | undefined;
  const revoke = (reason: NativeAccountInvalidation) => {
    if (signal.aborted) return Promise.resolve();
    if (revoking) return revoking;
    const operation = input.invalidate(reason);
    revoking = operation;
    void operation.finally(() => { if (revoking === operation) revoking = undefined; }).catch(() => {});
    return operation;
  };
  const refresh = (): Promise<void> => {
    revision++;
    if (reading) return reading;
    const operation = (async () => {
      // At most two reads for one coalesced event burst. A continued burst cannot publish stale state.
      for (let attempt = 0; attempt < 2; attempt++) {
        const owner = revision;
        let value: Snapshot;
        try {
          signal.throwIfAborted();
          value = snapshot(await rpc!.request("account/read", { refreshToken: false },
            AbortSignal.any([signal, AbortSignal.timeout(15_000)])));
          signal.throwIfAborted();
        } catch {
          if (!signal.aborted) await revoke("observation_unavailable");
          return;
        }
        if (owner !== revision) continue;
        if (value === null && previous !== null) await revoke("signed_out");
        else if (previous !== undefined && changed(previous, value)) await revoke("account_changed");
        if (owner === revision) previous = value;
        else continue;
        return;
      }
      await revoke("observation_unavailable");
    })();
    reading = operation;
    void operation.finally(() => { if (reading === operation) reading = undefined; }).catch(() => {});
    return operation;
  };
  const ready = (async () => {
    try {
      rpc = await input.connect(AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
      signal.throwIfAborted();
      if (!rpc.subscribe) throw new Error("Native account notifications unavailable");
      unsubscribe = rpc.subscribe(method => {
        if (method === "account/updated" || method === "account/login/completed") void refresh().catch(() => {});
      }, () => { void revoke("observation_unavailable").catch(() => {}); });
    } catch {
      if (!signal.aborted) await revoke("observation_unavailable");
      return;
    }
    await refresh();
  })();
  let stopping: Promise<void> | undefined;
  return {
    ready,
    stop() {
      if (stopping) return stopping;
      controller.abort(new Error("Native account observer stopped"));
      detach();
      stopping = (async () => {
        await closeCurrent();
        await ready;
        detach();
        // A connection may complete after stop was requested; close that owned connection too.
        await closeCurrent();
        await reading;
        await revoking;
        previous = undefined;
      })();
      return stopping;
    },
  };
}
