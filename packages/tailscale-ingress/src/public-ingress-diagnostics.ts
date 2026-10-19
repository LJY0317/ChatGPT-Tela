import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { request } from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";

/** On-demand transport evidence, independent of MagicDNS and MCP admission. */
export async function diagnosePublicIngress(endpoint: URL, resolverUrl: string): Promise<Record<string, unknown>> {
  const resolver = new URL(resolverUrl);
  resolver.searchParams.set("name", endpoint.hostname);
  resolver.searchParams.set("type", "A");
  const scope = { observationScope: "this-machine-via-public-dns", externalClientReachability: "not-observed" };
  let addresses: string[];
  try {
    const response = await fetch(resolver, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return { ...scope, state: "unavailable", stage: "dns", httpStatus: response.status };
    const dns = await response.json() as { Status?: number; Answer?: { type: number; data: string }[] };
    addresses = [...new Set((dns.Answer ?? []).filter(row => row.type === 1 && isIP(row.data) === 4).map(row => row.data))].slice(0, 8);
    if (dns.Status !== 0 || !addresses.length) return { ...scope, state: "unavailable", stage: "dns", dnsStatus: dns.Status, addressCount: addresses.length };
  } catch (error) {
    return { ...scope, state: "unavailable", stage: "dns", errorName: error instanceof Error ? error.name : "unknown" };
  }
  const relays = await Promise.all(addresses.map((address, index) => new Promise<Record<string, unknown>>(resolve => {
    const started = performance.now();
    let tcpConnected = false, tlsConnected = false, settled = false;
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      const durationMs = Math.round(performance.now() - started);
      emitDiagnosticEvent("chatgpt_tela_ingress", result.state === "unavailable" ? "public_relay_failed" : "public_relay_observed", {
        relay_index: index, tcp_connected: tcpConnected, tls_connected: tlsConnected, duration_ms: durationMs,
        phase: String(result.stage), ...(typeof result.httpStatus === "number" ? { http_status: result.httpStatus } : {}),
        ...(typeof result.errorCode === "string" ? { failure_class: result.errorCode } : {}),
      });
      resolve({ index, tcpConnected, tlsConnected, durationMs, ...result });
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
  return { ...scope, state: relays.every(row => row.state === "http-response") ? "http-responsive" : "unavailable",
    addressCount: addresses.length, relays, mcpContract: "not-probed" };
}
