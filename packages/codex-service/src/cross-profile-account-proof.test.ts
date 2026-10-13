import { describe, expect, test } from "bun:test";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import {
  createLocalNativeAccountProof, type TrustedNativeProfileSession,
} from "./cross-profile-account-proof";

const route = (digit: string) => digit.repeat(64);
function fixture() {
  const sessions = new Map<number, TrustedNativeProfileSession>([
    [1, { slot: 1, runtimeProcessId: 101,
      responsesRouteFingerprint: route("a"), terminalEndpoint: "ws://127.0.0.1:19001" }],
    [2, { slot: 2, runtimeProcessId: 202,
      responsesRouteFingerprint: route("b"), terminalEndpoint: "ws://127.0.0.1:19002" }],
  ]);
  // Real owner-bound profile observations showed the same workspace routing
  // ID can coexist with different Native login emails. That shared routing
  // ID is NOT a user identity and must not collapse two signed-in profiles.
  const accounts = new Map<number, string>([[1, "shared-workspace-route"], [2, "shared-workspace-route"]]);
  const emails = new Map<number, string>([[1, "first-user@example.invalid"], [2, "second-user@example.invalid"]]);
  let activeSlot = 0, reads = 0, closes = 0, connects = 0;
  let onRead: ((slot: number) => void) | undefined;
  const profile = createLocalNativeAccountProof({
    fingerprintKey: Buffer.alloc(32, 7),
    async resolveOwnedSession(slot) {
      const s = sessions.get(slot);
      if (!s) throw new Error("No exact runtime owner");
      return s;
    },
    async connect(endpoint) {
      const selected = [...sessions].find(([, s]) => s.terminalEndpoint === endpoint);
      if (!selected) throw new Error("Not an owned exact Native endpoint");
      activeSlot = selected[0]; connects++;
      return {
        async request(method, params) {
          if (method !== "account/read"
            || (params as { refreshToken?: unknown })?.refreshToken !== false) {
            throw new Error("Unsupported account inspection method");
          }
          reads++;
          const accountId = accounts.get(activeSlot);
          const loginEmail = emails.get(activeSlot);
          onRead?.(activeSlot);
          return { account: { type: "chatgpt", email: loginEmail },
            workspaceRouting: accountId === undefined ? null : {
              chatgptAccountId: accountId, accountRoutingOverride: "us",
              backendOrigin: "https://example.invalid",
            } };
        },
        async close() { closes++; },
      } as Pick<CodexAppServerRpc, "request" | "close">;
    },
  });
  return {
    profile, sessions, accounts, emails,
    onRead(fn: (slot: number) => void) { onRead = fn; },
    counts: () => ({ activeSlot, reads, closes, connects }),
  };
}

describe("authenticated selected Native account routing (isolated owner only)", () => {
  test("two separate profiles produce stable private account/owner fingerprints without exposing IDs or email", async () => {
    const f = fixture();
    const a = await f.profile(1), b = await f.profile(2);
    expect(a).toMatchObject({ slot: 1, routeFingerprint: route("a") });
    expect(b).toMatchObject({ slot: 2, routeFingerprint: route("b") });
    expect(a.accountFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(a.accountFingerprint).not.toEqual(b.accountFingerprint);
    expect(a.sessionFingerprint).not.toEqual(b.sessionFingerprint);
    expect((await f.profile(1)).accountFingerprint).toBe(a.accountFingerprint);
    expect(JSON.stringify(a) + JSON.stringify(b)).not.toContain("shared-workspace-route");
    expect(JSON.stringify(a) + JSON.stringify(b)).not.toContain("first-user");
    expect(JSON.stringify(a) + JSON.stringify(b)).not.toContain("second-user");
    expect(f.counts()).toEqual({ activeSlot: 1, reads: 6, closes: 3, connects: 3 });
  });

  test("account switch during two public owner reads refuses a stale identity and closes the socket", async () => {
    const f = fixture();
    let swapped = false;
    f.onRead(() => {
      if (!swapped) { swapped = true; f.emails.set(1, "switched-login@example.invalid"); }
    });
    await expect(f.profile(1)).rejects.toThrow("changed");
    expect(f.counts()).toMatchObject({ reads: 2, closes: 1 });
  });

  test("native owner runtime or exact endpoint replacement revokes the proof", async () => {
    const f = fixture();
    f.onRead(() => {
      f.sessions.set(1, { ...f.sessions.get(1)!, runtimeProcessId: 999 });
    });
    await expect(f.profile(1)).rejects.toThrow("session changed");
    expect(f.counts()).toMatchObject({ closes: 1, connects: 1 });
  });

  test("missing selected ChatGPT account ID cannot be replaced by email or native signed-in status", async () => {
    const f = fixture();
    f.accounts.delete(1);
    await expect(f.profile(1)).rejects.toThrow("login and routing are unavailable");
    expect(f.counts()).toMatchObject({ reads: 1, closes: 1 });
  });

  test("missing selected login email cannot be replaced by shared workspace routing identity", async () => {
    const f = fixture();
    f.emails.delete(1);
    await expect(f.profile(1)).rejects.toThrow("login and routing are unavailable");
    expect(f.counts()).toMatchObject({ reads: 1, closes: 1 });
  });

  test("wrong slots, unverified owners and non-loopback endpoints reject before any RPC", async () => {
    const f = fixture();
    await expect(f.profile(0)).rejects.toThrow("valid exact profile");
    await expect(f.profile(99)).rejects.toThrow("No exact runtime owner");
    f.sessions.set(1, { ...f.sessions.get(1)!, terminalEndpoint: "ws://192.0.2.9:1337" });
    await expect(f.profile(1)).rejects.toThrow("unowned endpoint");
    f.sessions.set(1, { ...f.sessions.get(1)!, terminalEndpoint: "https://127.0.0.1:1337" });
    await expect(f.profile(1)).rejects.toThrow("unowned endpoint");
    expect(f.counts().connects).toBe(0);
  });

  test("rotating an owner session invalidates the destination's old binding even on the same account", async () => {
    const f = fixture();
    const before = await f.profile(1);
    f.sessions.set(1, { ...f.sessions.get(1)!, runtimeProcessId: 333,
      responsesRouteFingerprint: route("c"), terminalEndpoint: "ws://127.0.0.1:19003" });
    const after = await f.profile(1);
    expect(after.accountFingerprint).toBe(before.accountFingerprint);
    expect(after.sessionFingerprint).not.toBe(before.sessionFingerprint);
    expect(after.routeFingerprint).not.toBe(before.routeFingerprint);
  });
});
