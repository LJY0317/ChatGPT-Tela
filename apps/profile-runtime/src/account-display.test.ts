import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountDisplay } from "./account-display";
import { createAccountCheck } from "./account-check";
import { startProfileBridgePreviewServer } from "./bridge-preview-server";

test("email display is authenticated and no-store; coarse checks and diagnostics never carry emails", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-account-display-"));
  const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = join(root, "events.jsonl");
  let calls = 0;
  const native = async () => { calls++; return { account: { type: "chatgpt", email: "native@example.invalid" } }; };
  const display = createAccountDisplay({ native, web: async () => ({ state: "signed-in", email: "web@example.invalid" }),
    signal: new AbortController().signal, revision: () => 0 });
  const token = "a".repeat(48);
  const server = await startProfileBridgePreviewServer({ slot: 1, bearerToken: token, observe: async () => ({ activeSurfaceCount: 0 }),
    accountDisplay: display,
    accountCheck: createAccountCheck({ native, web: async () => ({ accountFingerprint: "b".repeat(64), containerFingerprint: "c".repeat(64), accountStructure: "personal" }), binding: () => "b".repeat(64) }) });
  try {
    const url = new URL("v1/account-display", server.endpoint);
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com" } })).status).toBe(403);
    expect(calls).toBe(0);
    const headers = { authorization: `Bearer ${token}` };
    const response = await fetch(url, { headers });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json() as any;
    expect(value.slot).toBe(1); expect(value.comparison).toBe("different");
    expect(value.native.email).toBe("native@example.invalid"); expect(value.web.email).toBe("web@example.invalid");
    const coarse = await (await fetch(new URL("v1/account-check", server.endpoint), { headers })).text();
    expect(coarse).not.toContain("@example");
    const log = readFileSync(join(root, "events.jsonl"), "utf8");
    expect(log).toContain('"comparison":"different"'); expect(log).not.toContain("@example");
    expect(log).not.toContain(token);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE; else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("account change during a coalesced read discards both emails; next explicit observation is fresh", async () => {
  let revision = 0, calls = 0;
  let release!: (value: unknown) => void;
  const display = createAccountDisplay({ signal: new AbortController().signal, revision: () => revision,
    native: async () => { calls++; return new Promise(resolve => { release = resolve; }); },
    web: async () => ({ state: "signed-in", email: "old@example.invalid" }) });
  const first = display(); expect(display()).toBe(first);
  await Promise.resolve(); revision++;
  release({ account: { type: "chatgpt", email: "old@example.invalid" } });
  expect(await first).toEqual({ native: { state: "unavailable" }, web: { state: "unavailable" }, comparison: "unavailable" });
  const next = display(); await Promise.resolve();
  release({ account: { type: "chatgpt", email: "new@example.invalid" } });
  expect((await next).comparison).toBe("different"); expect(calls).toBe(2);
});

test("shutdown aborts stalled account reads; unavailable is not mismatch", async () => {
  const owner = new AbortController();
  const display = createAccountDisplay({ signal: owner.signal, revision: () => 0,
    native: async () => new Promise(() => {}), web: async () => ({ state: "signed-in", email: "web@example.invalid" }) });
  const pending = display(); await Promise.resolve(); owner.abort();
  const result = await pending;
  expect(result.comparison).toBe("unavailable"); expect(JSON.stringify(result)).not.toContain("@example");
});
