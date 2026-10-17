import { expect, test } from "bun:test";
import { ChatGptApprovalObservation, approvalObservationSummary, overdueHumanApprovalSummary, nextApprovalWaitWakeMs } from "./approval-observation";

test("review warnings project as fixed public progress, never as a copied card prompt", () => {
  expect(approvalObservationSummary("pending", "tool_description_policy_directive"))
    .toContain("tool-description instructions");
  expect(approvalObservationSummary("pending", "provider_warning")).toContain("Manual security review");
  expect(approvalObservationSummary("pending")).toBe("Approval needed in the Web browser.");
});

test("approval waiting has exact 30s, 2m, 5m and 10m program milestones", () => {
  const observation = new ChatGptApprovalObservation();
  expect(observation.pendingElapsedMs(0)).toBeUndefined();
  const card = { cardCount: 1, denyCount: 1, allowCount: 0, allowOnceCount: 1,
    alwaysAllowCount: 0, unknownCount: 0, revisionFingerprint: "test-proof",
    cardFingerprint: "a".repeat(24), inputReceived: false };
  observation.observe(card, "same-assistant", true, 1_000);
  expect(observation.pendingElapsedMs(1_000)).toBe(0);
  expect(overdueHumanApprovalSummary(observation.pendingElapsedMs(30_999))).toBeUndefined();
  expect(overdueHumanApprovalSummary(observation.pendingElapsedMs(31_000))).toContain("thirty seconds");
  expect(nextApprovalWaitWakeMs(observation.pendingElapsedMs(30_999))).toBe(1);
  expect(nextApprovalWaitWakeMs(observation.pendingElapsedMs(31_000))).toBe(90_000);
  expect(overdueHumanApprovalSummary(observation.pendingElapsedMs(121_000))).toContain("after two minutes");
  expect(overdueHumanApprovalSummary(observation.pendingElapsedMs(301_000))).toContain("rechecking");
  expect(nextApprovalWaitWakeMs(observation.pendingElapsedMs(301_000))).toBe(300_000);
  expect(nextApprovalWaitWakeMs(observation.pendingElapsedMs(600_999))).toBe(1);
  expect(nextApprovalWaitWakeMs(observation.pendingElapsedMs(601_000))).toBe(0);
  expect(observation.phase).toBe("pending");
  expect(observation.audit).toMatchObject({ dispatch_count: 0, verified_success_count: 0 });
  observation.observe(undefined, "same-assistant", true, 905_000);
  expect(observation.pendingElapsedMs(906_000)).toBeUndefined();
  expect(overdueHumanApprovalSummary(Infinity)).toBeUndefined();
});

const card = { cardCount: 1, denyCount: 1, allowCount: 0, allowOnceCount: 1, alwaysAllowCount: 0,
  unknownCount: 0, revisionFingerprint: "proof-a", cardFingerprint: "a".repeat(24), inputReceived: false };

test("input dispatch, trusted receipt, card disappearance and substantive progress are separate observations", () => {
  const observation = new ChatGptApprovalObservation();
  expect(observation.observe(card, "body-1", true, 10)?.phase).toBe("pending");
  expect(observation.dispatched(card.cardFingerprint, 20)?.phase).toBe("dispatch_sent");
  expect(observation.observe(card, "body-1", true, 60_000)).toBeUndefined();
  expect(observation.observe({ ...card, inputReceived: true }, "body-1", true, 60_010)?.phase).toBe("input_received");
  expect(observation.observe(undefined, "body-1", true, 60_020)?.phase).toBe("card_cleared");
  // A healthy observation or timer does not establish task progress.
  expect(observation.observe(undefined, "body-1", true, 600_000)).toBeUndefined();
  expect(observation.observe(undefined, "body-2", true, 600_010)?.phase).toBe("task_progress");
  expect(observation.observe(undefined, "body-2", true, 600_020)).toBeUndefined();
});

test("a reappearing pending card never loses its once-dispatch record", () => {
  const observation = new ChatGptApprovalObservation();
  observation.observe(card, "body-1", true, 0);
  observation.dispatched(card.cardFingerprint, 1);
  observation.observe(undefined, "body-1", true, 2);
  const second = { ...card, cardFingerprint: "b".repeat(24), revisionFingerprint: "proof-b" };
  expect(observation.observe(second, "body-1", true, 3)?.phase).toBe("pending");
  expect(observation.wasDispatched(second.cardFingerprint)).toBe(false);
  observation.dispatched(second.cardFingerprint, 4);
  expect(observation.observe(card, "body-1", true, 5)?.phase).toBe("dispatch_sent");
  expect(observation.wasDispatched(card.cardFingerprint)).toBe(true);
  expect(observation.phase).not.toBe("task_progress");
});

test("manual dismissal and failed task content do not prove approval acceptance or resumption", () => {
  const observation = new ChatGptApprovalObservation();
  observation.observe(card, "body-1", true, 0);
  expect(observation.observe(undefined, "failure-body", false, 1)?.phase).toBe("card_cleared");
  expect(observation.observe(undefined, "failure-body", false, 2)).toBeUndefined();
  expect(observation.wasDispatched(card.cardFingerprint)).toBe(false);
});

test("dispatch cannot be attributed to a different observed request", () => {
  const observation = new ChatGptApprovalObservation();
  observation.observe(card, "body-1", true, 0);
  expect(() => observation.dispatched("b".repeat(24), 1)).toThrow("different observed card");
  expect(observation.phase).toBe("pending");
});


test("cleared approval and generated progress do not count as local execution evidence", () => {
  const observation = new ChatGptApprovalObservation();
  observation.observe(card, "before", true, 0);
  observation.dispatched(card.cardFingerprint, 1);
  observation.observe({ ...card, inputReceived: true }, "before", true, 2);
  observation.observe(undefined, "before", true, 3);
  observation.observe(undefined, "refusal prose", true, 4);
  expect(observation.audit).toEqual({ approval_count: 1, dispatch_count: 1,
    verified_success_count: 1, unverified_dispatch_count: 0, input_receipt_count: 1,
    card_clear_count: 1, native_result_count: 0 });
  observation.recordNativeResult();
  expect(observation.audit.native_result_count).toBe(1);
  expect(Object.values(observation.audit).every(value => typeof value === "number")).toBe(true);
});

test("detached trusted receipt survives immediate card removal once, without granting decision authority", () => {
  const observation = new ChatGptApprovalObservation();
  observation.observe(card, "body", true, 0);
  observation.dispatched(card.cardFingerprint, 1);
  const receipt = { cardFingerprint: card.cardFingerprint, revisionFingerprint: card.revisionFingerprint };
  expect(observation.recordInputReceipt({ ...receipt, cardFingerprint: "foreign" }, 2)).toBeUndefined();
  expect(observation.recordInputReceipt({ ...receipt, revisionFingerprint: "changed" }, 2)).toBeUndefined();
  expect(observation.recordInputReceipt(receipt, 2)?.phase).toBe("input_received");
  expect(observation.observe(undefined, "body", true, 3)?.phase).toBe("card_cleared");
  expect(observation.recordInputReceipt(receipt, 4)).toBeUndefined();
  expect(observation.audit).toMatchObject({ input_receipt_count: 1, native_result_count: 0 });
  const otherTurn = new ChatGptApprovalObservation();
  expect(otherTurn.recordInputReceipt(receipt, 4)).toBeUndefined();
  expect(otherTurn.audit.input_receipt_count).toBe(0);
});
test("after an owned approval dropdown rotates proof, only the prepared-choice receipt releases the success budget", () => {
  const observation = new ChatGptApprovalObservation();
  observation.observe(card, "before", true, 10);
  const newRevision = "scoped-menu-choice-proof";
  observation.dispatched(card.cardFingerprint, 20, newRevision);
  expect(observation.recordInputReceipt({
    cardFingerprint: card.cardFingerprint, revisionFingerprint: card.revisionFingerprint,
  }, 21)).toBeUndefined();
  expect(observation.audit.unverified_dispatch_count).toBe(1);
  expect(observation.recordInputReceipt({
    cardFingerprint: card.cardFingerprint, revisionFingerprint: newRevision,
  }, 22)?.phase).toBe("input_received");
  observation.observe(undefined, "before", true, 23);
  expect(observation.audit.unverified_dispatch_count).toBe(1);
  observation.observe(undefined, "after", true, 24);
  expect(observation.audit).toMatchObject({
    verified_success_count: 1, unverified_dispatch_count: 0,
  });
  const invalid = new ChatGptApprovalObservation();
  invalid.observe(card, "start", true, 1);
  expect(() => invalid.dispatched(card.cardFingerprint, 2, "")).toThrow("invalid approval dispatch revision");
});

test("late input evidence does not rewind cleared-card lifecycle or count disappearance twice", () => {
  const observation = new ChatGptApprovalObservation();
  observation.observe(card, "body", true, 0); observation.dispatched(card.cardFingerprint, 1);
  observation.observe(undefined, "body", true, 2);
  expect(observation.recordInputReceipt({ cardFingerprint: card.cardFingerprint,
    revisionFingerprint: card.revisionFingerprint }, 3)?.phase).toBe("input_received");
  expect(observation.phase).toBe("card_cleared");
  expect(observation.observe(undefined, "body", true, 4)).toBeUndefined();
  expect(observation.audit).toMatchObject({ input_receipt_count: 1, card_clear_count: 1 });
  expect(observation.audit).toMatchObject({ verified_success_count: 0, unverified_dispatch_count: 1 });
});
test("only trusted input plus clearance plus new assistant progress releases an approval budget slot", () => {
  const observation = new ChatGptApprovalObservation();
  for (let index = 0; index < 18; index++) {
    const c = { ...card, cardFingerprint: String(index).padStart(24, "x"),
      revisionFingerprint: "revision-" + index };
    observation.observe(c, "body-start-" + index, true, index * 100);
    observation.dispatched(c.cardFingerprint, index * 100 + 1);
    expect(observation.unverifiedDispatchCount).toBe(1);
    observation.observe({ ...c, inputReceived: true }, "body-start-" + index, true, index * 100 + 2);
    observation.observe(undefined, "body-start-" + index, true, index * 100 + 3);
    expect(observation.unverifiedDispatchCount).toBe(1);
    observation.observe(undefined, "body-next-" + index, true, index * 100 + 4);
    expect(observation.unverifiedDispatchCount).toBe(0);
  }
  expect(observation.audit).toMatchObject({
    dispatch_count: 18, verified_success_count: 18, unverified_dispatch_count: 0,
    card_clear_count: 18, input_receipt_count: 18,
  });
});
test("a vanished card, failed assistant, duplicate receipt or late evidence never masquerades as verified success", () => {
  const observation = new ChatGptApprovalObservation();
  observation.observe(card, "a", true, 0);
  observation.dispatched(card.cardFingerprint, 1);
  observation.observe(undefined, "a", false, 2);
  observation.observe(undefined, "failed", false, 3);
  expect(observation.unverifiedDispatchCount).toBe(1);
  observation.recordNativeResult(); // Turn-level outcome does not prove this card was accepted.
  expect(observation.unverifiedDispatchCount).toBe(1);
  observation.recordInputReceipt({ cardFingerprint: card.cardFingerprint, revisionFingerprint: "incorrect" }, 4);
  expect(observation.unverifiedDispatchCount).toBe(1);
});


test("direct card replacement needs trusted receipt and changed owned assistant to verify the prior approval", () => {
  for (const receipt of [false, true]) for (const progress of [false, true]) {
    const observation = new ChatGptApprovalObservation();
    observation.observe(card, "before", true, 0);
    observation.dispatched(card.cardFingerprint, 1);
    if (receipt) observation.recordInputReceipt({ cardFingerprint: card.cardFingerprint,
      revisionFingerprint: card.revisionFingerprint }, 2);
    observation.observe({ ...card, cardFingerprint: "b".repeat(24), revisionFingerprint: "proof-b" },
      progress ? "after" : "before", true, 3);
    expect(observation.audit.verified_success_count).toBe(receipt && progress ? 1 : 0);
  }
});

test("an ambiguous multi-card snapshot cannot establish the previous card's clearance", () => {
  const observation = new ChatGptApprovalObservation();
  observation.observe(card, "before", true, 0);
  observation.dispatched(card.cardFingerprint, 1);
  observation.recordInputReceipt({ cardFingerprint: card.cardFingerprint, revisionFingerprint: card.revisionFingerprint }, 2);
  const { cardFingerprint: _fingerprint, ...ambiguous } = card;
  observation.observe({ ...ambiguous, cardCount: 2, revisionFingerprint: "ambiguous-two" }, "after", true, 3);
  expect(observation.audit).toMatchObject({ verified_success_count: 0, card_clear_count: 0 });
});


test("unresolved card replacement carries its deadline while verified approval starts a fresh episode", () => {
  for (const trustedInput of [false, true]) {
    const observation = new ChatGptApprovalObservation();
    observation.observe(card, "before", true, 1_000);
    observation.dispatched(card.cardFingerprint, 2_000);
    if (trustedInput) observation.recordInputReceipt({ cardFingerprint: card.cardFingerprint,
      revisionFingerprint: card.revisionFingerprint }, 3_000);
    const second = { ...card, cardFingerprint: "b".repeat(24), revisionFingerprint: "proof-b" };
    observation.observe(second, trustedInput ? "after" : "before", true, 541_000);
    expect(observation.pendingElapsedMs(541_000)).toBe(trustedInput ? 0 : 540_000);
    expect(nextApprovalWaitWakeMs(observation.pendingElapsedMs(601_000))).toBe(trustedInput ? 60_000 : 0);
    expect(observation.wasDispatched(card.cardFingerprint)).toBe(true);
  }
});

test("manual clearance and owned progress end the wait episode; hiding alone does not", () => {
  for (const progress of [false, true]) {
    const observation = new ChatGptApprovalObservation();
    observation.observe(card, "before", true, 1_000);
    observation.observe(undefined, "before", true, 200_000);
    if (progress) observation.observe(undefined, "after", true, 201_000);
    observation.observe({ ...card, cardFingerprint: "b".repeat(24), revisionFingerprint: "proof-b" },
      progress ? "after" : "before", true, 541_000);
    expect(observation.pendingElapsedMs(601_000)).toBe(progress ? 60_000 : 600_000);
  }
});


test("the same hidden and reappearing card retains its original age and dispatch fence", () => {
  const observation = new ChatGptApprovalObservation();
  observation.observe(card, "before", true, 1_000);
  observation.dispatched(card.cardFingerprint, 2_000);
  observation.observe(undefined, "before", true, 500_000);
  observation.observe(card, "before", true, 541_000);
  expect(observation.pendingElapsedMs(601_000)).toBe(600_000);
  expect(observation.wasDispatched(card.cardFingerprint)).toBe(true);
});
