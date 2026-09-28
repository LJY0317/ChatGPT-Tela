import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  AppServerCurrentTurnSource,
  connectCodexAppServerWebSocket,
  type CodexAppServerRpc,
} from "./app-server";

class FixtureRpc implements CodexAppServerRpc {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  closed = 0;

  constructor(readonly responses: Readonly<Record<string, unknown>>) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, ...(params !== undefined ? { params } : {}) });
    if (!(method in this.responses)) throw new Error(`unexpected RPC method: ${method}`);
    return structuredClone(this.responses[method]);
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

function activeThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const workspace = resolve("/workspace");
  return {
    id: "thread-1",
    cwd: workspace,
    status: { type: "active", activeFlags: [] },
    parentThreadId: null,
    source: "cli",
    environments: [{
      environmentId: "env-1",
      cwd: resolve(workspace, "project"),
      runtimeWorkspaceRoots: [workspace],
    }],
    ...overrides,
  };
}

function turns(...values: Array<Record<string, unknown>>): Record<string, unknown> {
  return { data: values, nextCursor: null, backwardsCursor: null };
}

describe("Codex app-server current-turn authority", () => {
  test("binds one active newest turn using only public app-server thread/environment state", async () => {
    const rpc = new FixtureRpc({
      "thread/read": {
        thread: activeThread({
          parentThreadId: "parent-1",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "parent-1",
                agent_path: "agent/worker",
              },
            },
          },
        }),
      },
      "thread/turns/list": turns(
        { id: "turn-current", status: "inProgress", items: [] },
        { id: "turn-old", status: "completed", items: [] },
      ),
    });
    const source = new AppServerCurrentTurnSource(async () => rpc);

    expect(await source.currentTurn("thread-1")).toEqual({
      threadId: "thread-1",
      turnId: "turn-current",
      parentThreadId: "parent-1",
      agentName: "agent/worker",
      cwd: resolve("/workspace/project"),
      workspaceRoots: [resolve("/workspace")],
      sandbox: { kind: "native-enforced" },
      proof: "app-server-active-turn",
      environmentSourceTurnId: "turn-current",
    });
    expect(rpc.calls).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
      {
        method: "thread/turns/list",
        params: {
          threadId: "thread-1",
          limit: 2,
          sortDirection: "desc",
          itemsView: "notLoaded",
        },
      },
    ]);
    expect(rpc.closed).toBe(1);
  });

  test("falls back conservatively to the public thread cwd when environments are unavailable", async () => {
    const rpc = new FixtureRpc({
      "thread/read": { thread: activeThread({ environments: null, cwd: resolve("/plain") }) },
      "thread/turns/list": turns({ id: "turn-1", status: "inProgress", items: [] }),
    });
    const source = new AppServerCurrentTurnSource(async () => rpc);

    const evidence = await source.currentTurn("thread-1");
    expect(evidence?.cwd).toBe(resolve("/plain"));
    expect(evidence?.workspaceRoots).toEqual([resolve("/plain")]);
    expect(evidence?.sandbox).toEqual({ kind: "native-enforced" });
  });

  test("does not create current-turn authority for an inactive stored thread", async () => {
    const rpc = new FixtureRpc({
      "thread/read": { thread: activeThread({ status: { type: "idle" } }) },
    });
    const source = new AppServerCurrentTurnSource(async () => rpc);

    expect(await source.currentTurn("thread-1")).toBeUndefined();
    expect(rpc.calls.map(call => call.method)).toEqual(["thread/read"]);
    expect(rpc.closed).toBe(1);
  });

  test("fails closed when current-turn ordering or lineage is ambiguous", async () => {
    const staleNewest = new FixtureRpc({
      "thread/read": { thread: activeThread() },
      "thread/turns/list": turns(
        { id: "turn-completed", status: "completed", items: [] },
        { id: "turn-running", status: "inProgress", items: [] },
      ),
    });
    await expect(new AppServerCurrentTurnSource(async () => staleNewest).currentTurn("thread-1"))
      .rejects.toThrow("not the newest turn");

    const conflictingOwner = new FixtureRpc({
      "thread/read": {
        thread: activeThread({
          parentThreadId: "parent-a",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "parent-b",
                agent_path: "agent/worker",
              },
            },
          },
        }),
      },
      "thread/turns/list": turns({ id: "turn-1", status: "inProgress", items: [] }),
    });
    await expect(new AppServerCurrentTurnSource(async () => conflictingOwner).currentTurn("thread-1"))
      .rejects.toThrow("lineage is internally inconsistent");
  });
});

class FixtureWebSocket extends EventTarget {
  readyState = 0;
  readonly sent: unknown[] = [];
  closed: { code?: number; reason?: string } | undefined;

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    if (message.method === "initialize" && typeof message.id === "number") {
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }),
        }));
      });
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed = {
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.dispatchEvent(new Event("close"));
  }
}

describe("Codex app-server WebSocket transport", () => {
  test("performs the official initialize/initialized handshake on a loopback endpoint", async () => {
    const socket = new FixtureWebSocket();
    const connecting = connectCodexAppServerWebSocket("ws://127.0.0.1:19001", {
      createWebSocket(url) {
        expect(url).toBe("ws://127.0.0.1:19001/");
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const rpc = await connecting;

    expect(socket.sent).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "chatgpt-tela",
            title: "ChatGPT Tela",
            version: "0.0.0",
          },
          capabilities: { experimentalApi: true },
        },
      },
      { method: "initialized" },
    ]);
    await rpc.close();
    expect(socket.closed?.code).toBe(1000);
  });

  test("refuses non-loopback or secure-remote endpoints before creating a socket", async () => {
    let created = 0;
    const createWebSocket = () => {
      created += 1;
      return new FixtureWebSocket();
    };
    await expect(connectCodexAppServerWebSocket("wss://example.com/rpc", { createWebSocket }))
      .rejects.toThrow("must use ws://");
    await expect(connectCodexAppServerWebSocket("ws://192.0.2.1:19001", { createWebSocket }))
      .rejects.toThrow("loopback-only");
    expect(created).toBe(0);
  });
});
