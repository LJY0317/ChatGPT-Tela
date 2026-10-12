import { expect, test } from "bun:test";
import { auditNativePublicContinuityProtocol } from "./public-continuity-protocol-audit";

function fixture(overrides: {
  readonly advertisedMethods?: readonly string[];
  readonly threadFields?: Record<string, unknown>;
  readonly forkFields?: Record<string, unknown>;
} = {}) {
  const methods = overrides.advertisedMethods ?? [
    "thread/read", "thread/turns/list", "thread/items/list", "thread/compact/start",
  ];
  return {
    requests: { oneOf: methods.map(method => ({
      properties: { method: { enum: [method] } },
    })) },
    threadReadParams: { properties: { threadId: {}, includeTurns: { type: "boolean" } } },
    threadReadResponse: { definitions: {
      Thread: { properties: {
        historyMode: {}, model: {
          description: "Current configured model when loaded. This is not per-turn execution telemetry.",
        }, ...overrides.threadFields,
      } },
      ThreadHistoryMode: { enum: ["legacy", "paginated"] },
      ThreadStatus: { oneOf: [
        { properties: { type: { enum: ["active"] }, activeFlags: {} } },
      ] },
      ThreadItem: { oneOf: [
        { properties: { type: { enum: ["contextCompaction"] }, id: {} } },
      ] },
    } },
    forkParams: { properties: overrides.forkFields ?? {
      threadId: {}, model: {}, sandbox: {}, approvalPolicy: {}, ephemeral: {},
    } },
  };
}

test("actual-style public Codex metadata and compaction schemas cannot attest a Legacy automatic continuation", () => {
  const audit = auditNativePublicContinuityProtocol(fixture());
  expect(audit).toMatchObject({
    source: "generated_codex_app_server_experimental_schema",
    methodCount: 4,
    observations: {
      metadataOnlyThreadRead: true,
      paginatedTurnsAndItems: true,
      historyModes: ["legacy", "paginated"],
      activeThreadStatusFields: ["activeFlags", "type"],
      publicCompactionItemFields: ["id", "type"],
      threadModelProvenance: "explicitly_not_per_turn",
      forkToolControlFields: [],
      futureProtocolCandidates: ["thread/compact/start"],
    },
    requirements: {
      atomicCurrentTurnRevision: "not_proven",
      boundedLegacyReadableContext: "not_proven",
      historicalExecutedModelProvider: "not_proven",
      preExecutionToolFreeFork: "not_proven",
    },
    productionAutomaticHandoff: "default_deny",
  });
});

test("new candidate names and suggestive option fields never silently enable unverified engine authority", () => {
  const input = fixture({
    advertisedMethods: ["thread/read", "thread/context/export", "turn/execution/provenance"],
    threadFields: { currentTurnId: {}, sourceRevision: {}, model: { description: "executed model" } },
    forkFields: { toolPolicy: {}, noTools: {}, threadId: {} },
  });
  const audit = auditNativePublicContinuityProtocol(input);
  expect(audit.observations.futureProtocolCandidates).toEqual([
    "thread/context/export", "turn/execution/provenance",
  ]);
  expect(audit.observations.threadModelProvenance).toBe("unverified");
  expect(audit.observations.forkToolControlFields).toEqual(["noTools", "toolPolicy"]);
  expect(Object.values(audit.requirements)).toEqual(Array(4).fill("not_proven"));
  expect(audit.productionAutomaticHandoff).toBe("default_deny");
});

test("missing or duplicate public protocol declarations fail instead of guessing", () => {
  expect(() => auditNativePublicContinuityProtocol({ ...fixture(),
    requests: { oneOf: [] }, threadReadResponse: {},
  })).toThrow("thread metadata contract");
  expect(() => auditNativePublicContinuityProtocol(fixture({
    advertisedMethods: ["thread/read", "thread/read"],
  }))).toThrow("duplicated");
  expect(() => auditNativePublicContinuityProtocol({ ...fixture(),
    requests: { oneOf: [{ properties: { method: { enum: ["thread/read", "thread/fork"] } } }] },
  })).toThrow("malformed");
});
