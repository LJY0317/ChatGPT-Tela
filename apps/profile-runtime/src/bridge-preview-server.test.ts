import { describe, expect, test } from "bun:test";
import { startProfileBridgePreviewServer } from "./bridge-preview-server";

describe("profile bridge preview server", () => {
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
