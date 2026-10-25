import type { TailscaleCommandRunner } from "./index";
import { diagnosticFingerprint, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { request } from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";

function networkSnapshot(): Record<string, string | number | boolean> {
  try {
    const links = Object.entries(networkInterfaces()).flatMap(([name, rows]) =>
      (rows ?? []).filter(row => !row.internal).map(row => ({ name, family: row.family, address: row.address, netmask: row.netmask })))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { network_observed: true, network_fingerprint: diagnosticFingerprint(JSON.stringify(links)),
      ipv4_count: links.filter(row => row.family === "IPv4").length,
      ipv6_count: links.filter(row => row.family === "IPv6").length };
  } catch { return { network_observed: false }; }
}

export interface IngressCounterEvidence {
  readonly observed: boolean;
  readonly before?: number;
  readonly after?: number;
  readonly delta?: number;
  readonly counterResetObserved?: boolean;
}

async function ingressCounter(runner?: TailscaleCommandRunner): Promise<number | undefined> {
  if (!runner) return undefined;
  try {
    const result = await runner.run(["debug", "metrics"], AbortSignal.timeout(4000));
    const match = /^peerapi_ingress ([0-9]+)$/m.exec(result.stdout);
    const value = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(value) ? value : undefined;
  } catch { return undefined; }
}

/** Fixed-field local snapshot only; never log status bodies, peers, routes or health text. */
async function localIngressState(runner: TailscaleCommandRunner, probeFingerprint: string): Promise<Record<string, string | number | boolean>> {
  const results = await Promise.allSettled([runner.run(["status", "--json"], AbortSignal.timeout(4000)),
    runner.run(["funnel", "status", "--json"], AbortSignal.timeout(4000))]);
  const state: Record<string, string | number | boolean> = { status_observed: false, routes_observed: false };
  try {
    if (results[0]!.status === "fulfilled") {
      const status = JSON.parse(results[0]!.value.stdout);
      const backend = status.BackendState;
      state.status_observed = true;
      const version = typeof status.Version === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(status.Version) : undefined;
      if (version) { state.tailscale_major = Number(version[1]); state.tailscale_minor = Number(version[2]); state.tailscale_patch = Number(version[3]); }
      state.state = ["Running", "Stopped", "NeedsLogin", "NeedsMachineAuth", "Starting", "NoState", "InUseOtherUser"].includes(backend) ? backend.toLowerCase() : "unknown";
      if (typeof status.Self?.Online === "boolean") state.node_online = status.Self.Online;
      state.health_count = Array.isArray(status.Health) ? status.Health.length : 0;
      state.ingress_peer_count = Object.values(status.Peer ?? {}).filter((peer: unknown) => peer !== null && typeof peer === "object" && "Tags" in peer && Array.isArray(peer.Tags) && peer.Tags.includes("tag:ingress")).length;
    }
  } catch { /* diagnostic parse failure must not affect the probe */ }
  try {
    if (results[1]!.status === "fulfilled") {
      const routes = JSON.parse(results[1]!.value.stdout);
      state.routes_observed = true;
      state.route_fingerprint = diagnosticFingerprint(JSON.stringify(routes));
      state.funnel_enabled_count = Object.values(routes.AllowFunnel ?? {}).filter(value => value === true).length;
    }
  } catch { /* same boundary: preserve transport evidence even without a snapshot */ }
  emitDiagnosticEvent("chatgpt_tela_ingress", "public_ingress_local_snapshot", { probe_fingerprint: probeFingerprint, ...state });
  return state;
}

/** On-demand transport evidence, independent of MagicDNS and MCP admission. */
export async function diagnosePublicIngress(endpoint: URL, resolverUrl: string, runner?: TailscaleCommandRunner): Promise<Record<string, unknown> & { localIngress?: IngressCounterEvidence }> {
  const probeFingerprint = diagnosticFingerprint(randomUUID()), networkBefore = networkSnapshot();
  const identity = { probe_fingerprint: probeFingerprint, endpoint_fingerprint: diagnosticFingerprint(endpoint.origin + endpoint.pathname) };
  emitDiagnosticEvent("chatgpt_tela_ingress", "public_ingress_probe_started", { ...identity, ...networkBefore });
  const resolver = new URL(resolverUrl);
  resolver.searchParams.set("name", endpoint.hostname);
  resolver.searchParams.set("type", "A");
  const localState = runner ? await localIngressState(runner, probeFingerprint) : undefined;
  const scope = { probeFingerprint, networkBefore, ...(localState ? { localState } : {}), observationScope: "this-machine-via-public-dns", externalClientReachability: "not-observed" };
  const finish = (report: Record<string, unknown>) => {
    const networkAfter = networkSnapshot();
    emitDiagnosticEvent("chatgpt_tela_ingress", "public_ingress_probe_finished", { ...identity, ...networkAfter,
      state: String(report.state), ...(typeof report.stage === "string" ? { phase: report.stage } : {}),
      ...(typeof report.dnsStatus === "number" ? { dns_status: report.dnsStatus } : {}),
      ...(typeof report.httpStatus === "number" ? { http_status: report.httpStatus } : {}),
      ...(typeof report.errorName === "string" ? { failure_class: report.errorName } : {}) });
    return { ...scope, networkAfter, ...report };
  };
  let addresses: string[];
  try {
    const response = await fetch(resolver, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return finish({ state: "unavailable", stage: "dns", httpStatus: response.status });
    const dns = await response.json() as { Status?: number; Answer?: { type: number; data: string }[] };
    addresses = [...new Set((dns.Answer ?? []).filter(row => row.type === 1 && isIP(row.data) === 4).map(row => row.data))].slice(0, 8);
    if (dns.Status !== 0 || !addresses.length) return finish({ state: "unavailable", stage: "dns", dnsStatus: dns.Status, addressCount: addresses.length });
  } catch (error) {
    return finish({ state: "unavailable", stage: "dns", errorName: error instanceof Error ? error.name : "unknown" });
  }
  const before = await ingressCounter(runner);
  const relays = await Promise.all(addresses.map((address, index) => new Promise<Record<string, unknown>>(resolve => {
    const started = performance.now();
    let tcpConnected = false, tlsConnected = false, settled = false;
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      const durationMs = Math.round(performance.now() - started);
      emitDiagnosticEvent("chatgpt_tela_ingress", result.state === "unavailable" ? "public_relay_failed" : "public_relay_observed", {
        ...identity, relay_fingerprint: diagnosticFingerprint(address), relay_index: index, tcp_connected: tcpConnected, tls_connected: tlsConnected, duration_ms: durationMs,
        phase: String(result.stage), ...(typeof result.httpStatus === "number" ? { http_status: result.httpStatus } : {}),
        ...(typeof result.errorCode === "string" ? { failure_class: result.errorCode } : {}),
      });
      resolve({ index, relayFingerprint: diagnosticFingerprint(address), tcpConnected, tlsConnected, durationMs, ...result });
    };
    // Keep the original URL, Host, SNI and certificate validation. Only DNS is pinned.
    const req = request(endpoint, { method: "GET", agent: false, family: 4,
      lookup: (_host, _options, callback) => callback(null, address, 4),
      signal: AbortSignal.timeout(4000),
    }, response => {
      finish({ state: "http-response", stage: "http", httpStatus: response.statusCode });
      response.destroy();
    });
    req.on("socket", socket => {
      socket.once("connect", () => { tcpConnected = true; });
      socket.once("secureConnect", () => { tlsConnected = true; });
    });
    req.on("error", (error: NodeJS.ErrnoException) => finish({ state: "unavailable",
      stage: tlsConnected ? "http" : tcpConnected ? "tls" : "tcp", errorCode: error.code ?? error.name }));
    req.end();
  })));
  const after = await ingressCounter(runner);
  const observed = before !== undefined && after !== undefined;
  const localIngress: IngressCounterEvidence = { observed,
    ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}),
    ...(observed ? { counterResetObserved: after < before, ...(after >= before ? { delta: after - before } : {}) } : {}) };
  if (runner) emitDiagnosticEvent("chatgpt_tela_ingress", "local_ingress_counter_observed", {
    ...identity, observed, ...(observed ? { count_before: before, count_after: after, counter_reset_observed: after < before,
      ...(after >= before ? { count_delta: after - before } : {}) } : {}),
  });
  return finish({ ...(runner ? { localIngress } : {}), state: relays.every(row => row.state === "http-response") ? "http-responsive" : "unavailable",
    addressCount: addresses.length, relays, mcpContract: "not-probed" });
}
