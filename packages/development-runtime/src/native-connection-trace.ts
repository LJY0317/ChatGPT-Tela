import { AsyncLocalStorage } from "node:async_hooks";
import { subscribe } from "node:diagnostics_channel";
import { isIP, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { performance } from "node:perf_hooks";
import { diagnosticFingerprint, networkFailureDiagnostics, type DiagnosticScalar } from "@chatgpt-tela/core";

const active = new AsyncLocalStorage<NativeConnectionTrace>();
type Fields = Record<string, DiagnosticScalar>;
// Passive runtime channels, isolated here because availability differs across runtimes.
subscribe("net.client.socket", message => {
  try { active.getStore()?.observeSocket((message as { socket: Socket }).socket); } catch { /* Diagnostics only. */ }
});
subscribe("undici:client:connected", message => {
  try { active.getStore()?.connected((message as { socket: Socket & { encrypted?: boolean } }).socket); } catch { /* Diagnostics only. */ }
});

/** Request-scoped, bounded, payload-free observation. Never creates or configures a socket. */
export class NativeConnectionTrace {
  readonly #started = performance.now();
  readonly #events: Fields[] = [];
  readonly #detach: (() => void)[] = [];
  readonly #sockets = new Set<Socket>();
  readonly #counts: Fields = { socket_count: 0, lookup_count: 0, ipv4_lookup_count: 0, ipv6_lookup_count: 0,
    connect_attempt_count: 0, connect_timeout_count: 0, connect_failed_count: 0, tcp_observed: false, tls_observed: false };
  #stopped = false;
  #complete = true;

  run<T>(operation: () => T): T { return active.run(this, operation); }
  #record(phase: string, fields: Fields = {}): void {
    if (this.#stopped) return;
    if (this.#events.length >= 48) { this.#complete = false; return; }
    const elapsed = Math.round(performance.now() - this.#started);
    if (["lookup", "tcp_connected", "tls_connected", "client_connected"].includes(phase))
      this.#counts[`${phase}_elapsed_ms`] = elapsed;
    this.#events.push({ ...fields, phase, elapsed_ms: elapsed });
  }
  #address(address: unknown, family: unknown): Fields {
    return { address_family: typeof address === "string" ? isIP(address) : typeof family === "number" ? family : 0,
      ...(typeof address === "string" && isIP(address) ? { address_fingerprint: diagnosticFingerprint(address) } : {}) };
  }
  observeSocket(socket: Socket): void {
    if (this.#stopped || !socket || this.#sockets.has(socket)) return;
    if (this.#sockets.size >= 8) { this.#complete = false; return; }
    this.#sockets.add(socket); this.#counts.socket_count = this.#sockets.size;
    const on = (name: string, callback: (...args: any[]) => void) => {
      const isolated = (...args: any[]) => { try { callback(...args); } catch { this.#complete = false; } };
      socket.on(name, isolated); this.#detach.push(() => socket.removeListener(name, isolated));
    };
    on("lookup", (error, address, family) => {
      this.#counts.lookup_count = Number(this.#counts.lookup_count) + 1;
      if (family === 4 || family === 6) {
        const key = family === 4 ? "ipv4_lookup_count" : "ipv6_lookup_count";
        this.#counts[key] = Number(this.#counts[key]) + 1;
      }
      this.#record("lookup", { ...this.#address(address, family), ...(error ? networkFailureDiagnostics(error) : {}) });
    });
    for (const [name, counter, phase] of [
      ["connectionAttempt", "connect_attempt_count", "connect_attempt"],
      ["connectionAttemptTimeout", "connect_timeout_count", "connect_timeout"],
      ["connectionAttemptFailed", "connect_failed_count", "connect_failed"],
    ] as const) on(name, (address, port, family, error) => {
      this.#counts[counter] = Number(this.#counts[counter]) + 1;
      this.#record(phase, { ...this.#address(address, family), tls_port: port === 443,
        ...(error ? networkFailureDiagnostics(error) : {}) });
    });
    on("connect", () => { this.#counts.tcp_observed = true; this.#record("tcp_connected"); });
    on("secureConnect", () => { this.#counts.tls_observed = true; this.#record("tls_connected"); });
    // Do not add an error listener: observing must not change unhandled-error behavior.
  }
  connected(socket: Socket & { encrypted?: boolean }): void {
    if (this.#stopped) return;
    this.#counts.tcp_observed = true;
    if (socket?.encrypted === true) this.#counts.tls_observed = true;
    this.#record("client_connected", { tls_observed: socket?.encrypted === true });
  }
  stop(): void {
    this.#stopped = true;
    for (const detach of this.#detach) detach();
    this.#detach.length = 0; this.#sockets.clear();
  }
  fields(): Fields {
    return { ...this.#counts, trace_complete: this.#complete, trace_event_count: this.#events.length,
      socket_trace_observed: Number(this.#counts.socket_count) > 0 };
  }
  evidence(): readonly Fields[] { return this.#events; }
}

/** Failure-time interface shape only; no names, addresses, MACs or route mutations. */
export function nativeInterfaceShape(): Fields {
  const fields: Fields = { interface_ipv4_count: 0, interface_ipv6_count: 0, interface_ipv6_nonlocal_count: 0 };
  try {
    for (const addresses of Object.values(networkInterfaces())) for (const item of addresses ?? []) {
      if (item.internal) continue;
      const key = item.family === "IPv4" ? "interface_ipv4_count" : "interface_ipv6_count";
      fields[key] = Number(fields[key]) + 1;
      if (item.family === "IPv6" && !/^(fe[89ab]|f[cd])/i.test(item.address))
        fields.interface_ipv6_nonlocal_count = Number(fields.interface_ipv6_nonlocal_count) + 1;
    }
    fields.interfaces_observed = true;
  } catch { fields.interfaces_observed = false; }
  return fields;
}
