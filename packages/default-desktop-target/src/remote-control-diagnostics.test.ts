import { expect, test } from "bun:test";
import { remoteControlDiagnostics } from "./remote-control-diagnostics";

test("remote errors and recovery retain only classified state, never enrollment or error bodies", () => {
  const events: unknown[] = [];
  const observer = remoteControlDiagnostics(fields => events.push(fields));
  observer.request({ id: "private-id", method: "remoteControl/enable", params: { private: true } });
  observer.response({ id: "private-id", result: { status: "errored", environmentId: "private-enrollment", serverName: "private-host" } });
  observer.response({ method: "remoteControl/status/changed", params: { status: "connected", installationId: "private-installation" } });
  observer.request({ id: 2, method: "remoteControl/enable" });
  observer.response({ id: 2, error: { code: -32000, message: "private-error", data: { token: "private-token" } } });
  expect(events).toEqual([
    { kind: "enable", status: "errored" },
    { kind: "notification", status: "connected" },
    { kind: "enable", status: "rpc_error", error_code: -32000 },
  ]);
  expect(JSON.stringify(events)).not.toContain("private");
});

test("unrelated/reused RPC ids and future status values cannot inject unclassified diagnostics", () => {
  const events: unknown[] = [];
  const observer = remoteControlDiagnostics(fields => events.push(fields));
  observer.request({ id: 1, method: "remoteControl/status/read" });
  observer.request({ id: 1, method: "thread/read" });
  observer.response({ id: 1, result: { status: "connected" } });
  observer.request({ id: 2, method: "remoteControl/status/read" });
  observer.response({ id: 2, result: { status: "private-future-value" } });
  observer.request({ id: 3, method: "remoteControl/disable" });
  observer.close();
  observer.response({ id: 3, result: { status: "disabled" } });
  expect(events).toEqual([{ kind: "status_read", status: "unknown" }]);
});

test("repeated polls deduplicate, transitions are bounded and a broken sink cannot break traffic", () => {
  const events: unknown[] = [];
  const observer = remoteControlDiagnostics(fields => events.push(fields));
  for (let i = 0; i < 100; i++) {
    observer.request({ id: i, method: "remoteControl/status/read" });
    observer.response({ id: i, result: { status: "connected" } });
  }
  expect(events).toHaveLength(1);
  for (let i = 0; i < 100; i++) observer.response({ method: "remoteControl/status/changed", params: { status: i % 2 ? "connected" : "errored" } });
  expect(events).toHaveLength(32);
  const broken = remoteControlDiagnostics(() => { throw Error("sink failed"); });
  expect(() => broken.response({ method: "remoteControl/status/changed", params: { status: "errored" } })).not.toThrow();
});
