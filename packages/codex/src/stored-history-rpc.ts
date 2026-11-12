import { capturePrivateDiagnosticValue, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { spawn } from "node:child_process";
import type { CodexAppServerRpc } from "./app-server";

/** Disposable metadata reader from the official installation. No model/turn or mutation methods. */
export async function connectStoredHistoryRpc(input: {
  executable: string; codexHome: string; threadId: string; signal?: AbortSignal;
}): Promise<CodexAppServerRpc> {
  input.signal?.throwIfAborted();
  const child = spawn(input.executable, ["app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: input.codexHome }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  });
  let sequence = 0, buffer = "", broken = false;
  const pending = new Map<number, { method: string; resolve(value: unknown): void; reject(error: unknown): void }>();
  const fail = (error: unknown, reason = "reader_closed") => {
    for (const p of pending.values()) {
      emitDiagnosticEvent("chatgpt_tela_codex", "stored_history_read_failed", { phase: p.method.replaceAll("/", "_"), reason_class: reason });
      p.reject(error);
    }
    pending.clear();
  };
  child.on("error", error => fail(error, "process_error"));
  child.stdin.on("error", error => fail(error, "stream_error"));
  const exited = new Promise<void>(resolve => child.once("close", () => { fail(Error("Stored history reader closed")); resolve(); }));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (broken) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { broken = true; buffer = ""; fail(Error("Stored history response exceeds the bounded frame size"), "frame_budget"); child.stdin.end(); return; }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (typeof message.method === "string") continue;
        const p = pending.get(message.id);
        if (!p) continue;
        pending.delete(message.id);
        if (message.error) {
          emitDiagnosticEvent("chatgpt_tela_codex", "stored_history_read_failed", { phase: p.method.replaceAll("/", "_"), reason_class: "rpc_error",
            ...(Number.isSafeInteger(message.error.code) ? { rpc_error_code: message.error.code } : {}) });
          capturePrivateDiagnosticValue("context_preload_failure", { method: p.method, threadId: input.threadId, error: message.error });
          p.reject(Error("Official stored history request failed"));
        } else p.resolve(message.result);
      } catch { broken = true; buffer = ""; fail(Error("Official stored history returned invalid JSON"), "invalid_json"); child.stdin.end(); return; }
    }
  });
  const send = (method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const abort = () => { pending.delete(id); reject(signal?.reason ?? Error("Stored history read cancelled")); };
      signal?.addEventListener("abort", abort, { once: true });
      const finish = (callback: (value: any) => void) => (value: unknown) => { signal?.removeEventListener("abort", abort); callback(value); };
      pending.set(id, { method, resolve: finish(resolve), reject: finish(reject) });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => { if (error) { pending.get(id)?.reject(error); pending.delete(id); } });
    });
  };
  const close = async () => { child.stdin.end(); await exited; };
  try {
    await send("initialize", { clientInfo: { name: "tela-stored-history", version: "1" }, capabilities: { experimentalApi: true } }, input.signal);
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  } catch (error) { await close(); throw error; }
  return { close, request(method, params, signal) {
    const p = params as Record<string, unknown> | undefined;
    if (!["thread/read", "thread/items/list", "thread/turns/list"].includes(method) || p?.threadId !== input.threadId
      || method === "thread/read" && p.includeTurns !== false
      || method === "thread/turns/list" && p.itemsView !== "notLoaded") {
      return Promise.reject(Error("Stored history reader permits only scoped indexed reads"));
    }
    return send(method, params, signal ?? input.signal);
  } };
}
