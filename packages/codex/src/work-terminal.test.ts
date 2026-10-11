import { expect, test } from "bun:test";
import { workTerminalArguments } from "./work-terminal";
import { parseCodexTerminalSessionContract } from "@chatgpt-tela/service-protocol";

const session = { contractVersion: 1, slot: 2, endpoint: "ws://127.0.0.1:32123/" };
test("remote resume keeps model choice and workspace as literal official CLI arguments", () => {
  expect(workTerminalArguments({ session, threadId: "fixture-thread", model: "web/family", cwd: "/tmp/a b" }))
    .toEqual(["--remote", session.endpoint, "--model", "web/family", "--cd", "/tmp/a b", "resume", "fixture-thread"]);
  expect(workTerminalArguments({ session })).toEqual(["--remote", session.endpoint]);
});
test("terminal rejects foreign or credential-bearing endpoints and option-like thread identities", () => {
  for (const endpoint of ["ws://example.com:1234/", "ws://user:secret@127.0.0.1:1234/", "ws://127.0.0.1:1234/?token=x", "http://127.0.0.1:1234/"]) {
    expect(() => parseCodexTerminalSessionContract({ ...session, endpoint })).toThrow();
  }
  for (const threadId of ["--last", "two threads", ""]) {
    expect(() => workTerminalArguments({ session, threadId })).toThrow();
  }
});
