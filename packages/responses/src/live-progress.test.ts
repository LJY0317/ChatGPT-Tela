import { expect, test } from "bun:test";
import type { NativeResponsesGateway } from "@chatgpt-tela/runtime";
import { NativeProgressStream } from "./live-progress";

test("an active idle stream emits protocol liveness without fabricating model text or committing a result", async () => {
  const stream = new NativeProgressStream("fixture-model", 0, 5);
  stream.progress("Preparing conversation context (1/5).");
  const reader = stream.response().body!.getReader(), decoder = new TextDecoder();
  for (let i = 0; i < 6; i++) await reader.read();
  const idle = decoder.decode((await reader.read()).value);
  expect(idle).toContain("event: response.in_progress");
  expect(idle).not.toContain("reasoning_summary"); expect(idle).not.toContain("delta");
  let commits = 0;
  stream.finish({ type: "final", answer: "real result", delivery: { capability: "fixture" } },
    { commit() { commits++; } } as unknown as NativeResponsesGateway);
  expect(commits).toBe(0);
  let text = "";
  for (;;) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value); }
  expect(text).toContain("real result"); expect(commits).toBe(1);
});

test("cancelling a waiting stream settles its reader and removes its active idle wait", async () => {
  const stream = new NativeProgressStream("fixture-model", 0, 10);
  stream.progress("preparing");
  const reader = stream.response().body!.getReader();
  for (let i = 0; i < 6; i++) await reader.read();
  const pending = reader.read(); await reader.cancel();
  expect((await pending).done).toBe(true); expect(stream.signal.signal.aborted).toBe(true);
  expect((await reader.read()).done).toBe(true);
});
