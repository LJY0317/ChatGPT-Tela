import { expect, test } from "bun:test";
import { diagnosticFingerprint, observeDiagnosticEvents } from "@chatgpt-tela/core";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitOfficialWebDelegation } from "./official-web-delegation";

function fixture(exitsAfterAck: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "tela-official-web-"));
  const executable = join(directory, "app-server");
  writeFileSync(executable, `#!/usr/bin/env bun
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    const message = JSON.parse(line);
    if (message.id == null) continue;
    if (message.method === "thread/start") send({ id: message.id, result: {
      model: message.params.model, thread: { id: "chat", modelProvider: "openai" },
    } });
    else if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "turn", status: "inProgress" } } });
      if (${exitsAfterAck}) setTimeout(() => process.exit(0), 30);
      else setTimeout(() => send({ method: "turn/completed", params: {
        threadId: "chat", turn: { id: "turn", status: "completed" },
      } }), 120);
    } else if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} });
      send({ method: "turn/completed", params: {
        threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted" },
      } });
    } else if (message.method === "thread/items/list") send({ id: message.id, result: {
      data: [{ turnId: "turn", item: { id: "answer", type: "agentMessage",
        phase: "final_answer", text: "Done" } }], nextCursor: null,
    } });
    else send({ id: message.id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
`);
  chmodSync(executable, 0o700);
  return { executable, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test("official ACK releases the caller while the service still owns completion", async () => {
  const fake = fixture(false);
  try {
    let registered = false;
    const task = submitOfficialWebDelegation({ executable: fake.executable, codexHome: tmpdir(), cwd: tmpdir(),
      model: "chatgpt-tela-web/family/123", title: "[Tela Agent] Test", prompt: "Test",
      beforeSubmit: async () => { registered = true; },
    });
    const receipt = await task.accepted;
    expect(registered).toBe(true);
    expect(receipt).toEqual({ threadId: "chat", turnId: "turn", model: "chatgpt-tela-web/family/123", status: "accepted" });
    expect(await task.finished).toMatchObject({ threadId: "chat", turnId: "turn", status: "completed", itemId: "answer", answer: "Done" });
  } finally { fake.dispose(); }
});

test("stdout closing after ACK fails completion without revoking the accepted turn identity", async () => {
  const fake = fixture(true);
  const events: unknown[] = [];
  const unobserve = observeDiagnosticEvents(event => {
    if (event.stage === "web_delegation_completion_unconfirmed") events.push(event);
  });
  try {
    const task = submitOfficialWebDelegation({ executable: fake.executable, codexHome: tmpdir(), cwd: tmpdir(),
      model: "chatgpt-tela-web/family/123", title: "[Tela Agent] Test", prompt: "Test",
    });
    expect(await task.accepted).toMatchObject({ threadId: "chat", turnId: "turn", status: "accepted" });
    await expect(task.finished).rejects.toThrow("completion could not be confirmed");
    expect(events).toEqual([expect.objectContaining({
      scope_fingerprint: diagnosticFingerprint("chat"), turn_fingerprint: diagnosticFingerprint("turn"),
      reason_class: "official_process_closed", exit_code: 0, interrupt_requested: false,
    })]);
  } finally { unobserve?.(); fake.dispose(); }
});

test("explicit interruption uses the accepted turn identity on the owning connection", async () => {
  const fake = fixture(false);
  const events: unknown[] = [];
  const unobserve = observeDiagnosticEvents(event => {
    if (event.stage === "web_delegation_turn_incomplete") events.push(event);
  });
  try {
    const task = submitOfficialWebDelegation({ executable: fake.executable, codexHome: tmpdir(), cwd: tmpdir(),
      model: "chatgpt-tela-web/family/123", title: "[Tela Agent] Test", prompt: "Test",
    });
    const receipt = await task.accepted;
    expect(await task.interrupt()).toEqual({});
    expect(await task.finished).toMatchObject({ threadId: receipt.threadId, turnId: receipt.turnId, status: "interrupted" });
    expect(events).toEqual([expect.objectContaining({
      scope_fingerprint: diagnosticFingerprint("chat"), turn_fingerprint: diagnosticFingerprint("turn"),
      outcome: "interrupted", interrupt_requested: true,
    })]);
  } finally { unobserve?.(); fake.dispose(); }
});

test("ACK receipt waits for its one retention handoff without resubmitting", async () => {
  const fake = fixture(false);
  const entered = Promise.withResolvers<void>();
  const registered = Promise.withResolvers<void>();
  try {
    let preSubmit = 0;
    let handoffs = 0;
    let delivered = false;
    const task = submitOfficialWebDelegation({ executable: fake.executable, codexHome: tmpdir(), cwd: tmpdir(),
      model: "chatgpt-tela-web/family/123", title: "[Tela Agent] Test", prompt: "Test",
      beforeSubmit: async () => { preSubmit++; },
      onAccepted: async () => { handoffs++; entered.resolve(); await registered.promise; },
    });
    void task.accepted.then(() => { delivered = true; });
    await entered.promise;
    expect(preSubmit).toBe(1);
    expect(handoffs).toBe(1);
    expect(delivered).toBe(false);
    registered.resolve();
    expect(await task.accepted).toMatchObject({ threadId: "chat", turnId: "turn", status: "accepted" });
    expect(await task.finished).toMatchObject({ status: "completed" });
    expect(preSubmit).toBe(1);
    expect(handoffs).toBe(1);
  } finally { registered.resolve(); fake.dispose(); }
});

test("failed post-ACK handoff preserves the original turn through completion", async () => {
  const fake = fixture(false);
  try {
    const task = submitOfficialWebDelegation({ executable: fake.executable, codexHome: tmpdir(), cwd: tmpdir(),
      model: "chatgpt-tela-web/family/123", title: "[Tela Agent] Test", prompt: "Test",
      onAccepted: async () => { throw Error("Retention handoff failed"); },
    });
    await expect(task.accepted).rejects.toThrow("Retention handoff failed");
    expect(await task.finished).toMatchObject({ threadId: "chat", turnId: "turn", status: "completed" });
  } finally { fake.dispose(); }
});
