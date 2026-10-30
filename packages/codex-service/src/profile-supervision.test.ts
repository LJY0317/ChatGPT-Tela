import { observeDiagnosticEvents, structuralDiagnosticEvent } from "@chatgpt-tela/core";
import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { createProfileSupervisorLease, type ProfileSupervisorLease } from "./profile-supervision";

const leases: ProfileSupervisorLease[] = [];
afterEach(async () => { for (const lease of leases.splice(0)) await lease.close(); });
async function fixtureLease(options: Parameters<typeof createProfileSupervisorLease>[0] = {}) {
  const lease = await createProfileSupervisorLease(options); leases.push(lease); return lease;
}

test("profile supervisor accepts only its token and closes the lease with its owner", async () => {
  const events: Record<string, unknown>[] = [];
  const off = observeDiagnosticEvents(event => {
    if (event.stage === "profile_supervisor_lifecycle") events.push(structuralDiagnosticEvent(event)!);
  });
  const lease = await fixtureLease();
  try {
  const port = Number(lease.environment.CHATGPT_TELA_PRODUCT_SUPERVISOR_PORT);
  const token = lease.environment.CHATGPT_TELA_PRODUCT_SUPERVISOR_TOKEN!;
  const child = connect({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    child.once("connect", resolve);
    child.once("error", reject);
  });
  child.write(`${token}\n`);
  const reply = await new Promise<string>((resolve, reject) => {
    child.once("data", chunk => resolve(chunk.toString("utf8")));
    child.once("error", reject);
  });
  expect(reply).toBe("ok\n");
  await lease.connected;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  await lease.close();
  await closed;
  expect(events.slice(0, 3).map(event => event.phase)).toEqual(["listen_started", "listening", "authenticated"]);
  expect(events.some(event => event.phase === "close_requested")).toBe(true);
  expect(new Set(events.map(event => event.lease_fingerprint)).size).toBe(1);
  expect(events[0]!.lease_fingerprint).toMatch(/^[a-f0-9]{24}$/);
  expect(JSON.stringify(events)).not.toContain(token);
  } finally { off?.(); }
});

async function authenticated(lease: Awaited<ReturnType<typeof createProfileSupervisorLease>>) {
  const socket=connect({host:"127.0.0.1",port:Number(lease.environment.CHATGPT_TELA_PRODUCT_SUPERVISOR_PORT)});
  await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
  const ack=new Promise<string>((resolve,reject)=>{socket.once("data",b=>resolve(b.toString()));socket.once("error",reject);});
  socket.write(lease.environment.CHATGPT_TELA_PRODUCT_SUPERVISOR_TOKEN+"\n");expect(await ack).toBe("ok\n");return socket;
}
test("authenticated lifecycle retains early ready and accepts split UTF8 without stdout authority",async()=>{
 const phases:string[]=[]; const lease=await fixtureLease({onProgress:p=>phases.push(p)});const socket=await authenticated(lease);
 try {
  socket.write(JSON.stringify({stage:"product-profile-progress",phase:"browser"})+"\n");
  const frame=Buffer.from(JSON.stringify({stage:"product-profile-ready",label:"한글",slot:1})+"\n");
  const split=frame.indexOf(Buffer.from("한글"))+1;
  socket.write(frame.subarray(0,split)); socket.write(frame.subarray(split));
  expect(await lease.ready).toEqual({stage:"product-profile-ready",label:"한글",slot:1});expect(phases).toEqual(["browser"]);
 }finally{socket.destroy();}
});
test("invalid lifecycle payload fails closed and closes the same supervision lease",async()=>{
 const lease=await fixtureLease();const socket=await authenticated(lease);
 try {socket.write('{"stage":"unknown"}\n');await expect(lease.ready).rejects.toThrow("invalid");}
 finally{socket.destroy();}
});
test("readiness stays bounded and rejects a partial oversized publication",async()=>{
 const lease=await fixtureLease();const socket=await authenticated(lease);
 try{socket.write("x".repeat(65537));await expect(lease.ready).rejects.toThrow("bounded");}
 finally{socket.destroy();}
});
test.each(["end", "destroy"] as const)("child %s before publication rejects readiness instead of leaving startup pending",async action=>{
 const lease=await fixtureLease();const socket=await authenticated(lease);
 try { socket[action]();await expect(lease.ready).rejects.toThrow("before readiness"); }
 finally {socket.destroy();await lease.close();}
});
