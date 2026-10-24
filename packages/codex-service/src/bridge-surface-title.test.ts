import { describe, expect, test } from "bun:test";
import { nativeThreadDisplayTitle } from "./bridge-surface-title";

const threadId = "12345678-1234-4234-8234-123456789abc";

describe("Native bridge surface title", () => {
  test("uses the exact thread name and removes the Tela Agent prefix for display only", () => {
    expect(nativeThreadDisplayTitle({ thread: { id: threadId, name: "[Tela Agent] Review title" } }, threadId))
      .toBe("Review title");
  });

  test("returns no title for unknown or mismatched Native metadata", () => {
    expect(nativeThreadDisplayTitle(undefined, threadId)).toBeUndefined();
    expect(nativeThreadDisplayTitle({ thread: { id: "87654321-1234-4234-8234-123456789abc", name: "Wrong chat" } }, threadId))
      .toBeUndefined();
    expect(nativeThreadDisplayTitle({ thread: { id: threadId, name: "[Tela Agent] " } }, threadId)).toBeUndefined();
    expect(nativeThreadDisplayTitle({ thread: { id: threadId, preview: "Message preview, not a title" } }, threadId)).toBeUndefined();
    expect(nativeThreadDisplayTitle({ thread: { id: threadId, name: "Wrong chat" } }, "not-a-thread-id")).toBeUndefined();
  });
});
