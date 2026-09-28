import { describe, expect, test } from "bun:test";
import { ControlledBrowserHost } from "@chatgpt-tela/browser-host";
import type {
  WebContextCheckpointProvider,
  WebContextCheckpointRequest,
} from "@chatgpt-tela/chatgpt";
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
      })).rejects.toThrow("different causal source");
      expect(events).toEqual(["close"]);
    } finally {
      await host.close();
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
