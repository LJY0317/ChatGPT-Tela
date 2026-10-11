import { expect, test } from "bun:test";
import { classifyNetworkFailure } from "./network-failure";

test("classifies Node fetch causes without exposing message data", () => {
  for (const [code, kind] of Object.entries({ ENOTFOUND: "dns", EAI_AGAIN: "dns", ETIMEDOUT: "timeout", UND_ERR_CONNECT_TIMEOUT: "timeout", CERT_HAS_EXPIRED: "tls", ERR_TLS_CERT_ALTNAME_INVALID: "tls", ECONNREFUSED: "connection_refused", ENETUNREACH: "unreachable", ECONNRESET: "connection_reset" } as const)) {
    expect(classifyNetworkFailure(new TypeError("fetch failed: private URL/token", { cause: Object.assign(new Error("secret"), { code }) }))).toBe(kind);
  }
  expect(classifyNetworkFailure(new DOMException("private", "AbortError"))).toBe("cancelled");
  expect(classifyNetworkFailure(new Error("ENOTFOUND private.example"))).toBe("unknown");
});

test("bounds aggregate/cyclic error inspection and retains structured causes", () => {
  const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
  expect(classifyNetworkFailure(cyclic)).toBe("unknown");
  expect(classifyNetworkFailure(new AggregateError([{ code: "ENETUNREACH" }, { code: "EAI_AGAIN" }]))).toBe("dns");
  expect(classifyNetworkFailure({ code: "private arbitrary code", cause: { code: "ECONNRESET" } })).toBe("connection_reset");
});

test("Bun structured refusal is distinguished from a request timeout", () => {
  expect(classifyNetworkFailure({code: "ConnectionRefused"})).toBe("connection_refused");
  expect(classifyNetworkFailure({code: "UND_ERR_HEADERS_TIMEOUT"})).toBe("timeout");
});
