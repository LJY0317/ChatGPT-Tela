import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatApprovedRootsFingerprint, manageChatApprovedRoots } from "./config";
import { startChatService } from "./index";

test("folder approvals preserve existing roots and reject relative and symlink grants",()=>{
 const root=mkdtempSync(join(tmpdir(),"tela-chat-folders-"));
 try {
  const config=join(root,"config.json"), one=join(root,"one"),two=join(root,"two");mkdirSync(one);mkdirSync(two);writeFileSync(join(one,"file"),"preserve");
  const first=manageChatApprovedRoots(config,"allow-root",one);const fingerprint=chatApprovedRootsFingerprint(first);
  manageChatApprovedRoots(config,"allow-root",two);expect(manageChatApprovedRoots(config,"roots").roots).toHaveLength(2);
  expect(()=>manageChatApprovedRoots(config,"allow-root","relative")).toThrow("absolute");
  if(process.platform!=="win32") {symlinkSync(one,join(root,"link"));expect(()=>manageChatApprovedRoots(config,"allow-root",join(root,"link"))).toThrow("real directory");}
  const revoked=manageChatApprovedRoots(config,"disallow-root",two);expect(chatApprovedRootsFingerprint(revoked)).toBe(fingerprint);
  expect(readFileSync(join(one,"file"),"utf8")).toBe("preserve");
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("active folder fingerprint is authenticated, path-free, and fixed for the service lifetime",async()=>{
 const fingerprint=chatApprovedRootsFingerprint({version:1,roots:["/fixture/approved"]});
 const bearerToken="acceptance-token-".repeat(3);const service=await startChatService({bearerToken,workspacePolicyFingerprint:fingerprint});
 try {
  const url=new URL("v1/chat/workspace-policy",service.endpoint);
  expect((await fetch(url)).status).toBe(401);
  const value=await (await fetch(url,{headers:{authorization:`Bearer ${bearerToken}`}})).json();
  expect(value).toEqual({contractVersion:1,service:"chat",fingerprint});
  expect(JSON.stringify(value)).not.toContain("/fixture/approved");
  expect(fingerprint).not.toBe(chatApprovedRootsFingerprint({version:1,roots:[]}));
 }finally{await service.close();}
});
