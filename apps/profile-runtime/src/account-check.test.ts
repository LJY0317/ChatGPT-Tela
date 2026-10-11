import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createAccountCheck } from "./account-check";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const account = digest("synthetic-user-and-container");
const web = async () => ({ accountFingerprint: account, containerFingerprint: digest("synthetic-container"), accountStructure: "workspace" as const });
const native = async () => ({ account: { type: "chatgpt", email: "private@example.invalid" }, workspaceRouting: { chatgptAccountId: "synthetic-container" } });

test("shared container is not a proven user match; response contains no identity", async () => {
  const value = await createAccountCheck({ native, web, binding: () => account })();
  expect(value).toEqual({nativeSignIn:"signed-in",webBinding:"matching",nativeWebContainer:"matching",userIdentity:"unverified"});
  expect(JSON.stringify(value)).not.toContain("private@");
  expect(JSON.stringify(value)).not.toContain(account);
  expect(JSON.stringify(value)).not.toContain("synthetic-container");
});
test("changed Web binding and different Native container are separate observations", async () => {
  const value = await createAccountCheck({native:async()=>({account:{type:"chatgpt"},workspaceRouting:{chatgptAccountId:"another"}}),web,binding:()=>digest("old")})();
  expect(value.webBinding).toBe("different"); expect(value.nativeWebContainer).toBe("different"); expect(value.userIdentity).toBe("unverified");
});
test("missing optional Native routing metadata cannot imply equality", async () => {
  const value = await createAccountCheck({native:async()=>({account:{type:"chatgpt"}}),web,binding:()=>undefined})();
  expect(value.nativeWebContainer).toBe("unavailable"); expect(value.webBinding).toBe("unbound");
});
test("signed-out Native and unavailable Web do not fabricate a mismatch or trigger login", async () => {
  const value = await createAccountCheck({native:async()=>({account:null}),web:()=>{throw Error("no runtime");},binding:()=>{throw Error("not called");}})();
  expect(value.nativeSignIn).toBe("signed-out"); expect(value.webBinding).toBe("unavailable"); expect(value.nativeWebContainer).toBe("unavailable");
});
test("parallel checks coalesce; next explicit check reads fresh state without an idle timer", async () => {
  let calls=0; let finish:((value:any)=>void)|undefined;
  const check=createAccountCheck({native:()=>{calls++;return new Promise(resolve=>{finish=resolve;});},web,binding:()=>account});
  const a=check(),b=check(); expect(a).toBe(b); await Promise.resolve(); expect(calls).toBe(1);
  finish!({account:null}); await a;
  const c=check(); await Promise.resolve(); expect(calls).toBe(2); finish!({account:{type:"chatgpt"}}); await c;
});

test("runtime shutdown settles a stuck observation and prevents new reads", async () => {
  const owner = new AbortController(); let calls = 0;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const check = createAccountCheck({ signal: owner.signal, native,
    web: async () => { calls++; entered(); return new Promise(() => {}); }, binding: () => account });
  const pending = check(); await started;
  owner.abort();
  const value = await pending;
  expect(value.webBinding).toBe("unavailable");
  expect(value.userIdentity).toBe("unverified");
  const after = await check();
  expect(after.nativeSignIn).toBe("unavailable");
  expect(calls).toBe(1);
});
