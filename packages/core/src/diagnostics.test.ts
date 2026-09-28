import { expect, test } from "bun:test";
import { BoundedIncidentBuffer } from "./diagnostics";

test("incident evidence retention stays bounded", () => {
  const buffer = new BoundedIncidentBuffer(2);
  for (const summary of ["one", "two", "three"]) {
    buffer.push({ kind: "fixture", summary, observedAt: summary });
  }
  expect(buffer.snapshot().map(entry => entry.summary)).toEqual(["two", "three"]);
});
