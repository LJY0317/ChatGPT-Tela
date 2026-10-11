import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { waitForChatShutdown } from "./shutdown";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("signal refusal retains listeners and waits for a later explicit shutdown", async () => {
  const signals = new EventEmitter(), requested = deferred<void>(), refused = deferred<void>();
  let blocked = true, attempts = 0;
  const done = waitForChatShutdown({ shutdownRequested: requested.promise, signals,
    async close() { attempts++; if (blocked) throw new Error("active owner"); },
    refused() { refused.resolve(); },
  });
  signals.emit("SIGTERM"); await refused.promise;
  expect(attempts).toBe(1); expect(signals.listenerCount("SIGTERM")).toBe(1);
  blocked = false;
  // A microtask checkpoint proves that clearing the blocker alone does not trigger another attempt.
  await Promise.resolve(); expect(attempts).toBe(1);
  requested.resolve(); await done;
  expect(attempts).toBe(2); expect(signals.listenerCount("SIGTERM")).toBe(0); expect(signals.listenerCount("SIGINT")).toBe(0);
});

test("simultaneous explicit requests coalesce into one successful close", async () => {
  const signals = new EventEmitter(), requested = deferred<void>(), release = deferred<void>(); let attempts = 0;
  const done = waitForChatShutdown({ shutdownRequested: requested.promise, signals,
    async close() { attempts++; await release.promise; }, refused() { throw new Error("unexpected refusal"); },
  });
  requested.resolve(); signals.emit("SIGTERM"); signals.emit("SIGINT");
  await Promise.resolve(); expect(attempts).toBe(1); release.resolve(); await done; expect(attempts).toBe(1);
});
