import { describe, expect, test } from "bun:test";
import { BROWSER_INPUT_OWNERSHIP, BROWSER_PAGE_AUTOMATION, ControlledBrowserHost } from "@chatgpt-tela/browser-host";
import type {
  WebContextCheckpointProvider,
  WebContextCheckpointRequest,
} from "@chatgpt-tela/chatgpt";
import { WebCheckpointOperationClosed } from "@chatgpt-tela/chatgpt";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrowserContextCheckpoint } from "./context-checkpoint";

function request(): WebContextCheckpointRequest {
  return {
    nativeTaskId: "task-1",
    webEpochId: "checkpoint-epoch-1",
    sourceRevisionId: "revision-2",
    physicalContext: {
      headRevisionId: "revision-2",
      mode: "full",
      logicalTokens: 4,
      transferTokens: 4,
      segments: [
        { type: "revision", revisionId: "revision-1", kind: "user", content: "first" },
        { type: "revision", revisionId: "revision-2", kind: "assistant", content: "second" },
      ],
    },
  };
}

function provider(overrides: Partial<WebContextCheckpointProvider> = {}): WebContextCheckpointProvider {
  return {
    async observeCapabilities() {
      return {
        state: "proven" as const,
        value: { observed: new Set(["composer", "send"]) },
        evidence: ["fixture"],
      };
    },
    async createContextCheckpoint(_surface, input) {
      return {
        state: "proven" as const,
        value: {
          nativeTaskId: input.nativeTaskId,
          webEpochId: input.webEpochId,
          sourceRevisionId: input.sourceRevisionId,
          providerOperationId: "checkpoint-op-1",
          content: "  compact canonical prefix  ",
        },
        evidence: ["fixture"],
      };
    },
    ...overrides,
  };
}

describe("browser context checkpoint runner", () => {
  test.each(["revoked", "unknown", "release-failed"] as const)("input ownership cancellation has an exact local closure boundary: %s", async scenario => {
    const inputOwner = new AbortController(), nativeOwner = new AbortController();
    const primary = new Error("private provider detail must not enter diagnostics");
    const scratch = mkdtempSync(join(tmpdir(), "tela-checkpoint-input-"));
    const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    const file = join(scratch, "events.jsonl");
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
    let calls = 0, closes = 0;
    const host = new ControlledBrowserHost(async () => ({
      async navigate() {}, async reveal() {}, async hide() {},
      async close() { closes++; if (scenario === "release-failed") throw Error("close failed"); },
      capability(cap) { return cap === BROWSER_INPUT_OWNERSHIP
        ? {current: () => ({revision: 0, available: true, signal: inputOwner.signal})} as any : undefined; },
    }));
    try {
      let caught: unknown;
      try { await runBrowserContextCheckpoint({browserHost: host, request: request(), signal: nativeOwner.signal,
        provider: provider({async createContextCheckpoint(_surface, _request, signal) {
          calls++;
          if (scenario !== "unknown") inputOwner.abort(primary);
          expect(signal?.aborted).toBe(scenario !== "unknown");
          throw primary;
        }}),
      }); } catch (error) { caught = error; }
      if (scenario !== "release-failed") expect(caught).toMatchObject({name: "WebCheckpointOperationClosed", cause: primary,
        receipt: {disposition: "released_locally"}});
      else {
        expect(caught).not.toBeInstanceOf(WebCheckpointOperationClosed);
      }
      expect(nativeOwner.signal.aborted).toBe(false);
      expect(calls).toBe(1); expect(closes).toBe(1);
      const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(rows.find(row => row.stage === "context_checkpoint_failed")).toMatchObject({
        reason_class: scenario === "unknown" ? "provider_error" : "input_revoked",
      });
      expect(rows.some(row => row.stage === "context_checkpoint_closed")).toBe(scenario !== "release-failed");
      expect(rows.some(row => row.stage === "context_checkpoint_release_failed")).toBe(scenario === "release-failed");
      expect(JSON.stringify(rows)).not.toContain("private provider detail");
    } finally {
      await host.close().catch(() => {});
      if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
      rmSync(scratch, {recursive: true, force: true});
    }
  });
  test("cancellation receipt requires successful physical close; a failed close stays uncertain", async () => {
    for (const failClose of [false, true]) {
      const abort = new AbortController(); let invoked = 0;
      const host = new ControlledBrowserHost(async () => ({ async navigate() {}, async reveal() {}, async hide() {},
        async close() { if (failClose) throw Error("physical close failed"); },
      }));
      let caught: unknown;
      try { await runBrowserContextCheckpoint({ browserHost: host, request: request(), signal: abort.signal,
        provider: provider({ async observeCapabilities() { abort.abort(); throw Error("stopped before provider invocation"); },
          async createContextCheckpoint() { invoked++; throw Error("unreachable"); } }),
      }); } catch (error) { caught = error; }
      expect(invoked).toBe(0);
      if (failClose) { expect(caught).not.toBeInstanceOf(WebCheckpointOperationClosed); expect(String(caught)).toContain("physical close failed"); }
      else expect(caught).toMatchObject({ receipt: { disposition: "not_invoked" } });
      await host.close();
    }
  });
  test("accepts only one proven dedicated result and always releases its isolated surface", async () => {
    const events: string[] = [];
    const host = new ControlledBrowserHost(async input => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() { events.push(`close:${input.taskId}:${input.epochId}`); },
    }));
    try {
      const result = await runBrowserContextCheckpoint({
        browserHost: host,
        provider: provider(),
        request: request(),
      });
      expect(result).toEqual({
        nativeTaskId: "task-1",
        webEpochId: "checkpoint-epoch-1",
        sourceRevisionId: "revision-2",
        providerOperationId: "checkpoint-op-1",
        content: "compact canonical prefix",
      });
      expect(events).toEqual(["close:task-1:checkpoint-epoch-1"]);
      expect(host.activeSurfaceCount).toBe(0);
    } finally {
      await host.close();
    }
  });

  test("fails closed when the dedicated result names a different source and still releases", async () => {
    const events: string[] = [];
    const host = new ControlledBrowserHost(async () => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() { events.push("close"); },
    }));
    const mismatched = provider({
      async createContextCheckpoint(_surface, input) {
        return {
          state: "proven" as const,
          value: {
            nativeTaskId: input.nativeTaskId,
            webEpochId: input.webEpochId,
            sourceRevisionId: "other-revision",
            providerOperationId: "checkpoint-op-wrong",
            content: "wrong",
          },
          evidence: ["fixture"],
        };
      },
    });
    try {
      await expect(runBrowserContextCheckpoint({
        browserHost: host,
        provider: mismatched,
        request: request(),
      })).rejects.toMatchObject({name: "WebCheckpointOperationClosed", cause: {message: "checkpoint provider returned a result for a different causal source"}});
      expect(events).toEqual(["close"]);
    } finally {
      await host.close();
    }
  });

  test.each([false, true])("aborted checkpoint captures before release and preserves failure (broken capture=%s)", async broken => {
    const root = mkdtempSync(join(tmpdir(), "tela-checkpoint-failure-"));
    const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = join(root, "events.jsonl");
    const events: string[] = [];
    const controller = new AbortController();
    const primary = new Error("checkpoint deadline fixture");
    const host = new ControlledBrowserHost(async () => ({
      async navigate() {}, async reveal() {}, async hide() {},
      async close() { events.push("close"); },
      capability(cap) {
        if (cap !== BROWSER_PAGE_AUTOMATION) return undefined;
        return { async evaluate(_source: string, privateCapture: boolean, signal: AbortSignal) {
          events.push("capture");
          expect(controller.signal.aborted).toBe(true);
          expect(signal.aborted).toBe(false);
          expect(privateCapture).toBe(false);
          if (broken) throw Error("diagnostic fixture failed");
          return { element_count: 1, capture_safe: true };
        } } as any;
      },
    }));
    try {
      await expect(runBrowserContextCheckpoint({ browserHost: host, signal: controller.signal,
        request: { ...request(), webEpochId: `failed-${broken}` },
        provider: provider({ async createContextCheckpoint() { controller.abort(); throw primary; } }),
      })).rejects.toMatchObject({ name: "WebCheckpointOperationClosed", cause: primary,
        receipt: { disposition: "released_locally" } });
      expect(events).toEqual(["capture", "close"]);
      expect(host.activeSurfaceCount).toBe(0);
    } finally {
      await host.close();
      if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects a non-full or mis-anchored source before acquiring a browser surface", async () => {
    let acquisitions = 0;
    const host = new ControlledBrowserHost(async () => {
      acquisitions += 1;
      return {
        async navigate() {}, async reveal() {}, async hide() {}, async close() {},
      };
    });
    try {
      const invalid = {
        ...request(),
        sourceRevisionId: "revision-1",
      };
      await expect(runBrowserContextCheckpoint({
        browserHost: host,
        provider: provider(),
        request: invalid,
      })).rejects.toThrow("physical context head");
      expect(acquisitions).toBe(0);
    } finally {
      await host.close();
    }
  });
});

describe("durable checkpoint settlement", () => {
  test("a proven result racing host revocation is persisted before release", async () => {
    const inputOwner = new AbortController(), events: string[] = [];
    const host = new ControlledBrowserHost(async () => ({
      async navigate() {}, async reveal() {}, async hide() {},
      async close() { events.push("close"); },
      capability(cap) { return cap === BROWSER_INPUT_OWNERSHIP
        ? {current: () => ({revision: 0, available: true, signal: inputOwner.signal})} as any : undefined; },
    }));
    const completed = provider();
    try {
      const result = await runBrowserContextCheckpoint({browserHost: host, request: request(),
        provider: provider({async createContextCheckpoint(surface, request, signal) {
          const result = await completed.createContextCheckpoint(surface, request, signal);
          inputOwner.abort();
          return result;
        }}),
        persistResult: async result => { expect(result.sourceRevisionId).toBe("revision-2"); events.push("persist"); },
      });
      expect(result.content).toBe("compact canonical prefix");
      expect(events).toEqual(["persist", "close"]);
      expect(host.activeSurfaceCount).toBe(0);
    } finally { await host.close(); }
  });
  test.each([false, true])("persists validated output before physical release (close fails=%s)", async failClose => {
    const events: string[] = [];
    const host = new ControlledBrowserHost(async () => ({
      async navigate() {}, async reveal() {}, async hide() {},
      async close() { events.push("close"); if (failClose) throw Error("release failed"); },
    }));
    try {
      const run = runBrowserContextCheckpoint({ browserHost: host, request: request(), provider: provider(),
        persistResult: async result => { expect(result.content).toBe("compact canonical prefix"); events.push("persist"); } });
      if (failClose) await expect(run).rejects.toThrow("release failed"); else await run;
      expect(events).toEqual(["persist", "close"]);
    } finally { await host.close().catch(() => {}); }
  });
  test("failed persistence cannot report successful preparation", async () => {
    const host = new ControlledBrowserHost(async () => ({ async navigate() {}, async reveal() {}, async hide() {}, async close() {} }));
    try {
      await expect(runBrowserContextCheckpoint({ browserHost:host, request:request(), provider:provider(),
        persistResult:async()=>{throw Error("durable write failed");} })).rejects.toMatchObject({name: "WebCheckpointOperationClosed", cause: {message: "durable write failed"}});
    } finally { await host.close(); }
  });
  test("foreign results never reach persistence", async()=>{
    let writes=0;
    const host = new ControlledBrowserHost(async () => ({ async navigate() {}, async reveal() {}, async hide() {}, async close() {} }));
    try {
      await expect(runBrowserContextCheckpoint({browserHost:host,request:request(),persistResult:async()=>{writes++;},
        provider:provider({async createContextCheckpoint(){return {state:"proven",evidence:["fixture"],value:{
          nativeTaskId:"foreign",sourceRevisionId:"revision-2",webEpochId:"checkpoint-epoch-1",providerOperationId:"op",content:"summary"}};}})})).rejects.toMatchObject({name: "WebCheckpointOperationClosed", cause: {message: "checkpoint provider returned a result for a different causal source"}});
      expect(writes).toBe(0);
    } finally {await host.close();}
  });
  test("successful release always closes locally; only exact completion classifies a rejected response",async()=>{
    const {WebCheckpointResponseRejected}=await import("@chatgpt-tela/chatgpt");
    for(const scenario of ["exact","task","source","epoch","empty-operation","generic","close-failed"]){
      const receipt={nativeTaskId:"task-1",sourceRevisionId:"revision-2",webEpochId:"checkpoint-epoch-1",providerOperationId:"op",reason:"json_invalid" as const};
      if(scenario==="task")receipt.nativeTaskId="foreign";
      if(scenario==="source")receipt.sourceRevisionId="foreign";
      if(scenario==="epoch")receipt.webEpochId="foreign";
      if(scenario==="empty-operation")receipt.providerOperationId="";
      const host=new ControlledBrowserHost(async()=>({async navigate(){},async reveal(){},async hide(){},
        async close(){if(scenario==="close-failed")throw Error("release failed");}}));
      let caught:unknown;
      try{await runBrowserContextCheckpoint({browserHost:host,request:request(),provider:provider({
        async createContextCheckpoint(){throw scenario==="generic"?Error("unknown"):new WebCheckpointResponseRejected(receipt,"invalid");}
      })});}catch(error){caught=error;}
      if(scenario==="exact")expect(caught).toMatchObject({name:"WebCheckpointOperationClosed",receipt:{disposition:"completed_unusable"}});
      else if(scenario==="close-failed") expect(caught).not.toBeInstanceOf(WebCheckpointOperationClosed);
      else expect(caught).toMatchObject({name:"WebCheckpointOperationClosed",receipt:{disposition:"released_locally"}});
      await host.close().catch(()=>{});
    }
  });
});
