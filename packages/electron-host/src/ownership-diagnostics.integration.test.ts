import { expect, test } from "bun:test";
import { diagnosticFingerprint, emitDiagnosticEvent, observeDiagnosticEvents, summarizeContextContinuity, withDiagnosticContext,
  type StructuralDiagnosticEvent } from "@chatgpt-tela/core";
import { createElectronBrowserHost, type ElectronBrowserWindowLike } from "./host";
import type { ElectronWebContentsLike } from "./page-automation";

test("production Electron host lease reaches renderer failure attribution through the shared webRequest adapter", async () => {
  let sent: ((details: any) => void) | undefined;
  let response: ((details: any) => void) | undefined;
  let failed: ((details: any) => void) | undefined;
  const webRequest = {
    onSendHeaders(listener: any) { sent = listener ?? undefined; },
    onResponseStarted(listener: any) { response = listener ?? undefined; },
    onErrorOccurred(listener: any) { failed = listener ?? undefined; },
    onCompleted(_listener: any) {},
  };
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  let destroyed = false;
  const webContents = {
    id: 17,
    session: { webRequest },
    executeJavaScript: async () => 0,
    sendInputEvent() {},
    capturePage: async () => ({ toJPEG: () => new Uint8Array([1, 2, 3]) }),
    isDestroyed: () => destroyed,
    on(event: string, listener: (...args: any[]) => void) {
      const values = listeners.get(event) ?? new Set(); values.add(listener); listeners.set(event, values);
    },
    removeListener(event: string, listener: (...args: any[]) => void) { listeners.get(event)?.delete(listener); },
  } as unknown as ElectronWebContentsLike & { id: number; session: { webRequest: typeof webRequest } };
  const window: ElectronBrowserWindowLike = {
    webContents,
    async loadURL() {},
    show() {},
    hide() {},
    isDestroyed: () => destroyed,
    destroy() { destroyed = true; },
  };
  const rows: StructuralDiagnosticEvent[] = [];
  const priorEnvironment = process.env.CHATGPT_TELA_DIAGNOSTIC_ENVIRONMENT;
  process.env.CHATGPT_TELA_DIAGNOSTIC_ENVIRONMENT = "runtime";
  const stop = observeDiagnosticEvents(row => rows.push(row));
  const taskId = "integration-native-task";
  const scope = diagnosticFingerprint(taskId);
  const turn = diagnosticFingerprint("integration-native-turn");
  const request = diagnosticFingerprint("integration-native-request");
  const operation = diagnosticFingerprint("integration-native-operation");
  const host = createElectronBrowserHost({ profileId: "integration-profile", createWindow: () => window });
  let leaseId: string | undefined;
  try {
    const surface = await host.acquire({ taskId, epochId: "integration-web-epoch" });
    leaseId = surface.leaseId;
    const bound = rows.find(row => row.stage === "renderer_surface_bound");
    expect(bound?.lease_fingerprint).toBe(diagnosticFingerprint(surface.leaseId));
    expect(typeof sent).toBe("function");
    expect(typeof response).toBe("function");
    expect(typeof failed).toBe("function");

    withDiagnosticContext({ scope_fingerprint: scope, turn_fingerprint: turn, request_fingerprint: request,
      operation_fingerprint: operation, lease_fingerprint: diagnosticFingerprint(surface.leaseId) }, () => {
      emitDiagnosticEvent("chatgpt_tela_work", "web_turn_plan", { context_mode: "retained-delta" });
    });
    const details = { id: 91, webContentsId: 17, url: "https://chatgpt.com/backend-api/conversation?private=1",
      method: "POST", resourceType: "xhr", fromCache: false, timestamp: 1000 };
    sent!(details);
    response!({ ...details, timestamp: 1100, statusCode: 200,
      responseHeaders: { "content-type": ["text/event-stream; charset=utf-8"] } });
    failed!({ ...details, timestamp: 1200, statusCode: 200,
      responseHeaders: { "content-type": ["text/event-stream; charset=utf-8"] }, error: "net::ERR_ABORTED" });
    withDiagnosticContext({ scope_fingerprint: scope, turn_fingerprint: turn, request_fingerprint: request }, () => {
      emitDiagnosticEvent("chatgpt_tela_work", "web_turn_failed");
    });

    const network = rows.find(row => row.stage === "renderer_request_failed");
    expect(network).toMatchObject({ surface_fingerprint: bound?.surface_fingerprint,
      lease_fingerprint: bound?.lease_fingerprint, browser_response: "event_stream", failure_class: "err_aborted" });
    const report = summarizeContextContinuity({ events: rows, atMs: Date.now(), scope });
    expect(report.turns).toHaveLength(1);
    expect(report.turns[0]?.turnFingerprint).toBe(turn);
    expect(report.turns[0]?.browserNetworkFailures).toHaveLength(1);
    expect(report.turns[0]?.browserNetworkFailures[0]).toMatchObject({
      failureClass: "err_aborted", httpStatus: 200, attribution: "surface_lease_and_active_plan",
    });
  } finally {
    if (leaseId) await host.release(leaseId);
    await host.close();
    stop?.();
    if (priorEnvironment === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_ENVIRONMENT;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_ENVIRONMENT = priorEnvironment;
  }
});
