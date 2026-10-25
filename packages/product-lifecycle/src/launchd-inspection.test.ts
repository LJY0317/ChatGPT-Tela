import { expect, test } from "bun:test";
import { launchdJobField, launchdJobFailureEvidence } from "./launchd-inspection";

test("launchd failure evidence reads only direct bounded fields", () => {
  const output = `job = {\n state = xpcproxy\n pid = 0\n last exit reason = OS_REASON_CODESIGNING\n last exit code = 0x1\n spawn failed = true\n resource coalition = {\n last exit reason = PRIVATE_DETAIL\n pid = 999\n }\n}`;
  expect(launchdJobFailureEvidence(output)).toEqual({ state: "xpcproxy", process: "absent",
    lastExitReason: "OS_REASON_CODESIGNING", lastExitCode: "0x1", spawnFailed: "yes" });
  expect(launchdJobFailureEvidence(`job = {\n state = not running\n resource coalition = {\n last exit reason = OS_REASON_CODESIGNING\n }\n}`))
    .toEqual({ state: "not running", process: "unknown", lastExitReason: "unknown", lastExitCode: "unknown", spawnFailed: "unknown" });
});

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
