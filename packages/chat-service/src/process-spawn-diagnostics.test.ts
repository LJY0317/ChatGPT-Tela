import { expect, test } from "bun:test";
import { safeProcessSpawnFailure } from "./processes";

test("spawn failures expose fixed diagnostic categories without leaking raw commands, paths or errors", () => {
  const cases: Array<[unknown, string]> = [
    [{ code: "EBADF", message: "private command and private path" }, "bad_file_descriptor"],
    [{ code: "EMFILE", path: "/private/workspace" }, "resource_exhausted"],
    [{ code: "EAGAIN" }, "resource_exhausted"],
    [{ code: "EPERM" }, "permission_denied"],
    [{ code: "ENOENT" }, "missing_executable"],
    [{ code: "PRIVATE_ERROR", command: "secret" }, "unknown"],
    ["private opaque error", "unknown"],
  ];
  for (const [error, expected] of cases) {
    const value = safeProcessSpawnFailure(error);
    expect(String(value.error_class)).toBe(expected);
    expect(["bun", "node", "other"]).toContain(value.runtime_class);
    expect(["darwin", "linux", "win32", "other"]).toContain(value.platform_class);
    expect(Object.keys(value).sort()).toEqual(["error_class", "platform_class", "runtime_class"]);
    expect(JSON.stringify(value)).not.toContain("private");
    expect(JSON.stringify(value)).not.toContain("secret");
  }
});
