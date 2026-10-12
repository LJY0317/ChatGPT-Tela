import { expect, test } from "bun:test";
import { launchdJobField } from "./launchd-inspection";

test("launchd inspection ignores nested requirement dictionaries using arrow syntax", () => {
  const output = `gui/501/example = {
    path = /tmp/example.plist
    state = running
    LWCR = {
      "reqs" => {
        "cdhash" => {
          "$in" => [
            0 = hash
          ]
        }
      }
      "vers" => 1
    }
    resource coalition = {
      state = active
    }
  }`;
  expect(launchdJobField(output, "state")).toBe("running");
  expect(launchdJobField(output, "path")).toBe("/tmp/example.plist");
});

test("launchd inspection still rejects duplicate, unbalanced, and nested-only authority", () => {
  for (const output of [
    "job = {\nstate = running\nstate = waiting\n}",
    "job = {\nstate = running\nreqs => {\n}",
    "job = {\nreqs => {\nstate = running\n}\n}",
    "job = {\nstate = running\n}\nother = {\nstate = waiting\n}",
  ]) expect(() => launchdJobField(output, "state")).toThrow();
});
