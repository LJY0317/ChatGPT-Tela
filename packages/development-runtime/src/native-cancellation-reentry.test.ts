import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlledBrowserHost } from "@chatgpt-tela/browser-host";
import type { CanonicalCurrentTurnSource, NativeVisiblePrefixSnapshot } from "@chatgpt-tela/codex";
import { NativeResponsesGateway, ActiveTurnRegistry, runBrowserContextCheckpoint } from "@chatgpt-tela/runtime";
import { produceNativePrefixCheckpoint } from "./native-visible-prefix-checkpoint";
import { FileNativeVisiblePrefixStageJournal } from "./native-visible-prefix-journal";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

for (const replacement of ["new message", "edited original message"]) {
  for (const phase of ["preparation", "submitted", "completed"] as const) {
    test(`cancel during ${phase}, then ${replacement}: one owner, closed checkpoint and no old final`, async () => {
      const root = await mkdtemp(join(tmpdir(), "tela-cancel-reentry-"));
      const journal = new FileNativeVisiblePrefixStageJournal({ directory: join(root, "journal"), initializationPath: join(root, "receipt") });
      let current = "first", calls = 0, closes = 0, tasks = 0;
      const owners = new Map([["first", new AbortController()], ["second", new AbortController()]]);
      const entered = deferred(), closing = deferred(), allowClose = deferred();
      const source: CanonicalCurrentTurnSource = {
        async currentTurn(threadId) { return { threadId, turnId: current, cwd: "/fixture", workspaceRoots: ["/fixture"],
          sandbox: { kind: "read-only", network: "restricted" }, proof: "turn-context", environmentSourceTurnId: current }; },
        async watchTurn(_thread, turnId) { return { signal: owners.get(turnId)!.signal, async close() {} }; },
      };
      const host = new ControlledBrowserHost(async () => ({ async navigate() {}, async reveal() {}, async hide() {},
        async close() { closes++; if (closes === 1) { closing.resolve(); await allowClose.promise; } },
      }));
      const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async (turn, _body, signal) => {
        if (!signal) throw Error("fixture requires Native lifetime signal");
        const content = JSON.stringify({ type: "tela_native_visible_prefix_v1", items: [{ type: "agentMessage", text: "Unchanged historical prefix." }] });
        const snapshot: NativeVisiblePrefixSnapshot = { kind: "native-visible-prefix", threadId: "thread", currentTurnId: current,
          contentDigest: hash(content), digest: hash(content), sourceItemCount: 1, content, inlineAssets: [], references: [], localImageCandidates: [] };
        await produceNativePrefixCheckpoint({ source: snapshot, accountNamespace: "fixture", journal, effort: "medium", signal,
          confirmSource: async () => ({ ...snapshot, currentTurnId: turn.channel.binding.authority.turnId }),
          producer: async request => {
            const result = await runBrowserContextCheckpoint({ browserHost: host, signal,
              ...(request.persistResult ? { persistResult: request.persistResult } : {}),
              request: { ...request, webEpochId: "isolated-checkpoint" },
              provider: {
                async observeCapabilities() {
                  if (phase === "preparation" && current === "first") { entered.resolve(); await new Promise<void>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })); }
                  return { state: "proven", value: { observed: new Set(["composer", "send"]) }, evidence: ["fixture"] };
                },
                async createContextCheckpoint(_surface, r) {
                  calls++;
                  if (current === "first") {
                    entered.resolve();
                    if (phase === "completed") owners.get("first")!.abort(new Error("user stopped at completion"));
                    else await new Promise<void>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
                  }
                  return { state: "proven", value: { ...r, providerOperationId: "fixture-operation", content: "Verified bounded historical summary." }, evidence: ["fixture"] };
                },
              },
            });
            return { nativeTaskId: result.nativeTaskId, sourceRevisionId: result.sourceRevisionId, content: result.content };
          },
        });
        signal!.throwIfAborted(); tasks++;
        turn.channel.markSubmitted(); turn.channel.markAccepted(); turn.channel.complete("new authorized answer");
      });
      const request = (text: string) => ({ client_metadata: { "x-codex-turn-metadata": { request_kind: "turn", thread_id: "thread", turn_id: current } },
        input: [{ role: "user", content: text }], tools: [] });
      try {
        const first = gateway.handle(request("original")); void first.catch(() => {});
        await entered.promise;
        owners.get("first")!.abort(new Error("user stopped"));
        await closing.promise;
        current = "second";
        let settled = false;
        const next = gateway.handle(request(replacement)).finally(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(settled).toBe(false); expect(tasks).toBe(0);
        allowClose.resolve();
        await expect(first).rejects.toThrow();
        const answer = await next;
        expect(answer).toMatchObject({ type: "final", answer: "new authorized answer" });
        expect(tasks).toBe(1);
        expect(calls).toBe(phase === "preparation" || phase === "completed" ? 1 : 2);
        gateway.commit(answer);
      } finally { allowClose.resolve(); await gateway.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
    });
  }
}
