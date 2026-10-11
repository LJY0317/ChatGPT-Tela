import { expect, test } from "bun:test";
import { ChatGptApprovalObservation } from "./approval-observation";

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
  expect(observation.audit).toEqual({ approval_count: 1, dispatch_count: 1, input_receipt_count: 1,
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

test("late input evidence does not rewind cleared-card lifecycle or count disappearance twice", () => {
  const observation = new ChatGptApprovalObservation();
  observation.observe(card, "body", true, 0); observation.dispatched(card.cardFingerprint, 1);
  observation.observe(undefined, "body", true, 2);
  expect(observation.recordInputReceipt({ cardFingerprint: card.cardFingerprint,
    revisionFingerprint: card.revisionFingerprint }, 3)?.phase).toBe("input_received");
  expect(observation.phase).toBe("card_cleared");
  expect(observation.observe(undefined, "body", true, 4)).toBeUndefined();
  expect(observation.audit).toMatchObject({ input_receipt_count: 1, card_clear_count: 1 });
});
