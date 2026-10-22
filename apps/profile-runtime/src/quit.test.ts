import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import type { App, Event } from "electron";
import { bindBeforeQuitToStop } from "./quit";

test("before-quit drains the runtime once and permits the quit requested after cleanup", async () => {
  const app = new EventEmitter() as unknown as App;
  let resolveStop!: () => void;
  const pendingStop = new Promise<void>(resolve => { resolveStop = resolve; });
  let stopCalls = 0;
  const errors: unknown[] = [];
  let allowQuit!: () => void;
  allowQuit = bindBeforeQuitToStop(app, () => {
    stopCalls++;
    return pendingStop;
  }, error => errors.push(error));
  const requestQuit = () => {
    let prevented = false;
    app.emit("before-quit", { preventDefault() { prevented = true; } } as Event);
    return prevented;
  };

  expect(requestQuit()).toBe(true);
  expect(requestQuit()).toBe(true);
  expect(stopCalls).toBe(1);
  resolveStop();
  await pendingStop;
  allowQuit();
  expect(requestQuit()).toBe(false);
  expect(errors).toEqual([]);
});

test("a failed before-quit drain is reported and can be retried", async () => {
  const app = new EventEmitter() as unknown as App;
  const failure = new Error("normal quit refused");
  const errors: unknown[] = [];
  let stopCalls = 0;
  bindBeforeQuitToStop(app, async () => {
    stopCalls++;
    if (stopCalls === 1) throw failure;
  }, error => errors.push(error));
  const requestQuit = () => {
    let prevented = false;
    app.emit("before-quit", { preventDefault() { prevented = true; } } as Event);
    return prevented;
  };

  expect(requestQuit()).toBe(true);
  await Promise.resolve();
  expect(errors).toEqual([failure]);
  expect(requestQuit()).toBe(true);
  await Promise.resolve();
  expect(stopCalls).toBe(2);
  expect(errors).toEqual([failure]);
});
