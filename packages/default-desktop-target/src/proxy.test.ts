import { describe, expect, test } from "bun:test";
import { createDefaultDesktopResponsesRoute, TELA_DEFAULT_DESKTOP_PROVIDER_ID } from "./route";
import { startDefaultDesktopAppServerProxy } from "./proxy";

function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("fixture WebSocket failed")), { once: true });
  });
}

test("official Remote replies pass unchanged and failures remain visible after history diagnostic saturation", async () => {
  const events: { stage: string; fields: any }[] = [];
  const reply = '{"id":"remote-private-id","result":{"status":"errored","installationId":"private-enrollment"}}';
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(r, s) { return s.upgrade(r) ? undefined : new Response(null, { status: 400 }); },
    websocket: { message(socket, raw) {
      const request = JSON.parse(String(raw));
      socket.send(request.method === "remoteControl/enable" ? reply : JSON.stringify({ id: request.id, result: { thread: { turns: [] } } }));
    } },
  });
  const proxy = await startDefaultDesktopAppServerProxy({ upstreamEndpoint: `ws://127.0.0.1:${upstream.port}/`,
    route: createDefaultDesktopResponsesRoute({ baseUrl: "http://127.0.0.1:18741/v1", envKey: "TEST_KEY", credential: "s".repeat(48) }),
    onDiagnostic: (stage, fields) => events.push({ stage, fields }),
  });
  const client = await openSocket(proxy.endpoint);
  const exchange = (request: unknown) => { const response = new Promise<string>(resolve => client.addEventListener("message", e => resolve(String(e.data)), { once: true })); client.send(JSON.stringify(request)); return response; };
  try {
    for (let i = 0; i < 70; i++) await exchange({ id: i, method: "thread/read", params: { threadId: "private-history", includeTurns: false } });
    expect(await exchange({ id: "remote-private-id", method: "remoteControl/enable", params: {} })).toBe(reply);
    expect(events.filter(e => e.stage === "desktop_remote_control_failed")).toEqual([
      { stage: "desktop_remote_control_failed", fields: expect.objectContaining({ kind: "enable", status: "errored" }) },
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
  } finally { client.close(); await proxy.close(); upstream.stop(true); }
});

describe("default Desktop route-preserving app-server proxy", () => {
  test("a reused JSON-RPC turn/start id cannot bind a delayed old engine ACK to a new Legacy thread", async () => {
    const diagnostics: Array<{ stage: string; reason: unknown }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
      websocket: {
        message(socket, raw) {
          const request = JSON.parse(String(raw));
          if (request.method !== "turn/start") return;
          // A request id is only a transport correlation key. Reusing one
          // after a completed request can make a delayed earlier reply look
          // like the ACK for a different thread.
          const turnId = request.id === 7 ? "turn-a" : "turn-c";
          socket.send(JSON.stringify({ id: request.id, result: {
            turn: { id: turnId, status: "inProgress" },
          } }));
        },
      },
    });
    const proxy = await startDefaultDesktopAppServerProxy({
      upstreamEndpoint: `ws://127.0.0.1:${upstream.port}/`,
      route: createDefaultDesktopResponsesRoute({
        baseUrl: "http://127.0.0.1:18741/v1", envKey: "TEST_KEY",
        credential: "x".repeat(48),
      }),
      onDiagnostic(stage, fields) {
        diagnostics.push({ stage, reason: fields.reason_class });
      },
    });
    const client = await openSocket(proxy.endpoint);
    const send = async (id: number, threadId: string) => {
      const response = new Promise<void>(resolve => {
        const listener = (event: MessageEvent) => {
          const incoming = JSON.parse(String(event.data));
          if (incoming.id !== id) return;
          client.removeEventListener("message", listener);
          resolve();
        };
        client.addEventListener("message", listener);
      });
      client.send(JSON.stringify({ id, method: "turn/start", params: {
        threadId, input: [{ type: "text", text: "fixture only" }],
      } }));
      await response;
    };
    try {
      await send(7, "thread-a");
      expect(proxy.liveTurnProof.current("thread-a")?.turnId).toBe("turn-a");
      // A stale duplicate ACK for thread-a arrives as the reply for a
      // new thread-b request that recycled the same id=7.
      await send(7, "thread-b");
      expect(proxy.liveTurnProof.current("thread-b")).toBeUndefined();
      expect(diagnostics).toContainEqual({
        stage: "desktop_native_live_turn_rejected", reason: "reused_request_id",
      });
      expect(JSON.stringify(diagnostics)).not.toContain("thread-b");
      await send(8, "thread-c");
      expect(proxy.liveTurnProof.current("thread-c")?.turnId).toBe("turn-c");
    } finally {
      client.close();
      await proxy.close();
      upstream.stop(true);
    }
  });
  test("exact original turn/start ACK yields revocable live Legacy owner without reading any history", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
      websocket: {
        message(socket, raw) {
          const incoming = JSON.parse(String(raw));
          if (incoming.method === "turn/start") {
            // Published TurnStartResponse contains turn.id/status, not an
            // independently supplied thread ID. A wrong RPC id isn't a proof.
            socket.send(JSON.stringify({ id: incoming.id + 100, result: {
              turn: { id: "foreign-ack", status: "inProgress" },
            } }));
            socket.send(JSON.stringify({ id: incoming.id, result: {
              turn: { id: incoming.id === 9 ? "new-legacy-turn" : "live-legacy-turn", status: "inProgress" },
            } }));
          }
          if (incoming.method === "fixture/finish") {
            socket.send(JSON.stringify({ method: "turn/completed", params: {
              threadId: "legacy-thread", turn: { id: "live-legacy-turn", status: "completed" },
            } }));
            socket.send(JSON.stringify({ id: incoming.id, result: {} }));
          }
        },
      },
    });
    const proxy = await startDefaultDesktopAppServerProxy({
      upstreamEndpoint: `ws://127.0.0.1:${upstream.port}/`,
      route: createDefaultDesktopResponsesRoute({
        baseUrl: "http://127.0.0.1:18741/v1", envKey: "TEST_KEY", credential: "x".repeat(48),
      }),
    });
    const client = await openSocket(proxy.endpoint);
    const exchange = async (id: number, method: string, params: unknown) => {
      const reply = new Promise<void>(resolve => {
        const listener = (event: MessageEvent) => {
          const result = JSON.parse(String(event.data));
          if (result.id !== id) return;
          client.removeEventListener("message", listener);
          resolve();
        };
        client.addEventListener("message", listener);
      });
      client.send(JSON.stringify({ id, method, params }));
      await reply;
    };
    try {
      expect(proxy.liveTurnProof.current("legacy-thread")).toBeUndefined();
      await exchange(7, "turn/start", { threadId: "legacy-thread", input: [{ type: "text", text: "synthetic" }] });
      expect(proxy.liveTurnProof.current("legacy-thread")).toMatchObject({
        threadId: "legacy-thread", turnId: "live-legacy-turn",
      });
      expect(proxy.liveTurnProof.current("unrelated-thread")).toBeUndefined();
      await exchange(8, "fixture/finish", {});
      expect(proxy.liveTurnProof.current("legacy-thread")).toBeUndefined();
      await exchange(9, "turn/start", { threadId: "legacy-thread" });
      const exact = proxy.liveTurnProof.current("legacy-thread")!;
      expect(exact.turnId).toBe("new-legacy-turn");
      client.close();
      for (let i = 0; i < 80 && proxy.liveTurnProof.isCurrent(exact); i++) {
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      expect(proxy.liveTurnProof.isCurrent(exact)).toBe(false);
    } finally {
      client.close(); await proxy.close(); upstream.stop(true);
    }
  });
  test("exact public Native turn/start image is bound only after same RPC ack and revoked on completion", async () => {
    const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
    const upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
      },
      websocket: {
        message(socket, raw) {
          const incoming = JSON.parse(String(raw));
          if (incoming.method !== "turn/start") return;
          socket.send(JSON.stringify({ id: incoming.id, result: {
            turn: { id: "confirmed-turn", threadId: incoming.params.threadId },
          } }));
        },
      },
    });
    const proxy = await startDefaultDesktopAppServerProxy({
      upstreamEndpoint: `ws://127.0.0.1:${upstream.port}/`,
      route: createDefaultDesktopResponsesRoute({
        baseUrl: "http://127.0.0.1:18741/v1", envKey: "TEST_TOKEN",
        credential: "x".repeat(48),
      }),
    });
    const socket = await openSocket(proxy.endpoint);
    try {
      expect(proxy.ingressMedia.current("thread", "confirmed-turn")).toBeUndefined();
      const reply = new Promise<string>(resolve =>
        socket.addEventListener("message", event => resolve(String(event.data)), { once: true }));
      socket.send(JSON.stringify({ id: 28, method: "turn/start", params: {
        threadId: "thread", input: [{ type: "text", text: "Photo" },
          { type: "image", url: "data:image/png;base64," + png.toString("base64") }],
      } }));
      await reply;
      const media = proxy.ingressMedia.current("thread", "confirmed-turn");
      expect(media?.assets).toHaveLength(1);
      expect(media?.assets[0]?.bytes).toEqual(png);
      expect(proxy.ingressMedia.current("thread", "different-turn")).toBeUndefined();
      proxy.ingressMedia.retire("thread", "confirmed-turn");
      expect(proxy.ingressMedia.current("thread", "confirmed-turn")).toBeUndefined();
    } finally {
      socket.close();
      await proxy.close();
      upstream.stop(true);
    }
  });
  test("rewrites only routed thread requests and forwards upstream replies", async () => {
    const observed: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
      },
      websocket: {
        message(socket, message) {
          if (typeof message !== "string") return socket.close(1003, "text only");
          observed.push(message);
          socket.send(JSON.stringify({ ok: true, received: observed.length }));
        },
      },
    });
    const proxy = await startDefaultDesktopAppServerProxy({
      upstreamEndpoint: `ws://127.0.0.1:${upstream.port}/`,
      route: createDefaultDesktopResponsesRoute({
        baseUrl: "http://127.0.0.1:18741/v1",
        envKey: "CHATGPT_TELA_RUNTIME_TOKEN",
        credential: "x".repeat(48),
      }),
    });
    const client = await openSocket(proxy.endpoint);
    try {
      const reply = new Promise<string>((resolve, reject) => {
        client.addEventListener("message", event => resolve(String(event.data)), { once: true });
        client.addEventListener("error", () => reject(new Error("proxy client error")), { once: true });
      });
      client.send(JSON.stringify({ id: 1, method: "thread/start", params: { config: {} } }));
      expect(JSON.parse(await reply)).toEqual({ ok: true, received: 1 });
      const routed = JSON.parse(observed[0]!) as any;
      expect(routed.params.modelProvider).toBe(TELA_DEFAULT_DESKTOP_PROVIDER_ID);
      expect(routed.params.config.model_provider).toBe(TELA_DEFAULT_DESKTOP_PROVIDER_ID);

      const unrelated = '{"id":2,"method":"thread/read","params":{"threadId":"abc"}}';
      const secondReply = new Promise<string>(resolve => {
        client.addEventListener("message", event => resolve(String(event.data)), { once: true });
      });
      client.send(unrelated);
      await secondReply;
      expect(observed[1]).toBe(unrelated);
    } finally {
      client.close();
      await proxy.close();
      upstream.stop(true);
    }
  });

  test("permission-profile routing requires this client's explicit experimental API opt-in", async () => {
    const upstream = Bun.serve({ hostname:"127.0.0.1", port:0,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null,{status:400}); },
      websocket:{message(socket,message) { socket.send(String(message)); }},
    });
    const proxy = await startDefaultDesktopAppServerProxy({ upstreamEndpoint:`ws://127.0.0.1:${upstream.port}/`,
      route:createDefaultDesktopResponsesRoute({baseUrl:"http://127.0.0.1:18741/v1",envKey:"TEST_KEY",credential:"s".repeat(48)}),
    });
    try {
      for (const optIn of [false,true]) {
        const client = await openSocket(proxy.endpoint);
        const exchange = async (value:unknown) => {
          const reply = new Promise<string>(resolve => client.addEventListener("message",event=>resolve(String(event.data)),{once:true}));
          client.send(JSON.stringify(value)); return JSON.parse(await reply);
        };
        try {
          await exchange({id:1,method:"initialize",params:{capabilities:{experimentalApi:optIn}}});
          const result = await exchange({id:2,method:"thread/start",params:{sandbox:"read-only"}});
          expect(result.params.permissions).toBe(optIn ? ":read-only" : undefined);
          expect(result.params.sandbox).toBe(optIn ? undefined : "read-only");
        } finally { client.close(); }
      }
    } finally { await proxy.close(); upstream.stop(true); }
  });

  test("augments only the exact model/list response id and preserves unrelated app-server traffic", async () => {
    const observed: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
      },
      websocket: {
        message(socket, message) {
          if (typeof message !== "string") return socket.close(1003, "text only");
          observed.push(message);
          const request = JSON.parse(message) as any;
          socket.send(JSON.stringify({ method: "thread/status/changed", params: { untouched: true } }));
          socket.send(JSON.stringify({
            id: request.id,
            result: request.method === "model/list"
              ? { data: [{ id: "native", model: "native", displayName: "Native" }], nextCursor: null }
              : { untouched: true },
          }));
        },
      },
    });
    const proxy = await startDefaultDesktopAppServerProxy({
      upstreamEndpoint: `ws://127.0.0.1:${upstream.port}/`,
      route: createDefaultDesktopResponsesRoute({
        baseUrl: "http://127.0.0.1:18741/v1",
        envKey: "CHATGPT_TELA_RUNTIME_TOKEN",
        credential: "x".repeat(48),
      }),
      augmentModelList(result) {
        const value = result as any;
        return { ...value, data: [...value.data, { id: "web", model: "web", displayName: "Web" }] };
      },
    });
    const client = await openSocket(proxy.endpoint);
    const messages: any[] = [];
    client.addEventListener("message", event => { messages.push(JSON.parse(String(event.data))); });
    try {
      client.send(JSON.stringify({ id: 41, method: "model/list", params: {} }));
      const deadline = Date.now() + 2_000;
      while (messages.length < 2 && Date.now() < deadline) await Bun.sleep(10);
      expect(messages[0]).toEqual({ method: "thread/status/changed", params: { untouched: true } });
      expect(messages[1]).toEqual({
        id: 41,
        result: {
          data: [
            { id: "native", model: "native", displayName: "Native" },
            { id: "web", model: "web", displayName: "Web" },
          ],
          nextCursor: null,
        },
      });

      client.send(JSON.stringify({ id: 42, method: "thread/read", params: { threadId: "abc" } }));
      while (messages.length < 4 && Date.now() < deadline) await Bun.sleep(10);
      expect(messages[3]).toEqual({ id: 42, result: { untouched: true } });
      expect(observed).toHaveLength(2);
    } finally {
      client.close();
      await proxy.close();
      upstream.stop(true);
    }
  });

  test("model/list augmentation failure preserves the Native result rather than breaking Desktop", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
      },
      websocket: {
        message(socket, message) {
          if (typeof message !== "string") return;
          const request = JSON.parse(message) as any;
          socket.send(JSON.stringify({ id: request.id, result: { data: [{ model: "native" }], nextCursor: null } }));
        },
      },
    });
    const proxy = await startDefaultDesktopAppServerProxy({
      upstreamEndpoint: `ws://127.0.0.1:${upstream.port}/`,
      route: createDefaultDesktopResponsesRoute({
        baseUrl: "http://127.0.0.1:18741/v1",
        envKey: "CHATGPT_TELA_RUNTIME_TOKEN",
        credential: "x".repeat(48),
      }),
      augmentModelList() { throw new Error("simulated catalog mismatch"); },
    });
    const client = await openSocket(proxy.endpoint);
    try {
      const reply = new Promise<any>((resolve, reject) => {
        client.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true });
        client.addEventListener("error", () => reject(new Error("proxy client error")), { once: true });
      });
      client.send(JSON.stringify({ id: "models-1", method: "model/list", params: {} }));
      expect(await reply).toEqual({
        id: "models-1",
        result: { data: [{ model: "native" }], nextCursor: null },
      });
    } finally {
      client.close();
      await proxy.close();
      upstream.stop(true);
    }
  });

  test("rejects non-loopback upstream endpoints before listening", async () => {
    const route = createDefaultDesktopResponsesRoute({
      baseUrl: "http://127.0.0.1:18741/v1",
      envKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      credential: "x".repeat(48),
    });
    await expect(startDefaultDesktopAppServerProxy({ upstreamEndpoint: "ws://example.com:9999/", route }))
      .rejects.toThrow("loopback");
  });

  test("close is bounded even when the connected client does not initiate its own close", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
      },
      websocket: { message() {} },
    });
    const proxy = await startDefaultDesktopAppServerProxy({
      upstreamEndpoint: `ws://127.0.0.1:${upstream.port}/`,
      route: createDefaultDesktopResponsesRoute({
        baseUrl: "http://127.0.0.1:18741/v1",
        envKey: "CHATGPT_TELA_RUNTIME_TOKEN",
        credential: "x".repeat(48),
      }),
    });
    const client = await openSocket(proxy.endpoint);
    client.addEventListener("error", () => { /* expected when bounded shutdown terminates the socket */ });
    const startedAt = Date.now();
    try {
      await proxy.close();
      expect(Date.now() - startedAt).toBeLessThan(2_500);
      expect(proxy.activeConnectionCount).toBe(0);
    } finally {
      try { client.close(); } catch { /* already terminated by the proxy */ }
      upstream.stop(true);
    }
  });
});

test("catalog diagnostics distinguish external and Tela clients, final rows and socket delivery without payloads", async () => {
  const events: {stage:string; fields:any}[]=[];
  const upstream=Bun.serve({hostname:"127.0.0.1",port:0,
    fetch(request,server){return server.upgrade(request)?undefined:new Response(null,{status:400});},
    websocket:{message(socket,message){const request=JSON.parse(String(message));socket.send(JSON.stringify({id:request.id,result:request.method==="model/list"?{data:[
      {model:"native-fixture",hidden:false}, {model:"chatgpt-tela-web/fixture",hidden:false},
      {model:"chatgpt-tela-web/hidden",hidden:true},
    ]}:{}}));}},
  });
  const proxy=await startDefaultDesktopAppServerProxy({upstreamEndpoint:`ws://127.0.0.1:${upstream.port}/`,
    route:createDefaultDesktopResponsesRoute({baseUrl:"http://127.0.0.1:18741/v1",envKey:"TEST_KEY",credential:"s".repeat(48)}),
    onDiagnostic:(stage,fields)=>events.push({stage,fields}),
  });
  try{
    for(const name of ["private-external-client","chatgpt-tela"]){
      const client=await openSocket(proxy.endpoint);
      const exchange=(value:any)=>{const reply=new Promise<any>(r=>client.addEventListener("message",e=>r(JSON.parse(String(e.data))),{once:true}));client.send(JSON.stringify(value));return reply;};
      await exchange({id:"private-initialize-id",method:"initialize",params:{clientInfo:{name}}});
      const result=await exchange({id:"private-request-id",method:"model/list",params:{includeHidden:true}});
      expect(result.result.data).toHaveLength(3);
      client.close();
    }
    const deadline=Date.now()+1000;while(events.filter(e=>e.stage==="desktop_catalog_delivery_complete").length<2&&Date.now()<deadline)await Bun.sleep(5);
    const delivered=events.filter(e=>e.stage==="desktop_catalog_delivery_complete");
    expect(delivered).toHaveLength(2);
    expect(delivered.map(e=>e.fields.kind)).toEqual(["external_client","tela_client"]);
    expect(delivered[0]!.fields).toMatchObject({count:3,native_model_count:1,web_model_count:2,hidden_web_model_count:1,status:"valid"});
    expect(delivered[0]!.fields.connection_fingerprint).not.toBe(delivered[1]!.fields.connection_fingerprint);
    const text=JSON.stringify(events);expect(text).not.toContain("private");expect(text).not.toContain("native-fixture");expect(text).not.toContain("chatgpt-tela-web/");expect(text).not.toContain("127.0.0.1");
  }finally{await proxy.close();upstream.stop(true);}
});

test("a broken diagnostic sink cannot change catalog responses",async()=>{
  const upstream=Bun.serve({hostname:"127.0.0.1",port:0,fetch(r,s){return s.upgrade(r)?undefined:new Response(null,{status:400});},websocket:{message(s,m){const r=JSON.parse(String(m));s.send(JSON.stringify({id:r.id,result:{data:[]}}));}}});
  const proxy=await startDefaultDesktopAppServerProxy({upstreamEndpoint:`ws://127.0.0.1:${upstream.port}/`,route:createDefaultDesktopResponsesRoute({baseUrl:"http://127.0.0.1:18741/v1",envKey:"TEST_KEY",credential:"s".repeat(48)}),onDiagnostic(){throw Error("fixture sink unavailable");}});
  const client=await openSocket(proxy.endpoint);
  try{const reply=new Promise<any>(r=>client.addEventListener("message",e=>r(JSON.parse(String(e.data))),{once:true}));client.send(JSON.stringify({id:1,method:"model/list"}));expect((await reply).result.data).toEqual([]);}finally{client.close();await proxy.close();upstream.stop(true);}
});

test("diagnostic budgets bound pending requests and events without dropping upstream traffic",async()=>{
 let requests=0;const events:{stage:string;fields:any}[]=[];
 const upstream=Bun.serve({hostname:"127.0.0.1",port:0,fetch(r,s){return s.upgrade(r)?undefined:new Response(null,{status:400});},websocket:{message(){requests++;}}});
 const proxy=await startDefaultDesktopAppServerProxy({upstreamEndpoint:`ws://127.0.0.1:${upstream.port}/`,route:createDefaultDesktopResponsesRoute({baseUrl:"http://127.0.0.1:18741/v1",envKey:"TEST_KEY",credential:"s".repeat(48)}),onDiagnostic:(stage,fields)=>events.push({stage,fields})});
 const client=await openSocket(proxy.endpoint);
 try{for(let id=0;id<140;id++)client.send(JSON.stringify({id,method:"model/list"}));
  const deadline=Date.now()+1000;while(requests<140&&Date.now()<deadline)await Bun.sleep(5);
  expect(requests).toBe(140);expect(events.length).toBeLessThanOrEqual(64);
  await proxy.close();const closed=events.find(e=>e.stage==="desktop_catalog_connection_closed");expect(closed?.fields.pending_count).toBe(128);expect(events.length).toBeLessThanOrEqual(65);
 }finally{client.close();await proxy.close();upstream.stop(true);}
});


test("Native history larger than the former 16 MiB cap is delivered exactly and the connection stays usable", async () => {
  const events: {stage:string;fields:any}[] = [];
  const large = JSON.stringify({id:1,result:{thread:{turns:[{text:"x".repeat(17*1024*1024)}]}}});
  const upstream = Bun.serve({hostname:"127.0.0.1",port:0,
    fetch(request,server){return server.upgrade(request)?undefined:new Response(null,{status:400});},
    websocket:{message(socket,message){const value=JSON.parse(String(message));socket.send(value.id===1?large:JSON.stringify({id:value.id,result:{ok:true}}));}},
  });
  const proxy=await startDefaultDesktopAppServerProxy({upstreamEndpoint:`ws://127.0.0.1:${upstream.port}/`,
    route:createDefaultDesktopResponsesRoute({baseUrl:"http://127.0.0.1:18741/v1",envKey:"TEST_KEY",credential:"s".repeat(48)}),
    onDiagnostic:(stage,fields)=>events.push({stage,fields})});
  const client=await openSocket(proxy.endpoint);
  const exchange=(request:object)=>new Promise<string>((resolve,reject)=>{
    client.addEventListener("message",event=>resolve(String(event.data)),{once:true});
    client.addEventListener("close",()=>reject(Error("history socket closed")),{once:true});
    client.send(JSON.stringify(request));
  });
  try {
    expect(await exchange({id:1,method:"thread/read",params:{threadId:"private-fixture",includeTurns:true}})).toBe(large);
    expect(JSON.parse(await exchange({id:2,method:"model/list"}))).toEqual({id:2,result:{ok:true}});
    expect(events.some(row=>row.stage==="desktop_transport_failed")).toBe(false);
    expect(events.find(row=>row.stage==="desktop_history_response")?.fields.received_bytes).toBe(Buffer.byteLength(large));
    expect(JSON.stringify(events)).not.toContain("private-fixture");
  } finally {client.close();await proxy.close();upstream.stop(true);}
});

test("transport failure records the receiving direction and limit without payload or peer reason", async () => {
  const events: {stage:string; fields:any}[]=[];
  const upstream=Bun.serve({hostname:"127.0.0.1",port:0,
    fetch(request,server){return server.upgrade(request)?undefined:new Response(null,{status:400});},
    websocket:{message(socket){socket.send("x".repeat(100*1024*1024+1));}},
  });
  const proxy=await startDefaultDesktopAppServerProxy({upstreamEndpoint:`ws://127.0.0.1:${upstream.port}/`,
    route:createDefaultDesktopResponsesRoute({baseUrl:"http://127.0.0.1:18741/v1",envKey:"TEST_KEY",credential:"s".repeat(48)}),
    onDiagnostic:(stage,fields)=>events.push({stage,fields}),
  });
  const client=await openSocket(proxy.endpoint);
  try {
    const closed=new Promise<void>(resolve=>client.addEventListener("close",()=>resolve(),{once:true}));
    client.send('{"id":1,"method":"thread/read","params":{"threadId":"private-thread"}}');
    await Promise.race([closed, Bun.sleep(3000).then(()=>{throw Error("close timeout")})]);
    const failures=events.filter(e=>e.stage==="desktop_transport_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.fields).toMatchObject({kind:"server_to_client",reason_class:"message_limit",limit_bytes:104857600,client_received_count:1});
    expect(JSON.stringify(events)).not.toContain("private-thread");
    expect(JSON.stringify(events).length).toBeLessThan(4096);
  } finally { client.close();await proxy.close();upstream.stop(true); }
});

test("history reads correlate out-of-order replies and socket writes without recording history", async () => {
  const events: { stage: string; fields: any }[] = [], requests: any[] = [], replies: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
    websocket: { message(socket, message) {
      requests.push(JSON.parse(String(message)));
      if (requests.length === 2) for (const request of [...requests].reverse()) {
        const reply = JSON.stringify({ id: request.id, result: { thread: { id: "private-thread",
          turns: [{ text: "private-history-and-file-body" }] } } });
        replies.push(reply); socket.send(reply);
      }
    } },
  });
  const proxy = await startDefaultDesktopAppServerProxy({ upstreamEndpoint: `ws://127.0.0.1:${upstream.port}/`,
    route: createDefaultDesktopResponsesRoute({ baseUrl: "http://127.0.0.1:18741/v1", envKey: "TEST_KEY", credential: "s".repeat(48) }),
    onDiagnostic: (stage, fields) => events.push({ stage, fields }),
  });
  const client = await openSocket(proxy.endpoint);
  try {
    const received: string[] = [];
    const done = new Promise<void>(resolve => client.addEventListener("message", e => {
      received.push(String(e.data)); if (received.length === 2) resolve();
    }));
    for (const id of ["private-rpc-one", "private-rpc-two"]) client.send(JSON.stringify({ id, method: "thread/read",
      params: { threadId: "private-thread", includeTurns: true } }));
    await Promise.race([done, Bun.sleep(3000).then(() => { throw Error("history read timeout"); })]);
    const deadline = Date.now() + 1000;
    while (events.filter(e => e.stage === "desktop_history_delivery_complete").length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(received).toEqual(replies);
    const reads = events.filter(e => e.stage === "desktop_history_request");
    const delivered = events.filter(e => e.stage === "desktop_history_delivery_complete");
    expect(reads).toHaveLength(2); expect(delivered).toHaveLength(2);
    expect(delivered.map(e => e.fields.operation_fingerprint)).toEqual(reads.map(e => e.fields.operation_fingerprint).reverse());
    expect(delivered[0]!.fields).toMatchObject({ method_class: "history_read", count: 1, parsed: true, status: "valid", delivery: "socket_write_only" });
    const recorded = JSON.stringify(events);
    expect(recorded).not.toContain("private-"); expect(recorded).not.toContain("threadId");
    await proxy.close();
    const closed = events.find(e => e.stage === "desktop_catalog_connection_closed");
    expect(closed?.fields).toMatchObject({ pending_history_count: 0, client_received_count: 2,
      upstream_received_count: 2, client_written_count: 2, delivery: "socket_write_only" });
  } finally { client.close(); await proxy.close(); upstream.stop(true); }
});

test("history diagnostic tracking is bounded without dropping unanswered reads", async () => {
  let count = 0; const events: { stage: string; fields: any }[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
    websocket: { message() { count++; } },
  });
  const proxy = await startDefaultDesktopAppServerProxy({ upstreamEndpoint: `ws://127.0.0.1:${upstream.port}/`,
    route: createDefaultDesktopResponsesRoute({ baseUrl: "http://127.0.0.1:18741/v1", envKey: "TEST_KEY", credential: "s".repeat(48) }),
    onDiagnostic: (stage, fields) => events.push({ stage, fields }),
  });
  const client = await openSocket(proxy.endpoint);
  try {
    for (let id = 0; id < 300; id++) client.send(JSON.stringify({ id, method: "thread/read", params: { threadId: "private-thread" } }));
    const deadline = Date.now() + 2000;
    while (count < 300 && Date.now() < deadline) await Bun.sleep(5);
    expect(count).toBe(300); expect(events.length).toBeLessThanOrEqual(64);
    await proxy.close();
    expect(events.find(e => e.stage === "desktop_catalog_connection_closed")?.fields.pending_history_count).toBe(128);
    expect(events.length).toBeLessThanOrEqual(65);
    expect(JSON.stringify(events)).not.toContain("private-thread");
  } finally { client.close(); await proxy.close(); upstream.stop(true); }
});
