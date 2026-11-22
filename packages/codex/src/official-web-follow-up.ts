import { connectOfficialStdio } from "./stored-history-rpc";
import { readDynamicWebModelCatalog } from "./web-model-catalog";
import { readIndexedNativeItemsPage } from "./native-history-items";

/** The owning service must resolve this from an enrolled, unsettled record. */
export interface RegisteredWebFollowUp {
  threadId: string;
  profileScope: string;
  accountFingerprint: string;
  model: string;
  parentThreadId?: string;
}

interface FollowUpRpc {
  send(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
  exited: Promise<void>;
  subscribe(notify: (method: string, params: unknown) => void): () => void;
}

interface OfficialTurn { id: string; status: string }

export interface OfficialWebFollowUpReceipt {
  threadId: string;
  turnId: string;
  model: string;
  status: "accepted";
}

/** Own the resumed writer until the newly submitted turn completes. */
export async function runOfficialWebFollowUp(input: {
  threadId: string;
  resolveRegistration(threadId: string): Promise<RegisteredWebFollowUp>;
  profileScope: string;
  accountFingerprint: string;
  prompt: string;
  executable: string;
  codexHome: string;
  connect?: () => Promise<FollowUpRpc>;
  onAccepted?: (receipt: OfficialWebFollowUpReceipt, started: { turn: { id: string } }, interrupt: () => Promise<unknown>) => void | Promise<void>;
}) {
  const registration = await input.resolveRegistration(input.threadId);
  if (registration.threadId !== input.threadId || !registration.profileScope || !registration.accountFingerprint
    || !registration.model.startsWith("chatgpt-tela-web/")
    || registration.profileScope !== input.profileScope
    || registration.accountFingerprint !== input.accountFingerprint) {
    throw Error("Registered Web profile or account has changed");
  }
  if (!input.prompt.trim()) throw Error("A follow-up assignment is required");
  const rpc = await (input.connect?.() ?? connectOfficialStdio({
    executable: input.executable, codexHome: input.codexHome, clientName: "tela-web-follow-up",
    threadId: registration.threadId,
  }));
  try {
    const resumed = await rpc.send("thread/resume", { threadId: registration.threadId, excludeTurns: true }) as {
      thread?: { id?: string; model?: string; modelProvider?: string; status?: { type?: string };
        source?: string | { subAgent?: { thread_spawn?: { parent_thread_id?: string } } } };
    };
    const thread = resumed?.thread;
    const parent = typeof thread?.source === "object" ? thread.source.subAgent?.thread_spawn?.parent_thread_id : undefined;
    if (thread?.id !== registration.threadId || thread.modelProvider !== "openai"
      || thread.model !== registration.model || thread.status?.type !== "idle"
      || parent !== registration.parentThreadId
      || (registration.parentThreadId === undefined && typeof thread.source !== "string")) {
      throw Error("Official Web conversation identity or idle state changed");
    }
    const catalog = await readDynamicWebModelCatalog({ request: rpc.send });
    if (!catalog.includes(registration.model)) throw Error("The registered Web model is no longer available");
    const turns = await rpc.send("thread/turns/list", {
      threadId: registration.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
    }) as { data?: { id?: string; status?: string }[]; nextCursor?: string | null };
    if (!Array.isArray(turns?.data) || turns.data.length !== 1 || !turns.data[0]?.id
      || turns.data[0].status !== "completed") {
      throw Error("The registered Web conversation has no completed latest turn");
    }
    const completion = Promise.withResolvers<OfficialTurn>();
    const earlyCompletions = new Map<string, OfficialTurn>();
    let turnId: string | undefined;
    const unsubscribe = rpc.subscribe((method, value) => {
      if (method !== "turn/completed") return;
      const event = value as { threadId?: string; turn?: OfficialTurn } | undefined;
      if (event?.threadId !== registration.threadId || !event.turn?.id) return;
      if (event.turn.id === turnId) completion.resolve(event.turn);
      else if (!turnId) earlyCompletions.set(event.turn.id, event.turn);
    });
    try {
      const started = await rpc.send("turn/start", {
        threadId: registration.threadId, model: registration.model,
        input: [{ type: "text", text: input.prompt }],
      }) as { turn?: OfficialTurn };
      turnId = started?.turn?.id;
      if (!turnId) throw Error("The official writer did not acknowledge the new turn");
      await input.onAccepted?.({ threadId: registration.threadId, turnId, model: registration.model, status: "accepted" },
        { turn: started.turn! }, () => rpc.send("turn/interrupt", { threadId: registration.threadId, turnId }));
      const turn = earlyCompletions.get(turnId) ?? await Promise.race([completion.promise, rpc.exited.then(() => undefined)]);
      if (!turn || turn.id !== turnId) throw Error("The submitted follow-up turn's completion could not be confirmed");
      if (turn.status !== "completed") return { threadId: registration.threadId, turnId, model: registration.model, status: turn.status };
    } finally {
      unsubscribe();
    }

    let cursor: string | undefined;
    do {
      const page = await readIndexedNativeItemsPage({ request: rpc.send }, {
        threadId: registration.threadId, turnId: turnId!, sortDirection: "desc", limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      const final = page.data.find(({ item }) => item.type === "agentMessage" && item.phase === "final_answer")?.item;
      if (final && typeof final.text === "string" && final.text.trim()) {
        return { threadId: registration.threadId, turnId: turnId!, model: registration.model,
          status: "completed" as const, itemId: final.id, answer: final.text };
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor !== cursor ? page.nextCursor : undefined;
    } while (cursor);
    throw Error("No saved final answer was returned for the completed follow-up turn");
  } finally {
    await rpc.close();
  }
}

/** The caller can release its request after ACK while retaining finished and its writer. */
export function submitOfficialWebFollowUp(input: Parameters<typeof runOfficialWebFollowUp>[0]) {
  const accepted = Promise.withResolvers<OfficialWebFollowUpReceipt>();
  let interrupt: (() => Promise<unknown>) | undefined;
  const finished = runOfficialWebFollowUp({
    ...input,
    onAccepted: async (receipt, started, cancel) => {
      interrupt = cancel;
      try {
        await input.onAccepted?.(receipt, started, cancel);
        accepted.resolve(receipt);
      } catch (error) {
        accepted.reject(error);
      }
    },
  });
  void finished.catch(error => accepted.reject(error));
  return { accepted: accepted.promise, finished, interrupt: () => interrupt?.() };
}
