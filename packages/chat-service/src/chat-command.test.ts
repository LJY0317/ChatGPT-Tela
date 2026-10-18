import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createChatToolRuntime } from "./tools";
import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";

const removeFixture = registerTemporaryFixtureCleanup();

test("Chat command accepts multiline scripts and preserves idempotent execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-chat-command-"));
  const runtime = createChatToolRuntime({ allowedRoots: [root], stateRoot: join(root, "state") });
  try {
    const workspace = await runtime.call("open_workspace", { path: root }) as { id: string };
    const operationId = randomUUID();
    const cmd = process.platform === "win32"
      ? "echo first>>result.txt\r\necho second>>result.txt"
      : "cat >> result.txt <<'LINES'\nfirst\nsecond\nLINES\nprintf complete";
    const input = { workspace_id: workspace.id, operation_id: operationId, cmd, yield_time_ms: 1000 };
    let result = await runtime.call("exec_command", input) as { state: string; sessionId: number; exitCode?: number };
    const deadline = Date.now() + 15_000;
    while (result.state === "running") {
      expect(Date.now()).toBeLessThan(deadline);
      result = await runtime.call("write_stdin", { workspace_id: workspace.id, session_id: result.sessionId,
        yield_time_ms: 1000 }) as typeof result;
    }
    expect(result.state).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "result.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("first\nsecond\n");
    const replay = await runtime.call("exec_command", input) as typeof result;
    expect(replay.sessionId).toBe(result.sessionId);
    expect(readFileSync(join(root, "result.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("first\nsecond\n");
    const status = await runtime.call("process_status", { workspace_id: workspace.id, operation_id: operationId }) as typeof result;
    expect(status.state).toBe("exited");
    for (const invalid of ["\u0000", "x".repeat(64 * 1024 + 1)]) {
      await expect(runtime.call("exec_command", { workspace_id: workspace.id, cmd: invalid })).rejects.toThrow();
    }
  } finally {
    await runtime.close();
    removeFixture(root);
  }
});
