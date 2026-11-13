import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectDormantThreadRpc, connectStoredHistoryRpc } from "./stored-history-rpc";
import { observeDiagnosticEvents } from "@chatgpt-tela/core";

// Unix fixture executable; Windows execution remains an OS acceptance item.
(process.platform === "win32" ? test.skip : test)("official-reader transport cannot send model, mutation or other-thread requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tela-stored-rpc-")), file = join(directory, "reader"), trace = join(directory, "trace.jsonl");
  writeFileSync(file, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';let b='';for await(const c of process.stdin){b+=c.toString();let n;while((n=b.indexOf('\\n'))>=0){let m=JSON.parse(b.slice(0,n));b=b.slice(n+1);appendFileSync(${JSON.stringify(trace)},JSON.stringify(m)+'\\n');if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{method:m.method}})+'\\n');}}`, { mode: 0o755 });
  try {
    const rpc = await connectStoredHistoryRpc({ executable: file, codexHome: directory, threadId: "own" });
    expect(await rpc.request("thread/read", { threadId: "own", includeTurns: false })).toEqual({ method: "thread/read" });
    for (const [method, params] of [
      ["turn/start", { threadId: "own" }], ["thread/archive", { threadId: "own" }],
      ["thread/read", { threadId: "other", includeTurns: false }], ["thread/read", { threadId: "own", includeTurns: true }],
    ] as const) await expect(rpc.request(method, params)).rejects.toThrow("scoped indexed reads");
    await rpc.close();
    expect(readFileSync(trace, "utf8").trim().split("\n").map(l => JSON.parse(l).method))
      .toEqual(["initialize", "initialized", "thread/read"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

(process.platform === "win32" ? test.skip : test)("stored RPC failure retains its numeric cause without exposing error text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tela-stored-rpc-error-")), file = join(directory, "reader");
  writeFileSync(file, `#!${process.execPath}\nlet b='';for await(const c of process.stdin){b+=c.toString();let n;while((n=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,...(m.method==='initialize'?{result:{}}:{error:{code:-32602,message:'PRIVATE_THREAD_FAILURE'}})})+'\\n');}}`, { mode: 0o755 });
  const events: unknown[] = [];
  const unsubscribe = observeDiagnosticEvents(event => { if (event.stage === "stored_history_read_failed") events.push(event); });
  let rpc: Awaited<ReturnType<typeof connectStoredHistoryRpc>> | undefined;
  try {
    rpc = await connectStoredHistoryRpc({ executable: file, codexHome: directory, threadId: "own" });
    await expect(rpc.request("thread/read", { threadId: "own", includeTurns: false })).rejects.toThrow("Official stored history request failed");
    expect(events).toMatchObject([{ phase: "thread_read", reason_class: "rpc_error", rpc_error_code: -32602 }]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_THREAD_FAILURE");
  } finally { unsubscribe?.(); await rpc?.close(); rmSync(directory, { recursive: true, force: true }); }
});

(process.platform === "win32" ? test.skip : test)("lifecycle client requires its exact writer lease and never permits turns, deletes or overrides", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tela-lifecycle-rpc-")), file = join(directory, "reader"), trace = join(directory, "trace.jsonl");
  writeFileSync(file, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';let b='';for await(const c of process.stdin){b+=c.toString();let n;while((n=b.indexOf('\\n'))>=0){let m=JSON.parse(b.slice(0,n));b=b.slice(n+1);appendFileSync(${JSON.stringify(trace)},JSON.stringify(m)+'\\n');if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}}`, { mode: 0o755 });
  let rpc: Awaited<ReturnType<typeof connectDormantThreadRpc>> | undefined;
  try {
    rpc = await connectDormantThreadRpc({ executable: file, codexHome: directory, threadId: "own" });
    await expect(rpc.request("thread/archive", { threadId: "own" })).rejects.toThrow();
    for (const [method, params] of [
      ["turn/start", { threadId: "own" }], ["thread/delete", { threadId: "own" }],
      ["thread/unarchive", { threadId: "own" }], ["thread/resume", { threadId: "other", excludeTurns: true }],
      ["thread/resume", { threadId: "own", excludeTurns: true, modelProvider: "other" }],
      ["thread/resume", { threadId: "own", excludeTurns: false }],
    ] as const) await expect(rpc.request(method, params)).rejects.toThrow();
    await rpc.request("thread/resume", { threadId: "own", excludeTurns: true });
    await rpc.request("thread/archive", { threadId: "own" });
    await expect(rpc.request("thread/archive", { threadId: "own" })).rejects.toThrow();
    await rpc.close(); rpc = undefined;
    expect(readFileSync(trace, "utf8").trim().split("\n").map(l => JSON.parse(l).method))
      .toEqual(["initialize", "initialized", "thread/resume", "thread/archive"]);
  } finally { await rpc?.close(); rmSync(directory, { recursive: true, force: true }); }
});
