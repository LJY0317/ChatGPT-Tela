import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

(process.platform === "darwin" ? test : test.skip)("menu diagnostic retention uses time and encoded bytes without an event-count cutoff", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-menu-retention-"));
  try {
    const fixture = join(root, "test.swift"), binary = join(root, "test");
    writeFileSync(fixture, `import Foundation
@main struct Test {
 static func main() throws {
  let rows: [[String: Any]] = (0..<200).map { ["at": 100.0, "id": $0, "event": "창 상태 🙂"] }
  let all = try retainedMenuDiagnosticData(rows, since: 99, maxBytes: 131072)
  let allRows = try JSONSerialization.jsonObject(with: all) as! [[String: Any]]
  precondition(allRows.count == 200, "small events must survive beyond the old 64-event cutoff")
  let budget = try JSONSerialization.data(withJSONObject: Array(rows.suffix(2))).count
  let bounded = try retainedMenuDiagnosticData(rows, since: 99, maxBytes: budget)
  let kept = try JSONSerialization.jsonObject(with: bounded) as! [[String: Any]]
  precondition(bounded.count <= budget && kept.count == 2)
  precondition(kept[0]["id"] as? Int == 198 && kept[1]["id"] as? Int == 199)
  let expired = try retainedMenuDiagnosticData(rows + [["at": 102.0, "id": 200]], since: 101, maxBytes: 131072)
  let fresh = try JSONSerialization.jsonObject(with: expired) as! [[String: Any]]
  precondition(fresh.count == 1 && fresh[0]["id"] as? Int == 200)
  let tooSmall = try retainedMenuDiagnosticData(rows, since: 99, maxBytes: 2)
  precondition(tooSmall == Data("[]".utf8))
  print("retention verified")
 }
}`);
    const compile = spawnSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", resolve("apps/menu-bar-macos/diagnostic-retention.swift"), fixture, "-o", binary], { encoding: "utf8" });
    expect({ status: compile.status, stderr: compile.stderr }).toEqual({ status: 0, stderr: "" });
    const run = spawnSync(binary, [], { encoding: "utf8" });
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: "retention verified\n", stderr: "" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);
