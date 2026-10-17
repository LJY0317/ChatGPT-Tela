import { expect, test } from "bun:test";
import { authorFingerprint, resolveAssistantLineage, type TurnOwnership } from "./turn-ownership";
import type { ChatGptSurfaceSnapshot, ChatGptTurnObservation } from "./surface";

const user: ChatGptTurnObservation = { role: "user", key: "user:owned", contentFingerprint: "author-payload", lineageAnchor: "document/owned" };
const answer: ChatGptTurnObservation = { role: "assistant", key: "assistant:owned", parentUserTurnKey: user.key, lineageAnchor: user.lineageAnchor!, phase: "complete", text: "owned answer" };
const { contentFingerprint: _userProof, ...unavailableUser } = user;
const { lineageAnchor: _answerAnchor, ...unanchoredAnswer } = answer;
const owner = (): TurnOwnership => ({ userTurnKey: user.key, acceptedUserFingerprint: user.contentFingerprint!, acceptedLineageAnchor: user.lineageAnchor!,
  conversationRoute: "https://chatgpt.com/c/owned", baselineUserLineageKeys: new Set() });
const snapshot = (turns: readonly ChatGptTurnObservation[], url = "https://chatgpt.com/c/owned"): ChatGptSurfaceSnapshot => ({ revision: "fixture", url, turns, composers: [], sendControls: [] });

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
