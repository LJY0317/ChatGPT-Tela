import { expect, test } from "bun:test";
import { channel } from "node:diagnostics_channel";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { NativeConnectionTrace, nativeInterfaceShape } from "./native-connection-trace";

function socket() { return new EventEmitter() as Socket; }
test("connection traces isolate concurrent requests, bound evidence, and leave socket behavior intact", async () => {
  // Runtime channels must remain subscribed after an idle process is garbage-collected.
  Bun.gc(true);
  const first = new NativeConnectionTrace(), second = new NativeConnectionTrace();
  const a = socket(), b = socket(), foreign = socket();
  const before = a.listenerCount("error");
  channel("net.client.socket").publish({ socket: foreign });
  await Promise.all([
    first.run(async () => {
      await Promise.resolve(); channel("net.client.socket").publish({ socket: a });
      a.emit("lookup", null, "192.0.2.1", 4, "private-host");
      a.emit("connectionAttempt", "192.0.2.1", 443, 4);
      a.emit("connectionAttemptTimeout", "192.0.2.1", 443, 4);
      a.emit("connectionAttemptFailed", "2001:db8::1", 443, 6, Object.assign(Error("private error"), {code:"EHOSTUNREACH"}));
    }),
    second.run(async () => {
      await Promise.resolve(); channel("net.client.socket").publish({ socket: b }); b.emit("connect");
      channel("undici:client:connected").publish({ socket: { encrypted: true } });
    }),
  ]);
  expect(first.fields()).toMatchObject({ socket_count: 1, lookup_count: 1, connect_timeout_count: 1,
    connect_failed_count: 1, tcp_observed: false, tls_observed: false });
  expect(second.fields()).toMatchObject({ socket_count: 1, tcp_observed: true, tls_observed: true, connect_timeout_count: 0 });
  expect(a.listenerCount("error")).toBe(before);
  expect(foreign.eventNames()).toEqual([]);
  expect(JSON.stringify(first.evidence())).not.toMatch(/192\.0\.2\.1|2001:db8|private-host|private error/);
  expect(first.evidence().at(-1)).toMatchObject({ phase: "connect_failed", failure_class: "host_unreachable" });
  for (let i=0;i<60;i++) a.emit("lookup", null, "192.0.2.1", 4);
  expect(first.evidence()).toHaveLength(48); expect(first.fields().trace_complete).toBe(false);
  first.stop(); second.stop();
  expect(a.eventNames()).toEqual([]); expect(b.eventNames()).toEqual([]);
  const count = first.evidence().length; a.emit("connect"); expect(first.evidence()).toHaveLength(count);
});
test("unobserved transport and interface summaries do not claim connectivity or disclose identity", () => {
  const trace = new NativeConnectionTrace(); trace.stop();
  expect(trace.fields()).toMatchObject({ socket_trace_observed: false, tcp_observed: false, tls_observed: false });
  const shape = nativeInterfaceShape();
  expect(Object.values(shape).every(v => typeof v === "number" || typeof v === "boolean")).toBe(true);
});
