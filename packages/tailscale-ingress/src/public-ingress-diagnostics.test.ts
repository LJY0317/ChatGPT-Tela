import { expect, test, spyOn } from "bun:test";
import * as https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeDiagnosticEvents } from "@chatgpt-tela/core";
import { diagnosePublicIngress } from "./public-ingress-diagnostics";

test("on-demand ingress snapshot keeps only structural local state and never gates DNS evidence", async () => {
  const rows: unknown[] = [], calls: string[][] = [];
  const stop = observeDiagnosticEvents(row => rows.push(row));
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ Status: 0, Answer: [] }), { preconnect: globalThis.fetch.preconnect }));
  try {
    const result = await diagnosePublicIngress(new URL("https://fixture.invalid/mcp"), "https://resolver.invalid", {
      async run(args) {
        calls.push([...args]);
        return { stderr: "", stdout: JSON.stringify(args[0] === "status"
          ? { Version: "1.104.2-extra-build", BackendState: "Running", Self: { Online: true, DNSName: "private-host" }, Health: ["private-health"],
            Peer: { private: { Tags: ["tag:ingress"], DNSName: "private-peer" } } }
          : { AllowFunnel: { "private-host:443": true }, Web: { private: { Proxy: "private-proxy" } } }) };
      },
    });
    expect(result).toMatchObject({ stage: "dns", localState: { status_observed: true, routes_observed: true,
      state: "running", node_online: true, health_count: 1, ingress_peer_count: 1, funnel_enabled_count: 1, tailscale_major: 1, tailscale_minor: 104, tailscale_patch: 2 } });
    const events = rows as Record<string, unknown>[];
    const start = events.find(row => row.stage === "public_ingress_probe_started")!;
    const end = events.find(row => row.stage === "public_ingress_probe_failed")!;
    expect(start.probe_fingerprint).toBe(result.probeFingerprint);
    expect(end).toMatchObject({ probe_fingerprint: result.probeFingerprint, state: "unavailable", phase: "dns", dns_status: 0 });
    expect(result.networkBefore).toMatchObject({ network_observed: true });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify({ rows, result })).not.toMatch(/private-host|private-health|private-peer|private-proxy/);
    const failed = await diagnosePublicIngress(new URL("https://fixture.invalid/mcp"), "https://resolver.invalid", {
      async run() { throw Error("private-failure"); },
    });
    expect(failed).toMatchObject({ stage: "dns", localState: { status_observed: false, routes_observed: false } });
    expect(failed.probeFingerprint).not.toBe(result.probeFingerprint);
    expect(JSON.stringify(rows)).not.toContain("private-failure");
  } finally { fetchMock.mockRestore(); stop?.(); }
});


test("public failure retains TLS cause and aggregate incident; mixed relays and MCP are separate evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-public-diagnostic-"));
  const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = join(root, "gateway.diagnostics.jsonl");
  const dns = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ Status: 0, Answer: [
    { type: 1, data: "192.0.2.1" }, { type: 1, data: "192.0.2.2" },
  ] }), { preconnect: globalThis.fetch.preconnect }));
  let failAll = true, verifiedCalls = 0, snapshots = 0;
  const mock = spyOn(https, "request").mockImplementation(((url: URL, options: any, callback: any) => {
    let address: string | undefined;
    options.lookup(url.hostname, {}, (_error: unknown, value: string) => { address = value; });
    expect(url.href).toBe("https://private-host.invalid/mcp");
    expect(options.rejectUnauthorized).not.toBe(false);
    const req = new EventEmitter() as any;
    req.end = () => { queueMicrotask(() => {
      const socket = new EventEmitter(); req.emit("socket", socket); socket.emit("connect");
      if (failAll || address === "192.0.2.1") { req.emit("error", Object.assign(new Error("private socket detail"), { code: "ERR_SOCKET_CLOSED" })); return; }
      socket.emit("secureConnect");
      const response = Readable.from(["private-body"]) as any;
      response.statusCode = 400; response.headers = { "content-type": "application/json" };
      callback(response);
    }); return req; };
    return req;
  }) as typeof https.request);
  const runner = { async run(args: readonly string[]) {
    if (args[0] === "debug") return { stdout: "peerapi_ingress 7", stderr: "" };
    if (args[0] === "status") { snapshots++; return { stdout: JSON.stringify({ BackendState: "Running", Self: { Online: true }, Peer: {} }), stderr: "" }; }
    return { stdout: "{}", stderr: "" };
  } };
  try {
    const failed = await diagnosePublicIngress(new URL("https://private-host.invalid/mcp"), "https://resolver.invalid", runner);
    expect(failed).toMatchObject({ state: "unavailable", stage: "tls", responsiveCount: 0, localIngress: { delta: 0 }, localStateAfter: { node_online: true } });
    await new Promise(resolve => setImmediate(resolve));
    const persisted = readFileSync(process.env.CHATGPT_TELA_DIAGNOSTIC_FILE!, "utf8");
    expect(persisted).toContain('"failure_class":"err_socket_closed"');
    expect(persisted).toContain('"stage":"public_ingress_probe_failed"');
    const incidentFiles = readdirSync(join(root, "diagnostics", "incidents"));
    expect(incidentFiles.some(file => readFileSync(join(root, "diagnostics", "incidents", file), "utf8").includes('public_ingress_probe_failed'))).toBe(true);
    expect(persisted).not.toMatch(/private-host|private-body|private socket|192\.0\.2/);
    failAll = false;
    const mixed = await diagnosePublicIngress(new URL("https://private-host.invalid/mcp"), "https://resolver.invalid", runner);
    expect(mixed).toMatchObject({ state: "http-responsive", responsiveCount: 1, mcpContract: "not-probed" });
    const mismatch = await diagnosePublicIngress(new URL("https://private-host.invalid/mcp"), "https://resolver.invalid", runner, {
      async verify(fetch, signal) {
        verifiedCalls++;
        const response = await fetch("https://private-host.invalid/mcp", { method: "POST", body: "{}", signal });
        expect(response.status).toBe(400);
        expect(await response.text()).toBe("private-body");
        return { ready: false };
      },
    });
    expect(mismatch).toMatchObject({ state: "unavailable", stage: "mcp", mcpContract: "failed" });
    expect(verifiedCalls).toBe(1);
    expect(snapshots).toBe(6);
  } finally {
    mock.mockRestore(); dns.mockRestore();
    if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE; else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
    // Deferred incident writes must finish before removing the isolated store.
    await new Promise(resolve => setImmediate(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
