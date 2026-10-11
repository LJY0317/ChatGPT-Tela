import { EventEmitter } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { describe, expect, test } from "bun:test";
import { createProfileSupervisorLifecycle } from "./supervision";

async function connectedPair(): Promise<{ client: Socket; server: Socket; close(): Promise<void> }> {
  let accepted!: Socket;
  const listener = createServer(socket => { accepted = socket; });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("fixture listener address missing");
  const client = await new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: address.port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
  while (!accepted) await Bun.sleep(1);
  return {
    client,
    server: accepted,
    async close() {
      client.destroy(); accepted.destroy();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    },
  };
}

describe("profile supervisor lifecycle", () => {
  test("aborts when the parent supervision socket closes", async () => {
    const pair = await connectedPair();
    const signals = new EventEmitter();
    const lifecycle = await createProfileSupervisorLifecycle({ signalSource: signals, socket: pair.client });
    expect(lifecycle.signal.aborted).toBe(false);
    pair.server.destroy();
    await lifecycle.shutdownRequested;
    expect(lifecycle.signal.aborted).toBe(true);
    lifecycle.dispose();
    await pair.close();
  });

  test("normal termination signals share the same one-shot shutdown", async () => {
    const pair = await connectedPair();
    const signals = new EventEmitter();
    const lifecycle = await createProfileSupervisorLifecycle({ signalSource: signals, socket: pair.client });
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await lifecycle.shutdownRequested;
    expect(lifecycle.signal.aborted).toBe(true);
    lifecycle.dispose();
    await pair.close();
  });
});

test("readiness uses the existing socket once and fails when supervision has closed",async()=>{
 const pair=await connectedPair();const lifecycle=await createProfileSupervisorLifecycle({signalSource:new EventEmitter(),socket:pair.client});
 try{
  const received=new Promise<string>(resolve=>pair.server.once("data",b=>resolve(b.toString())));
  await lifecycle.publishReady({stage:"product-profile-ready",slot:1});
  expect(JSON.parse(await received)).toEqual({stage:"product-profile-ready",slot:1});
  await expect(lifecycle.publishReady({stage:"product-profile-ready"})).rejects.toThrow("already");
 }finally{lifecycle.dispose();await pair.close();}
});
test("publisher rejects invalid or oversized readiness before writing",async()=>{
 const pair=await connectedPair();const lifecycle=await createProfileSupervisorLifecycle({signalSource:new EventEmitter(),socket:pair.client});
 try{
  await expect(lifecycle.publishReady({stage:"unknown"})).rejects.toThrow("invalid");
  await expect(lifecycle.publishReady({stage:"product-profile-ready",large:"x".repeat(65536)})).rejects.toThrow("bounded");
  pair.server.destroy();await lifecycle.shutdownRequested;
  await expect(lifecycle.publishReady({stage:"product-profile-ready"})).rejects.toThrow("closed");
 }finally{lifecycle.dispose();await pair.close();}
});
