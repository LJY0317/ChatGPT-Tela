import { expect, test } from "bun:test";
import { resolveAssistantLineage, type TurnOwnership } from "./turn-ownership";
import type { ChatGptSurfaceSnapshot, ChatGptTurnObservation } from "./surface";

const user: ChatGptTurnObservation = { role: "user", key: "user:owned", contentFingerprint: "author-payload", lineageAnchor: "document/owned" };
const answer: ChatGptTurnObservation = { role: "assistant", key: "assistant:owned", parentUserTurnKey: user.key, lineageAnchor: user.lineageAnchor!, phase: "complete", text: "owned answer" };
const { contentFingerprint: _userProof, ...unavailableUser } = user;
const { lineageAnchor: _answerAnchor, ...unanchoredAnswer } = answer;
const owner = (): TurnOwnership => ({ userTurnKey: user.key, acceptedUserFingerprint: user.contentFingerprint!, acceptedLineageAnchor: user.lineageAnchor!,
  conversationRoute: "https://chatgpt.com/c/owned", baselineUserLineageKeys: new Set() });
const snapshot = (turns: readonly ChatGptTurnObservation[], url = "https://chatgpt.com/c/owned"): ChatGptSurfaceSnapshot => ({ revision: "fixture", url, turns, composers: [], sendControls: [] });

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
  expect(() => resolveAssistantLineage(snapshot(kind === "duplicate" ? [user, user, answer] : [changed, answer],
    kind === "route" ? "https://chatgpt.com/c/foreign" : undefined), owner())).toThrow(/identity|conversation/);
});
test("canonical hydration cannot promote unavailable payload, and commits only after proof returns", () => {
  const tracked = owner(); tracked.conversationRoute = "https://chatgpt.com/";
  expect(resolveAssistantLineage(snapshot([unavailableUser, answer]), tracked)).toMatchObject({ identityPending: true });
  expect(tracked.conversationRoute).toBe("https://chatgpt.com/");
  expect(resolveAssistantLineage(snapshot([user, answer]), tracked).assistants).toEqual([answer]);
  expect(tracked.conversationRoute).toBe("https://chatgpt.com/c/owned");
});
