import { diagnosticSourcePaths, inspectNativeThread } from "@chatgpt-tela/core";
import { connectCodexAppServerWebSocket, type CodexAppServerRpc } from "@chatgpt-tela/codex";
import type { CodexService } from "./controller";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * A bounded read-only Codex-service operation. Chat uses only the authenticated
 * service protocol: it must not import Native RPC, Desktop or browser runtimes.
 * A profile's active browser is not proof it belongs to this Native thread.
 */
export function createCodexWorkInspector(input: {
  readonly service: Pick<CodexService, "profiles" | "terminalSession">;
  readonly logsRoot: string;
  readonly connect?: typeof connectCodexAppServerWebSocket;
}) {
  return async (slot: number, threadId: string, minutes = 30) => {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99 || !UUID.test(threadId)
      || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) {
      throw new Error("work inspection requires a valid slot, thread UUID and 1-120-minute window");
    }
    const session = await input.service.terminalSession(slot);
    const rpc: CodexAppServerRpc = await (input.connect ?? connectCodexAppServerWebSocket)(session.endpoint,
      { signal: AbortSignal.timeout(10_000) });
    let thread: Awaited<ReturnType<typeof inspectNativeThread>>;
    try {
      thread = await inspectNativeThread({
        rpc, slot, threadId, minutes,
        diagnosticPaths: diagnosticSourcePaths(input.logsRoot),
      });
    } finally {
      await rpc.close().catch(() => {});
    }
    return Object.freeze({
      ...thread,
      observedAt: new Date().toISOString(),
      browser: undefined,
    });
  };
}
