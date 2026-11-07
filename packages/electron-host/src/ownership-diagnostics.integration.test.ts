import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticFingerprint, emitDiagnosticEvent, listDiagnosticIncidents, observeDiagnosticEvents, readDiagnosticIncident,
  readDiagnosticTail, setPrivateDiagnosticCapture, summarizeContextContinuity, withDiagnosticContext,
  type StructuralDiagnosticEvent } from "@chatgpt-tela/core";
import { captureBrowserDiagnosticEvidence } from "@chatgpt-tela/browser-host";
import { createElectronBrowserHost, type ElectronBrowserWindowLike } from "./host";
import type { ElectronWebContentsLike } from "./page-automation";

test("production Electron host lease reaches renderer failure attribution through the shared webRequest adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-electron-owned-diagnostic-capture-"));
  const priorFile = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  const priorEnvironment = process.env.CHATGPT_TELA_DIAGNOSTIC_ENVIRONMENT;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = join(root, "events.jsonl");
  process.env.CHATGPT_TELA_DIAGNOSTIC_ENVIRONMENT = "runtime";
  const diagnosticRoot = join(root, "diagnostics");
  setPrivateDiagnosticCapture(diagnosticRoot, "until-disabled");
  let sent: ((details: any) => void) | undefined;
  let response: ((details: any) => void) | undefined;
  let failed: ((details: any) => void) | undefined;
  let evaluations = 0;
  let previews = 0;
  const documentHtml = "<html><body>private Electron document fixture</body></html>";
  const focusHtml = "<main>private latest turn fixture</main>";
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
    executeJavaScript: async (code: string) => {
      if (code.includes("function(privateCapture)")) {
        evaluations++;
        return { element_count: 4, capture_safe: true, html: documentHtml, focus_html: focusHtml };
      }
      return 0;
    },
    sendInputEvent() {},
    capturePage: async () => ({ toJPEG: () => { previews++; return new Uint8Array([1, 2, 3]); } }),
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
    await withDiagnosticContext({ scope_fingerprint: scope, turn_fingerprint: turn, request_fingerprint: request,
      operation_fingerprint: operation, lease_fingerprint: diagnosticFingerprint(surface.leaseId) }, async () => {
      await captureBrowserDiagnosticEvidence(surface, "turn_failure");
      emitDiagnosticEvent("chatgpt_tela_work", "web_turn_failed");
    });
    await new Promise<void>(resolve => setImmediate(resolve));

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
    expect(evaluations).toBe(1);
    expect(previews).toBe(1);
    const incidents = listDiagnosticIncidents(diagnosticRoot, true);
    const failureIncident = incidents.find(item => item.stage === "web_turn_failed");
    expect(failureIncident).toBeDefined();
    const incident = readDiagnosticIncident(diagnosticRoot, failureIncident!.ref) as any;
    expect(incident.failure).toMatchObject({ stage: "web_turn_failed", operation_fingerprint: operation,
      turn_fingerprint: turn, lease_fingerprint: diagnosticFingerprint(surface.leaseId) });
    expect(incident.privateArtifactCount).toBe(3);
    expect(incident.availablePrivateArtifactCount).toBe(3);
    expect(incident.privateArtifacts.map((item: any) => item.kind).sort()).toEqual(["html", "html", "jpg"]);
    for (const item of incident.privateArtifacts) {
      const bytes = readFileSync(join(diagnosticRoot, "private", `${item.ref}.${item.kind}`));
      if (item.kind === "jpg") expect(bytes).toEqual(Buffer.from([1, 2, 3]));
      else expect([documentHtml, focusHtml]).toContain(bytes.toString("utf8"));
    }
    const metadata = readdirSync(join(diagnosticRoot, "private")).filter(name => name.endsWith(".meta.json"))
      .map(name => JSON.parse(readFileSync(join(diagnosticRoot, "private", name), "utf8")));
    expect(metadata).toHaveLength(3);
    expect(metadata.every(item => item.operationFingerprint === operation && item.evidenceClass === "failure")).toBe(true);
    expect(readDiagnosticTail(join(root, "events.jsonl")).events.find(row => row.stage === "private_capture_recorded"))
      .toMatchObject({ operation_fingerprint: operation, retained_count: 3, omitted_count: 0 });
  } finally {
    if (leaseId) await host.release(leaseId);
    await host.close();
    stop?.();
    if (priorFile === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = priorFile;
    if (priorEnvironment === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_ENVIRONMENT;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_ENVIRONMENT = priorEnvironment;
    rmSync(root, { recursive: true, force: true });
  }
});
