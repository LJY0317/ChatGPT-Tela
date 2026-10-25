import { expect, test } from "bun:test";
import { diagnosticFingerprint, observeDiagnosticEvents, readDiagnosticTail, type StructuralDiagnosticEvent } from "@chatgpt-tela/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorFingerprint, resolveAssistantLineage, type TurnOwnership } from "./turn-ownership";
import type { ChatGptSurfaceSnapshot, ChatGptTurnObservation } from "./surface";

const user: ChatGptTurnObservation = { role: "user", key: "user:owned", contentFingerprint: "author-payload", lineageAnchor: "document/owned" };
const answer: ChatGptTurnObservation = { role: "assistant", key: "assistant:owned", parentUserTurnKey: user.key, lineageAnchor: user.lineageAnchor!, phase: "complete", text: "owned answer" };
const { contentFingerprint: _userProof, ...unavailableUser } = user;
const { lineageAnchor: _answerAnchor, ...unanchoredAnswer } = answer;
const owner = (): TurnOwnership => ({ userTurnKey: user.key, acceptedUserFingerprint: user.contentFingerprint!, acceptedLineageAnchor: user.lineageAnchor!,
  conversationRoute: "https://chatgpt.com/c/owned", baselineUserLineageKeys: new Set() });
const snapshot = (turns: readonly ChatGptTurnObservation[], url = "https://chatgpt.com/c/owned"): ChatGptSurfaceSnapshot => ({ revision: "fixture", url, turns, composers: [], sendControls: [] });

test("ownership rejection persists before/after input-state evidence without request text", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-request-changed-proof-"));
  const file = join(root, "events.jsonl"), previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  let state: "unchanged" | "changed" = "unchanged";
  const tracked: TurnOwnership = { ...owner(), causalReceipt: true, inputUnchanged: () => state === "unchanged",
    observationInputState: () => state, diagnosticLineage: {
      operation_fingerprint: diagnosticFingerprint("operation"), native_task_fingerprint: diagnosticFingerprint("task"),
      native_turn_fingerprint: diagnosticFingerprint("turn"), web_epoch_fingerprint: diagnosticFingerprint("epoch"),
      request_lineage_fingerprint: diagnosticFingerprint("lineage"),
      active_request_revision_fingerprint: diagnosticFingerprint("active-revision"),
      head_revision_fingerprint: diagnosticFingerprint("head-revision"), context_mode: "checkpoint-delta",
    } };
  const events: StructuralDiagnosticEvent[] = [];
  const stop = observeDiagnosticEvents(row => events.push(row));
  try {
    expect(resolveAssistantLineage(snapshot([user, answer]), tracked).assistants).toEqual([answer]);
    state = "changed";
    expect(() => resolveAssistantLineage(snapshot([{ ...user, contentFingerprint: "changed-private-body" }, answer]), tracked))
      .toThrow("accepted user identity changed");
    const rejected = events.find(row => row.stage === "web_turn_identity_rejected");
    expect(rejected).toMatchObject({ reason_class: "accepted_user_changed", comparison: "payload_changed_after_input_change",
      payload_state: "changed", rendered_payload_state: "changed", anchor_state: "matching", observation_input_state: "changed",
      operation_fingerprint: diagnosticFingerprint("operation"), request_lineage_fingerprint: diagnosticFingerprint("lineage"),
      active_request_revision_fingerprint: diagnosticFingerprint("active-revision"), context_mode: "checkpoint-delta" });
    const persisted = readDiagnosticTail(file);
    expect(persisted.state).toBe("read");
    expect(persisted.events).toContainEqual(expect.objectContaining({ stage: "web_turn_identity_rejected",
      reason_class: "accepted_user_changed", comparison: "payload_changed_after_input_change",
      observation_input_state: "changed", request_lineage_fingerprint: diagnosticFingerprint("lineage"),
      active_request_revision_fingerprint: diagnosticFingerprint("active-revision") }));
    expect(readFileSync(file, "utf8")).not.toContain("changed-private-body");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ownership rejection distinguishes a payload mismatch with unchanged or unavailable input evidence", () => {
  const events: StructuralDiagnosticEvent[] = [];
  const stop = observeDiagnosticEvents(row => events.push(row));
  try {
    const changedUser = { ...user, contentFingerprint: "different-private-body" };
    const unchangedInput: TurnOwnership = { ...owner(), inputUnchanged: () => true,
      observationInputState: () => "unchanged" };
    expect(() => resolveAssistantLineage(snapshot([changedUser, answer]), unchangedInput)).toThrow("accepted user identity changed");
    expect(events.find(row => row.stage === "web_turn_identity_rejected")).toMatchObject({
      comparison: "payload_changed_without_input_change", observation_input_state: "unchanged",
    });

    events.length = 0;
    expect(() => resolveAssistantLineage(snapshot([changedUser, answer]), owner())).toThrow("accepted user identity changed");
    expect(events.find(row => row.stage === "web_turn_identity_rejected")).toMatchObject({
      comparison: "payload_changed_with_unknown_input_state", observation_input_state: "unknown",
    });
    expect(JSON.stringify(events)).not.toContain("different-private-body");
  } finally { stop?.(); }
});

test("ownership witness correlates accepted lease and document/input/observation boundary changes without changing lineage", () => {
  const events: StructuralDiagnosticEvent[] = [];
  const stop = observeDiagnosticEvents(row => events.push(row));
  let boundary = { documentGeneration: 3, documentRevoked: false, inputRevision: 7, inputAvailable: true,
    inputRevoked: false, observationRevision: 4, observationPending: false, observationSource: "inspection_input" as const };
  const tracked: TurnOwnership = { ...owner(), diagnosticLeaseFingerprint: diagnosticFingerprint("lease"),
    acceptedDocumentGeneration: 3, acceptedInputRevision: 7, acceptedObservationRevision: 4,
    acceptedObservationSource: "inspection_input", diagnosticBoundary: () => boundary };
  try {
    expect(resolveAssistantLineage(snapshot([user, answer]), tracked).assistants).toEqual([answer]);
    boundary = { ...boundary, observationRevision: 5 };
    expect(resolveAssistantLineage(snapshot([user, answer]), tracked).assistants).toEqual([answer]);
    const observed = events.filter(row => row.stage === "web_turn_ownership_observed");
    expect(observed.at(-1)).toMatchObject({ lease_fingerprint: diagnosticFingerprint("lease"),
      accepted_document_generation: 3, document_generation: 3, document_generation_changed: false,
      accepted_input_revision: 7, input_revision: 7, input_revision_changed: false,
      accepted_observation_revision: 4, observation_revision: 5, observation_revision_changed: true,
      observation_source: "inspection_input", accepted_observation_source: "inspection_input" });
    boundary = { ...boundary, documentGeneration: 4, documentRevoked: true, inputAvailable: false, inputRevoked: true };
    expect(resolveAssistantLineage(snapshot([user, answer]), tracked).assistants).toEqual([answer]);
    expect(events.filter(row => row.stage === "web_turn_ownership_observed").at(-1)).toMatchObject({
      document_generation_changed: true, document_revoked: true, input_available: false, input_revoked: true,
    });
    // A long-lived request must retain its later transitions, while identical observations coalesce.
    for (let revision = 6; revision <= 75; revision++) {
      boundary = { ...boundary, observationRevision: revision };
      resolveAssistantLineage(snapshot([user, answer]), tracked);
    }
    const count = events.filter(row => row.stage === "web_turn_ownership_observed").length;
    resolveAssistantLineage(snapshot([user, answer]), tracked);
    expect(events.filter(row => row.stage === "web_turn_ownership_observed")).toHaveLength(count);
    expect(events.filter(row => row.stage === "web_turn_ownership_observed").at(-1)).toMatchObject({
      observation_revision: 75, witness_count: 73,
    });
  } finally { stop?.(); }
});

test("a proven viewing gesture preserves accepted causality across canonical hydration, pending or unknown input never does", () => {
  let state: "pending" | "unchanged" | "changed" = "pending";
  const tracked: TurnOwnership = { ...owner(), conversationRoute: "https://chatgpt.com/c/local-chatgpt:00000000-0000-4000-8000-000000000000",
    causalReceipt: true, inputUnchanged: () => false, observationInputState: () => state };
  const decorated = { ...user, contentFingerprint: "rendered-preview-not-full-composer" };
  expect(resolveAssistantLineage(snapshot([decorated, answer]), tracked)).toMatchObject({ identityPending: true, assistants: [] });
  state = "unchanged";
  // Rebind from the provisional route despite a strict fence revoked by viewing.
  expect(resolveAssistantLineage(snapshot([decorated, answer]), tracked).assistants).toEqual([answer]);
  expect(tracked.conversationRoute).toBe("https://chatgpt.com/c/owned");
  state = "changed";
  expect(() => resolveAssistantLineage(snapshot([decorated, answer]), tracked)).toThrow();
  expect(resolveAssistantLineage(snapshot([user, answer]), tracked).assistants).toEqual([answer]);
  expect(() => resolveAssistantLineage(snapshot([user, { ...answer, lineageAnchor: "foreign" }]), tracked)).toThrow();
});

function alternatives(values: string[]): ChatGptTurnObservation {
  return { ...unavailableUser, userPayloadReason: "ambiguous_author_root", candidateFingerprints: values,
    userPayloadStructure: { rootCount: 2, nestedRoots: true, equivalentRoots: false } };
}
test("exact expected endpoint plus causal identity survives wrapper decoration and endpoint order", () => {
  for (const values of [["decoration", "author-payload"], ["author-payload", "decoration"]]) {
    const observed = alternatives(values);
    expect(authorFingerprint(observed, "author-payload")).toBe("author-payload");
    const tracked = owner();
    expect(resolveAssistantLineage(snapshot([observed, answer]), tracked).assistants).toEqual([answer]);
    expect(resolveAssistantLineage(snapshot([unavailableUser, answer]), tracked).identityPending).toBe(true);
    expect(resolveAssistantLineage(snapshot([observed, answer]), tracked).assistants).toEqual([answer]);
    expect(() => resolveAssistantLineage(snapshot([observed, { ...user, key: "competing" }, answer]), tracked)).toThrow();
  }
});
test("alternatives never grant proof without exact expected content and logical chain evidence", () => {
  const valid = alternatives(["decoration", "author-payload"]);
  const { lineageAnchor: _anchor, ...withoutAnchor } = valid;
  for (const invalid of [
    withoutAnchor, { ...valid, role: "assistant" as const },
    { ...valid, candidateFingerprints: ["prefix-author-payload", "other"] },
    { ...valid, candidateFingerprints: ["author-payload", "author-payload"] },
    { ...valid, candidateFingerprints: ["author-payload"] },
    { ...valid, userPayloadStructure: { rootCount: 2, nestedRoots: false, equivalentRoots: false } },
    { ...valid, userPayloadStructure: { rootCount: 65, nestedRoots: true, equivalentRoots: false } },
  ]) expect(authorFingerprint(invalid, "author-payload")).toBeUndefined();
  expect(authorFingerprint(valid, "edited-author-payload")).toBeUndefined();
  expect(() => resolveAssistantLineage(snapshot([{ ...valid, lineageAnchor: "foreign-document" }, answer]), owner())).toThrow();
  expect(resolveAssistantLineage(snapshot([valid, answer], "https://chatgpt.com/c/foreign"), owner()))
    .toMatchObject({ identityPending: true, assistants: [] });
});

test("unavailable author projection blocks delivery and recovers without retiring ownership", () => {
  const tracked = owner();
  expect(resolveAssistantLineage(snapshot([unavailableUser, answer]), tracked)).toMatchObject({ identityPending: true, assistants: [] });
  expect(resolveAssistantLineage(snapshot([user, answer]), tracked).assistants).toEqual([answer]);
  expect(tracked.userTurnKey).toBe(user.key);
});
test("unmounted user requires the same document-scoped logical answer anchor", () => {
  expect(resolveAssistantLineage(snapshot([answer]), owner()).assistants).toEqual([answer]);
  expect(resolveAssistantLineage(snapshot([{ ...answer, lineageAnchor: "replacement-document" }]), owner())).toMatchObject({ identityPending: true, assistants: [] });
});
test("missing accepted author never promotes a completed unanchored assistant", () => {
  const tracked = owner();
  const completed = { ...unanchoredAnswer, phase: "complete" as const };
  const observed = snapshot([completed]);
  expect(resolveAssistantLineage(observed, tracked)).toMatchObject({ identityPending: true, assistants: [] });
  expect(resolveAssistantLineage(snapshot([user, completed]), tracked).assistants).toEqual([completed]);
});
test("old baseline users do not turn an unmounted accepted user into a conflict", () => {
  const tracked = { ...owner(), baselineUserLineageKeys: new Set(["user:old"]) };
  expect(resolveAssistantLineage(snapshot([{ ...user, key: "user:old" }, unanchoredAnswer]), tracked))
    .toMatchObject({ identityPending: true, assistants: [] });
});
test("a new competing user cannot borrow the still-visible owned answer", () => {
  expect(() => resolveAssistantLineage(snapshot([user, { ...user, key: "user:foreign", contentFingerprint: "other" }, answer]), owner()))
    .toThrow("another user turn");
});
test.each(["payload", "anchor", "duplicate", "route"])("positive conflicting evidence fails closed: %s", kind => {
  const changed = kind === "payload" ? { ...user, contentFingerprint: "foreign" } : kind === "anchor" ? { ...user, lineageAnchor: "foreign" } : user;
  const resolve = () => resolveAssistantLineage(snapshot(kind === "duplicate" ? [user, user, answer] : [changed, answer],
    kind === "route" ? "https://chatgpt.com/c/foreign" : undefined), owner());
  if (kind === "route") expect(resolve()).toMatchObject({ identityPending: true, assistants: [] });
  else expect(resolve).toThrow(/identity|conversation/);
});
test("canonical hydration cannot promote unavailable payload, and commits only after proof returns", () => {
  const tracked = owner(); tracked.conversationRoute = "https://chatgpt.com/";
  expect(resolveAssistantLineage(snapshot([unavailableUser, answer]), tracked)).toMatchObject({ identityPending: true });
  expect(tracked.conversationRoute).toBe("https://chatgpt.com/");
  expect(resolveAssistantLineage(snapshot([user, answer]), tracked).assistants).toEqual([answer]);
  expect(tracked.conversationRoute).toBe("https://chatgpt.com/c/owned");
});
test("a different conversation suspends observation and return requires fresh author proof", () => {
  const tracked = owner();
  expect(resolveAssistantLineage(snapshot([user, answer], "https://chatgpt.com/c/other"), tracked))
    .toMatchObject({ identityPending: true, assistants: [] });
  expect(tracked.navigationSuspended).toBe(true);
  expect(resolveAssistantLineage(snapshot([unavailableUser, answer]), tracked))
    .toMatchObject({ identityPending: true, assistants: [] });
  expect(tracked.navigationSuspended).toBe(true);
  expect(resolveAssistantLineage(snapshot([user, answer]), tracked).assistants).toEqual([answer]);
  expect(tracked.navigationSuspended).toBe(false);
});
test("after outside input, a causal receipt cannot reuse an opaque or edited author", () => {
  let unchanged = true;
  const tracked = { ...owner(), causalReceipt: true, inputUnchanged: () => unchanged };
  const decorated = { ...user, contentFingerprint: "different presentation" };
  expect(resolveAssistantLineage(snapshot([decorated, answer]), tracked).assistants).toEqual([answer]);
  unchanged = false;
  expect(() => resolveAssistantLineage(snapshot([decorated, answer]), tracked)).toThrow("identity changed");
  expect(resolveAssistantLineage(snapshot([unavailableUser, answer]), tracked))
    .toMatchObject({ identityPending: true, assistants: [] });
  expect(resolveAssistantLineage(snapshot([user, answer]), tracked).assistants).toEqual([answer]);
});
