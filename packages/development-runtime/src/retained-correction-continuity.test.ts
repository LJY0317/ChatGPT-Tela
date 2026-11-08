import { expect, test } from "bun:test";
import { NativeToolInventory, defineNativeTurnAuthority } from "@chatgpt-tela/core";
import { ActiveTurnRegistry } from "@chatgpt-tela/runtime";
import { projectFreshWebPhysicalContext } from "./provider-projection";
import { createNativeRequestDevelopmentWebTurnPlanner } from "./native-request-planner";

// Synthetic conversation roles and order model a correction after an earlier
// unsupported inference. No third-party case text, account or device details.
test("five retained follow-ups preserve a user correction without reinjecting stale claims", async () => {
  const planner = createNativeRequestDevelopmentWebTurnPlanner({
    checkpointProducer: async () => { throw Error("a retained page must not re-summarize its prefix"); },
  });
  const input: Array<{ type: string; role: string; content: string }> = [
    { type: "message", role: "user", content: "Please stop the application." },
  ];
  const registry = new ActiveTurnRegistry();
  const register = (turnId: string) => registry.register({
    claim: { threadId: "continuity-case", turnId, requestKind: "turn", toolObservations: [] },
    authority: defineNativeTurnAuthority({ threadId: "continuity-case", turnId,
      cwd: "/fixture", workspaceRoots: ["/fixture"],
      sandbox: { kind: "read-only", network: "restricted" } }),
    tools: NativeToolInventory.fromObservations("continuity-case", turnId, []),
    canonicalEvidence: { threadId: "continuity-case", turnId,
      cwd: "/fixture", workspaceRoots: ["/fixture"],
      sandbox: { kind: "read-only", network: "restricted" },
      proof: "turn-context" as const, environmentSourceTurnId: turnId },
  });
  const requests = [
    "Stop it once more.",
    "Correction: I launched it manually; it did not automatically restart. Check the device warning.",
    "The warning is visible now. Previous device logs are historical observations.",
    "The device remains physically connected. The present detection result is unknown.",
    "A different device is listed; the intended device is not shown. Separate observation from cause.",
  ];
  const answers = [
    "The application was stopped.",
    "It restarted automatically.", // deliberately unsupported assistant inference
    "Manual launch correction acknowledged; the device warning needs investigation.",
    "Historical recognition does not establish present connectivity.",
    "Present detection remains unverified without an exact observation.",
    "A missing listing narrows possibilities but does not establish a root cause.",
  ];
  let previous = await planner(register("turn-0"), { model: "native-model-a", input });
  expect(previous.physicalContext.mode).not.toBe("retained-delta");
  const epoch = previous.webEpochId;
  previous.settle?.({ status: "completed", surfaceLeaseId: "same-physical-page",
    documentGeneration: 1, answer: answers[0]! });
  const deltas: string[] = [];
  for (let i = 0; i < requests.length; i++) {
    input.push({ type: "message", role: "assistant", content: answers[i]! });
    input.push({ type: "message", role: "user", content: requests[i]! });
    const next = await planner(register(`turn-${i + 1}`), { model: "native-model-a", input });
    expect(next.webEpochId).toBe(epoch);
    expect(next.retainedSurfaceLeaseId).toBe("same-physical-page");
    expect(next.retainedDocumentGeneration).toBe(1);
    expect(next.physicalContext.mode).toBe("retained-delta");
    expect(next.diagnostics).toMatchObject({ retained_delta: true, provider_projection: false });
    const projected = projectFreshWebPhysicalContext(next.physicalContext, {
      historicalToolTotalTokens: 0, historicalAssistantTotalTokens: 0,
    });
    expect(projected.context).toBe(next.physicalContext);
    const revisionContents = next.physicalContext.segments.filter(segment => segment.type === "revision")
      .map(segment => segment.content);
    expect(revisionContents).toEqual([requests[i]!]);
    expect(next.physicalContext.activeRequestRevisionId).toBe(next.physicalContext.headRevisionId);
    expect(next.physicalContext.baseRevisionId).toBeDefined();
    deltas.push(...revisionContents);
    next.settle?.({ status: "completed", surfaceLeaseId: "same-physical-page",
      documentGeneration: 1, answer: answers[i + 1]! });
    previous = next;
  }
  expect(deltas).toHaveLength(5);
  expect(deltas[1]).toContain("I launched it manually");
  expect(deltas.slice(2).join(" ")).not.toContain("It restarted automatically");
  expect(previous.physicalContext.transferTokens).toBeLessThan(previous.physicalContext.logicalTokens);
});
