import { expect, test } from "bun:test";
import { createSetupCompletion } from "./completion";

test("failed login proof preserves the window; retry and concurrent finish close once", async () => {
  let proven = false, probes = 0, closed = 0, notices = 0;
  const exits: number[] = [];
  const completion = createSetupCompletion({
    verify: async () => { probes++; if (!proven) throw new Error("not logged in"); },
    close: async () => { closed++; }, exit: code => exits.push(code),
    needsLogin: async () => { notices++; },
  });
  await completion.finish();
  expect([probes, closed, notices]).toEqual([1, 0, 1]);
  expect(exits).toEqual([]);
  proven = true;
  await Promise.all([completion.finish(), completion.finish()]);
  await completion.finish();
  expect([probes, closed]).toEqual([2, 1]);
  expect(exits).toEqual([0]);
});

test("cancel closes only setup state and does not claim login success", async () => {
  const actions: string[] = [];
  const completion = createSetupCompletion({ verify: async () => { actions.push("verify"); },
    close: async () => { actions.push("close"); }, exit: code => { actions.push(`exit:${code}`); },
    needsLogin: async () => {},
  });
  await completion.cancel();
  await completion.finish();
  expect(actions).toEqual(["close", "exit:2"]);
});

test("synchronous window-close reentry shares the pending cancellation", async () => {
  let closes = 0;
  const exits: number[] = [];
  let completion: ReturnType<typeof createSetupCompletion>;
  completion = createSetupCompletion({
    verify: async () => { throw new Error("cancel must not verify"); },
    close: async () => {
      closes++;
      if (closes === 1) void completion.cancel();
    },
    exit: code => exits.push(code),
    needsLogin: async () => {},
  });
  await completion.cancel();
  expect(closes).toBe(1);
  expect(exits).toEqual([2]);
});
