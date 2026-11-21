import { readIndexedNativeItemsPage } from "./native-history-items";
import { connectOfficialStdio } from "./stored-history-rpc";

interface OfficialTurn {
  id: string;
  status: string;
}

/** Own a new conversation and one turn through the official process. */
export async function runOfficialWebDelegation(input: {
  executable: string; codexHome: string; cwd: string; model: string; title: string; prompt: string;
}) {
  if (!input.model.startsWith("chatgpt-tela-web/")) throw Error("Choose a Tela Web model");
  const rpc = await connectOfficialStdio({ ...input, clientName: "tela-web-delegation" });
  let threadId: string | undefined;
  let turnId: string | undefined;
  try {
    const created = await rpc.send("thread/start", {
      cwd: input.cwd, model: input.model, modelProvider: "openai", approvalPolicy: "never", sandbox: "read-only",
    }) as { model?: string; thread?: { id: string; modelProvider: string } };
    threadId = created.thread?.id;
    if (!threadId || created.model !== input.model || created.thread?.modelProvider !== "openai") {
      throw Error("Official Codex did not acknowledge the requested Web model");
    }
    await rpc.send("thread/name/set", { threadId, name: input.title });

    const completion = Promise.withResolvers<OfficialTurn>();
    const earlyCompletions = new Map<string, OfficialTurn>();
    const unsubscribe = rpc.subscribe((method, value) => {
      if (method !== "turn/completed") return;
      const event = value as { threadId?: string; turn?: OfficialTurn } | undefined;
      if (event?.threadId !== threadId || !event?.turn) return;
      if (event.turn.id === turnId) completion.resolve(event.turn);
      else if (!turnId) earlyCompletions.set(event.turn.id, event.turn);
    });
    try {
      const started = await rpc.send("turn/start", {
        threadId, model: input.model, input: [{ type: "text", text: input.prompt }],
      }) as { turn?: OfficialTurn };
      turnId = started.turn?.id;
      if (!turnId) throw Error("Official Codex did not return the turn ID");
      const turn = earlyCompletions.get(turnId) ?? await Promise.race([completion.promise, rpc.exited.then(() => undefined)]);
      if (!turn || turn.id !== turnId) throw Error("The submitted turn's completion could not be confirmed");
      if (turn.status !== "completed") return { threadId, turnId, status: turn.status };
    } finally {
      unsubscribe();
    }

    let cursor: string | undefined;
    do {
      const page = await readIndexedNativeItemsPage({ request: rpc.send }, {
        threadId, turnId, sortDirection: "desc", limit: 20, ...(cursor ? { cursor } : {}),
      });
      const final = page.data.find(({ item }) => item.type === "agentMessage" && item.phase === "final_answer")?.item;
      if (final && typeof final.text === "string" && final.text.trim()) {
        return { threadId, turnId, status: "completed" as const, itemId: final.id, answer: final.text };
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor !== cursor ? page.nextCursor : undefined;
    } while (cursor);
    throw Error("No saved final answer was returned for the completed turn");
  } catch (error) {
    const receipt = threadId ? ` (chat ${threadId}${turnId ? `, turn ${turnId}` : ""})` : "";
    throw Error(`${error instanceof Error ? error.message : String(error)}${receipt}`, { cause: error });
  } finally {
    await rpc.close();
  }
}
