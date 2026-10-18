import { describe, expect, test } from "bun:test";
import { startProfileBridgePreviewServer } from "./bridge-preview-server";

describe("profile bridge preview server", () => {
  test("shutdown requires owned auth, coalesces cleanup and retains a receipt without closing control", async () => {
    const token = "s".repeat(48); let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = await startProfileBridgePreviewServer({ slot: 1, bearerToken: token,
      async observe() { return { activeSurfaceCount: 0 }; },
      async shutdownProfile() { calls++; await gate; return { responsesRouteFingerprint: "a".repeat(64) }; },
    });
    const url = new URL("v1/profile-stop", server.endpoint), headers = { authorization: `Bearer ${token}` };
    try {
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: { ...headers, origin: "https://chatgpt.com" } })).status).toBe(403);
      expect((await fetch(url, { headers })).status).toBe(404);
      const one = fetch(url, { method: "POST", headers }), two = fetch(url, { method: "POST", headers });
      await Bun.sleep(10); expect(calls).toBe(1); release();
      const expected = { contractVersion: 1, slot: 1, phase: "cleanup-complete", responsesRouteFingerprint: "a".repeat(64) };
      expect(await (await one).json()).toEqual(expected); expect(await (await two).json()).toEqual(expected);
      expect(await (await fetch(url, { method: "POST", headers })).json()).toEqual(expected);
      expect(calls).toBe(1);
    } finally { release(); await server.close(); }
  });
  test("refused cleanup preserves control and may be explicitly requested again", async () => {
    let refuse = true, calls = 0; const token = "q".repeat(48);
    const server = await startProfileBridgePreviewServer({ slot: 2, bearerToken: token,
      async observe() { return { activeSurfaceCount: 0 }; },
      async shutdownProfile() { calls++; if (refuse) throw Error("PRIVATE quit dialog detail"); return { responsesRouteFingerprint: "b".repeat(64) }; },
    });
    const url = new URL("v1/profile-stop", server.endpoint), headers = { authorization: `Bearer ${token}` };
    try {
      const rejected = await fetch(url, { method: "POST", headers });
      expect(rejected.status).toBe(409); expect(await rejected.text()).not.toContain("PRIVATE"); expect(calls).toBe(1);
      refuse = false;
      expect((await fetch(url, { method: "POST", headers })).status).toBe(200); expect(calls).toBe(2);
    } finally { await server.close(); }
  });
  test("synthetic saved cleanup is separately authenticated, deletion-only and strips internal errors", async () => {
    let calls = 0;
    const token = "u".repeat(48);
    const server = await startProfileBridgePreviewServer({
      slot: 1, bearerToken: token,
      async observe() { return { activeSurfaceCount: 0 }; },
      async recoverSyntheticSavedChat() {
        calls++;
        if (calls === 2) throw Error("secret synthetic marker must remain private");
        return { contractVersion: 1, syntheticConversationProven: true,
          officialDelete: { contractVersion: 1, menuOpened: true,
            officialDeleteSelected: true, officialConfirmationDispatched: true,
            historyAbsentAfterReload: true } };
      },
    });
    const uri = new URL("v1/account-browser-synthetic-cleanup", server.endpoint);
    const headers = { authorization: `Bearer ${token}` };
    try {
      expect((await fetch(uri, { method: "POST" })).status).toBe(401);
      expect((await fetch(uri, { method: "POST", headers: { ...headers, origin: "https://chatgpt.com" } })).status).toBe(403);
      expect((await fetch(uri, { headers })).status).toBe(404);
      expect(calls).toBe(0);
      const response = await fetch(uri, { method: "POST", headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ contractVersion: 1, slot: 1,
        syntheticConversationProven: true, officialDelete: { contractVersion: 1,
          menuOpened: true, officialDeleteSelected: true,
          officialConfirmationDispatched: true, historyAbsentAfterReload: true } });
      const refused = await fetch(uri, { method: "POST", headers });
      expect(refused.status).toBe(409);
      expect(await refused.text()).not.toContain("secret synthetic marker");
    } finally { await server.close(); }
  });
  test("saved-chat deletion acceptance has exact bearer, one-shot receipt, no cross-origin and no leaked failure details", async () => {
    const token = "s".repeat(48);
    let invokes = 0;
    const server = await startProfileBridgePreviewServer({ slot: 1, bearerToken: token,
      async observe() { return { activeSurfaceCount: 0 }; },
      async runSavedDeleteAcceptance() {
        invokes++;
        if (invokes > 1) throw Error("private user marker 123");
        return { contractVersion: 1, newlyAccepted: true, modelReplyCompleted: true,
          officialDelete: { contractVersion: 1, menuOpened: true, officialDeleteSelected: true,
            officialConfirmationDispatched: true, historyAbsentAfterReload: true } };
      },
    });
    const url = new URL("v1/account-browser-saved-delete-acceptance", server.endpoint);
    const headers = { authorization: `Bearer ${token}` };
    try {
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: { ...headers, origin: "https://chatgpt.com" } })).status).toBe(403);
      expect((await fetch(url, { headers })).status).toBe(404);
      expect(invokes).toBe(0);
      const ok = await fetch(url, { method: "POST", headers });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(await ok.json()).toEqual({ contractVersion: 1, slot: 1, newlyAccepted: true,
        modelReplyCompleted: true, officialDelete: { contractVersion: 1,
          menuOpened: true, officialDeleteSelected: true,
          officialConfirmationDispatched: true, historyAbsentAfterReload: true } });
      const refused = await fetch(url, { method: "POST", headers });
      expect(refused.status).toBe(409);
      expect(await refused.text()).not.toContain("private user marker");
      expect(invokes).toBe(2);
    } finally { await server.close(); }
  });
  test("history inspection is authenticated, content-free and only present for an open owned browser", async () => {
    const token = "h".repeat(48);
    let inspections = 0;
    let open = true;
    const server = await startProfileBridgePreviewServer({
      slot: 2, bearerToken: token, async observe() { return { activeSurfaceCount: 0 }; },
      async inspectHistoryUi() {
        inspections += 1;
        if (!open) throw new Error("private owner state");
        return { contractVersion: 1, route: "home", historyLinkCount: 3,
          visibleHistoryLinkCount: 2, nearbyActionRowCount: 2,
          nearbyMenuRowCount: 1, visibleMenuCount: 0, visibleDialogCount: 0 };
      },
    });
    const url = new URL("v1/account-browser-history-ui", server.endpoint);
    try {
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com" } })).status).toBe(403);
      expect(inspections).toBe(0);
      const ok = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(await ok.json()).toEqual({ contractVersion: 1, slot: 2, route: "home",
        historyLinkCount: 3, visibleHistoryLinkCount: 2, nearbyActionRowCount: 2,
        nearbyMenuRowCount: 1, visibleMenuCount: 0, visibleDialogCount: 0 });
      open = false;
      const refused = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      expect(refused.status).toBe(409);
      expect(await refused.text()).not.toContain("private owner state");
    } finally { await server.close(); }
  });
  test("owner-bound account browser close requires authentication and never hides failed revalidation", async () => {
    const token = "z".repeat(48);
    let calls = 0;
    let blocked = false;
    const server = await startProfileBridgePreviewServer({
      slot: 2, bearerToken: token,
      async observe() { return { activeSurfaceCount: 0 }; },
      async closeAccountBrowser() { calls++; if (blocked) throw Error("private account proof"); },
    });
    const url = new URL("v1/account-browser-close", server.endpoint);
    const authorization = `Bearer ${token}`;
    try {
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: { authorization, origin: "https://chatgpt.com" } })).status).toBe(403);
      expect((await fetch(url, { headers: { authorization } })).status).toBe(404);
      expect(calls).toBe(0);
      const done = await fetch(url, { method: "POST", headers: { authorization } });
      expect(done.status).toBe(204);
      expect(done.headers.get("cache-control")).toBe("no-store");
      blocked = true;
      const refused = await fetch(url, { method: "POST", headers: { authorization } });
      expect(refused.status).toBe(409);
      expect((await refused.text()).toLowerCase()).not.toContain("private");
      expect(calls).toBe(2);
    } finally { await server.close(); }
  });
  test("Web account browser opens only through the owned authenticated POST and rejects unsafe active work", async () => {
    const token = "w".repeat(48);
    let openCalls = 0;
    let blocked = false;
    const server = await startProfileBridgePreviewServer({
      slot: 2, bearerToken: token, async observe() { return { activeSurfaceCount: 0 }; },
      async openAccountBrowser() { openCalls++; if (blocked) throw Error("turn busy"); },
    });
    const url = new URL("v1/account-browser", server.endpoint);
    const authorization = `Bearer ${token}`;
    try {
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: {
        authorization, origin: "https://chatgpt.com",
      } })).status).toBe(403);
      expect((await fetch(url, { headers: { authorization } })).status).toBe(404);
      expect(openCalls).toBe(0);
      const result = await fetch(url, { method: "POST", headers: { authorization } });
      expect(result.status).toBe(204);
      expect(result.headers.get("cache-control")).toBe("no-store");
      blocked = true;
      const refused = await fetch(url, { method: "POST", headers: { authorization } });
      expect(refused.status).toBe(409);
      expect((await refused.text()).toLowerCase()).not.toContain("turn busy");
      expect(openCalls).toBe(2);
    } finally { await server.close(); }
  });
  test("account observation requires authentication, rejects browser origin, and returns only coarse state",async()=>{
    let calls=0; const token="k".repeat(48);
    const server=await startProfileBridgePreviewServer({slot:1,bearerToken:token,async observe(){return {activeSurfaceCount:0};},
      async accountCheck(){calls++;return {nativeSignIn:"signed-in",webBinding:"different",nativeWebContainer:"matching",userIdentity:"unverified",extra:"private"} as any;}});
    try{
      const url=new URL('v1/account-check',server.endpoint);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url,{headers:{authorization:`Bearer ${token}`,origin:'https://chatgpt.com'}})).status).toBe(403);
      expect(calls).toBe(0);
      const response=await fetch(url,{headers:{authorization:`Bearer ${token}`}});
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body=await response.json() as any;expect(body.userIdentity).toBe('unverified');expect(body).not.toHaveProperty('extra');expect(calls).toBe(1);
    }finally{await server.close();}
  });
  test("approval status belongs only to the explicitly selected surface and is observed on demand", async () => {
    const token = "p".repeat(48); const id = "surface_" + "a".repeat(32); let calls = 0;
    const server = await startProfileBridgePreviewServer({ slot: 1, bearerToken: token,
      async observe(selected) {
        calls++;
        return { activeSurfaceCount: 2, ...(selected === id ? { selectedSurfaceId: id, approvalState: "pending" as const } : {}) };
      },
    });
    try {
      expect(calls).toBe(0);
      const headers = { authorization: `Bearer ${token}` };
      const unselected = await (await fetch(new URL("v1/bridge-preview", server.endpoint), { headers })).json() as any;
      expect(unselected).not.toHaveProperty("approvalState");
      const selected = await (await fetch(new URL(`v1/bridge-preview?surfaceId=${id}`, server.endpoint), { headers })).json() as any;
      expect(selected.approvalState).toBe("pending");
      expect(selected.selectedSurfaceId).toBe(id);
      expect(selected.previewAvailable).toBe(false);
      expect(calls).toBe(2);
    } finally { await server.close(); }
  });
  test("selected Web approval wait excludes private card contents", async () => {
    const token = "k".repeat(48), id = "surface_" + "e".repeat(32);
    const server = await startProfileBridgePreviewServer({ slot: 2, bearerToken: token,
      async observe(selected) { return {
        activeSurfaceCount: 2, surfaces: [{ id, label: "Owned" }, { id: "surface_" + "f".repeat(32), label: "Other" }],
        ...(selected ? {
          selectedSurfaceId: id, approvalState: "pending" as const,
          approvalWait: {phase:"dispatch_sent" as const,elapsedMs:120000,unverifiedDispatchCount:1,operationState:"waiting" as const,rawCard:"SECRET INJECTED"},
        } : {}),
      }; },
    });
    try {
      const headers = { authorization: `Bearer ${token}` };
      const unselected = await (await fetch(new URL("v1/bridge-preview", server.endpoint), { headers })).json() as any;
      expect(unselected.approvalWait).toBeUndefined();
      const selected = await (await fetch(new URL(`v1/bridge-preview?surfaceId=${id}`, server.endpoint), {
        headers,
      })).json() as any;
      expect(selected.approvalWait).toEqual({phase:"dispatch_sent",elapsedMs:120000,unverifiedDispatchCount:1,operationState:"waiting"});
      // In-process adapter's projection is a typed allowlist, not the raw page.
      expect(JSON.stringify(selected)).not.toContain("SECRET INJECTED");
    } finally { await server.close(); }
  });
  test("read-only bridge reports fixed observation cause without page text or a guessed clearance", async () => {
    const token = "t".repeat(48); const id = "surface_" + "b".repeat(32);
    const server = await startProfileBridgePreviewServer({ slot: 2, bearerToken: token,
      async observe(selected) { return {
        activeSurfaceCount: 1, surfaces: [{ id, label: "Owned" }], selectedSurfaceId: selected ?? id,
        approvalState: "unavailable", approvalObservationReason: "dom_observation_failed",
        extra: "RAW PRIVATE WEB CARD",
      }; },
    });
    try {
      const result = await (await fetch(new URL("v1/bridge-preview", server.endpoint), {
        headers: { authorization: `Bearer ${token}` },
      })).json() as Record<string, unknown>;
      expect(result).toMatchObject({
        contractVersion: 1, slot: 2, approvalState: "unavailable",
        approvalObservationReason: "dom_observation_failed",
      });
      expect(JSON.stringify(result)).not.toContain("RAW PRIVATE");
    } finally { await server.close(); }
  });
  test("serves only authenticated loopback read-only preview observations", async () => {
    let observations = 0;
    const token = "u".repeat(48);
    const server = await startProfileBridgePreviewServer({
      slot: 2,
      bearerToken: token,
      async observe() {
        observations += 1;
        return { activeSurfaceCount: 1, jpeg: new Uint8Array([1, 2, 3, 4]) };
      },
    });
    try {
      expect((await fetch(new URL("v1/bridge-preview", server.endpoint))).status).toBe(401);
      expect((await fetch(new URL("v1/bridge-preview", server.endpoint), {
        headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com" },
      })).status).toBe(403);
      const response = await fetch(new URL("v1/bridge-preview", server.endpoint), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        contractVersion: 1,
        slot: 2,
        activeSurfaceCount: 1,
        previewAvailable: true,
        imageMimeType: "image/jpeg",
        imageBase64: "AQIDBA==",
      });
      expect(observations).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("runs model-selection canary only as an authenticated explicit POST", async () => {
    const token = "m".repeat(48);
    let calls = 0;
    const server = await startProfileBridgePreviewServer({
      slot: 1,
      bearerToken: token,
      async observe() { return { activeSurfaceCount: 0 }; },
      async probeModelSelection() {
        calls += 1;
        return { familyCount: 3, exercised: true, testedEffort: "medium", restoredEffort: "high" };
      },
    });
    try {
      const url = new URL("v1/model-selection-canary", server.endpoint);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
      expect((await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com" },
      })).status).toBe(403);
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        contractVersion: 1,
        slot: 1,
        familyCount: 3,
        exercised: true,
        testedEffort: "medium",
        restoredEffort: "high",
      });
      expect(calls).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("runs context-attachment canary only as an authenticated explicit POST", async () => {
    const token = "a".repeat(48);
    let calls = 0;
    const server = await startProfileBridgePreviewServer({
      slot: 1,
      bearerToken: token,
      async observe() { return { activeSurfaceCount: 0 }; },
      async probeContextAttachment() {
        calls += 1;
        return { attachmentBytes: 777, receiptVerified: true };
      },
    });
    try {
      const url = new URL("v1/context-attachment-canary", server.endpoint);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
      expect((await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com" },
      })).status).toBe(403);
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        contractVersion: 1,
        slot: 1,
        attachmentBytes: 777,
        receiptVerified: true,
      });
      expect(calls).toBe(1);
    } finally {
      await server.close();
    }
  });
});

test("Native-only preview remains empty; Web wait and reconnect are authenticated, on-demand controls", async () => {
  let resolve!: () => void;
  const gate = new Promise<void>(r => { resolve = r; });
  let state = "preparing"; let waits = 0; let retries = 0;
  const token = "w".repeat(48);
  const server = await startProfileBridgePreviewServer({ slot: 1, bearerToken: token,
    observe: async () => ({ activeSurfaceCount: 0 }),
    webState: () => ({ contractVersion: 1, slot: 1, webState: state, webModelIds: [] }),
    waitForWeb: async () => { waits++; await gate; },
    reconnectWeb: async () => { retries++; throw new Error("private raw detail"); },
  });
  const headers = { authorization: `Bearer ${token}` };
  try {
    expect((await fetch(new URL("v1/web-state", server.endpoint))).status).toBe(401);
    expect((await fetch(new URL("v1/web-reconnect", server.endpoint), { method: "POST", headers: { ...headers, origin: "https://chatgpt.com" } })).status).toBe(403);
    expect(waits).toBe(0); expect(retries).toBe(0);
    expect((await (await fetch(new URL("v1/bridge-preview", server.endpoint), { headers })).json()).previewAvailable).toBe(false);
    const wait = fetch(new URL("v1/web-state?wait=1", server.endpoint), { headers });
    state = "failed"; resolve();
    expect((await (await wait).json()).webState).toBe("failed");
    expect(waits).toBe(1);
    const retry = await fetch(new URL("v1/web-reconnect", server.endpoint), { method: "POST", headers });
    expect(retry.status).toBe(409); expect(retries).toBe(1);
    expect(await retry.text()).not.toContain("private raw detail");
  } finally { resolve(); await server.close(); }
});

test("selected preview and explicit reveal preserve exact ownership and authentication", async () => {
  const id = "surface_" + "a".repeat(32), token = "u".repeat(48);
  let shown = 0; const modes: boolean[] = [];
  const server = await startProfileBridgePreviewServer({ slot: 1, bearerToken: token,
    async observe(selected) { return { activeSurfaceCount: 2, surfaces: [{id, label: "A"}, {id: "surface_" + "b".repeat(32), label: "B"}],
      ...(selected === id ? { selectedSurfaceId: id, jpeg: new Uint8Array([1,2,3]) } : {}) }; },
    async reveal(selected, interactive) { if (selected !== id) throw new Error("stale"); shown++; modes.push(interactive === true); },
  });
  const headers = {authorization: `Bearer ${token}`, "content-type": "application/json"};
  try {
    const preview = await fetch(new URL(`v1/bridge-preview?surfaceId=${id}`, server.endpoint), {headers});
    expect((await preview.json()).previewAvailable).toBe(true);
    const url = new URL("v1/bridge-reveal", server.endpoint), body = JSON.stringify({surfaceId: id});
    expect((await fetch(url, {method: "POST", body})).status).toBe(401);
    expect((await fetch(url, {method: "POST", headers: {...headers, origin: "https://example.test"}, body})).status).toBe(403);
    expect((await fetch(url, {headers})).status).toBe(404);
    expect((await fetch(url, {method: "POST", headers, body})).status).toBe(204);
    expect(shown).toBe(1);
    expect((await fetch(url, {method: "POST", headers, body: JSON.stringify({surfaceId: "surface_" + "c".repeat(32)})})).status).toBe(409);
    expect(shown).toBe(1);
    expect(modes).toEqual([false]);
    expect((await fetch(url, {method: "POST", headers, body: JSON.stringify({surfaceId:id, interactive:"true"})})).status).toBe(400);
    expect(shown).toBe(1);
    expect((await fetch(url, {method: "POST", headers, body: JSON.stringify({surfaceId:id, interactive:true})})).status).toBe(204);
    expect(modes).toEqual([false,true]);
  } finally { await server.close(); }
});
