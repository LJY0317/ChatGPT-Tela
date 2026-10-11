import { expect, test } from "bun:test";
import { connect } from "node:net";
import { createProfileSupervisorLease } from "./profile-supervision";

test("profile supervisor accepts only its token and closes the lease with its owner", async () => {
  const lease = await createProfileSupervisorLease();
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
});

async function authenticated(lease: Awaited<ReturnType<typeof createProfileSupervisorLease>>) {
  const socket=connect({host:"127.0.0.1",port:Number(lease.environment.CHATGPT_TELA_PRODUCT_SUPERVISOR_PORT)});
  await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
  const ack=new Promise<string>((resolve,reject)=>{socket.once("data",b=>resolve(b.toString()));socket.once("error",reject);});
  socket.write(lease.environment.CHATGPT_TELA_PRODUCT_SUPERVISOR_TOKEN+"\n");expect(await ack).toBe("ok\n");return socket;
}
test("authenticated lifecycle retains early ready and accepts split UTF8 without stdout authority",async()=>{
 const phases:string[]=[]; const lease=await createProfileSupervisorLease({onProgress:p=>phases.push(p)});const socket=await authenticated(lease);
 try {
  socket.write(JSON.stringify({stage:"product-profile-progress",phase:"browser"})+"\n");
  const frame=Buffer.from(JSON.stringify({stage:"product-profile-ready",label:"한글",slot:1})+"\n");
  const split=frame.indexOf(Buffer.from("한글"))+1;
  socket.write(frame.subarray(0,split)); socket.write(frame.subarray(split));
  expect(await lease.ready).toEqual({stage:"product-profile-ready",label:"한글",slot:1});expect(phases).toEqual(["browser"]);
 }finally{socket.destroy();await lease.close();}
});
test("invalid lifecycle payload fails closed and closes the same supervision lease",async()=>{
 const lease=await createProfileSupervisorLease();const socket=await authenticated(lease);
 try {socket.write('{"stage":"unknown"}\n');await expect(lease.ready).rejects.toThrow("invalid");}
 finally{socket.destroy();await lease.close();}
});
test("readiness stays bounded and rejects a partial oversized publication",async()=>{
 const lease=await createProfileSupervisorLease();const socket=await authenticated(lease);
 try{socket.write("x".repeat(65537));await expect(lease.ready).rejects.toThrow("bounded");}
 finally{socket.destroy();await lease.close();}
});
test("child exit before publication rejects readiness instead of leaving startup pending",async()=>{
 const lease=await createProfileSupervisorLease();const socket=await authenticated(lease);
 socket.destroy();await expect(lease.ready).rejects.toThrow("before readiness");await lease.close();
});
