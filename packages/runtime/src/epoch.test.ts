import { describe, expect, test } from "bun:test";
import { WebEpochRegistry } from "./epoch";

describe("Web conversation epochs", () => {
  test("fresh Web chats preserve Native task identity while advancing an independent epoch", () => {
    const epochs = new WebEpochRegistry();
    const first = epochs.start("native-task-1", "r1");
    const second = epochs.rollover("native-task-1", "r20", "compaction");

    expect(first.nativeTaskId).toBe("native-task-1");
    expect(second.nativeTaskId).toBe("native-task-1");
    expect(second.id).not.toBe(first.id);
    expect(second.generation).toBe(2);
    expect(second.baseRevisionId).toBe("r20");
    expect(second.reason).toBe("compaction");
    expect(epochs.current("native-task-1")).toBe(second);
  });

  test("one task cannot accidentally own two current Web epochs", () => {
    const epochs = new WebEpochRegistry();
    epochs.start("native-task-1", "r1");
    expect(() => epochs.start("native-task-1", "r2")).toThrow("already has an active Web epoch");
  });
});
