import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import { WebDelegationStore, reconcileWebDelegation, type WebDelegationAdapters } from "../web-delegation";

const [, , root, id, messageId, effects] = process.argv;
if (!root || !id || !messageId || !effects) throw Error("Missing fixture parameters");
const store = new WebDelegationStore(root);
const stale = store.get(id)!;
const rpc: CodexAppServerRpc = {
  subscribe: () => () => {},
  async close() {},
  async request(method, params) {
    if (method === "thread/turns/list") return { data: [{ id: stale.turnId, status: "failed", items: [] }], nextCursor: null };
    if (method === "thread/read") return { thread: { id: stale.coordinator?.threadId } };
    if (method === "thread/queue/add") {
      const queuedId = (params as { clientUserMessageId: string }).clientUserMessageId;
      appendFileSync(effects, `${queuedId}\n`); // The only mocked Queue side effect.
      return { queuedSubmission: { id: queuedId, clientUserMessageId: queuedId } };
    }
    throw Error(`Unexpected mock RPC method: ${method}`);
  },
};
const adapters: WebDelegationAdapters = {
  store, owner: async () => ({ binding: stale.owner, session: stale.session }), connect: async () => rpc,
};
console.log("ready");
for await (const command of createInterface({ input: process.stdin })) {
  if (command === "claim") {
    const claimed = store.claimCoordinatorNotice(id, messageId);
    console.log(claimed ? "claimed" : "rejected");
  } else if (command === "publish") {
    await rpc.request("thread/queue/add", { clientUserMessageId: messageId });
    store.updateCoordinatorNotice(id, { coordinatorClientUserMessageId: messageId,
      coordinatorNotice: "queued", coordinatorFollowThrough: "unobserved", coordinatorQueueItemId: messageId });
    console.log("published");
  } else if (command === "reconcile") {
    const settled = await reconcileWebDelegation(adapters, id, new AbortController().signal);
    console.log(`settled:${settled.state}:${settled.failureStage}`);
  } else if (command === "stale") {
    store.save({ ...stale, state: "uncertain" });
    console.log("saved");
  } else if (command === "exit") break;
}
