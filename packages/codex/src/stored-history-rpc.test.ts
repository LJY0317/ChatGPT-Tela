import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectStoredHistoryRpc } from "./stored-history-rpc";

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
