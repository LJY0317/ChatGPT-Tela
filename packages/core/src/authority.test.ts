import { expect, test } from "bun:test";
import { defineNativeTurnAuthority } from "./authority";

test("native authority is explicitly current-turn sourced", () => {
  const authority = defineNativeTurnAuthority({
    threadId: "thread-1",
    turnId: "turn-1",
    cwd: "/workspace",
    workspaceRoots: ["/workspace"],
    sandbox: { kind: "workspace-write", writableRoots: ["/workspace"], network: "restricted" },
  });

  expect(authority.source).toBe("native-current-turn");
  expect(authority.turnId).toBe("turn-1");
});
