import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { auditNativePublicContinuityProtocol } from "../../../packages/codex/src/public-continuity-protocol-audit";

/** On-demand schema inspection only. Never connects to a Native thread or
 * examines CODEX_HOME / personal rollout data. Exit 2 means probe failure;
 * even a successful inspection never enables automatic Native handoff. */
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--codex" || !isAbsolute(args[1]!)) {
  console.error("Usage: bun run codex:continuity-probe --codex /absolute/path/to/codex");
  process.exit(2);
}
const executable = resolve(args[1]!);
const scratch = mkdtempSync(join(tmpdir(), "tela-public-codex-schema-"));
try {
  const home = join(scratch, "empty-home");
  const out = join(scratch, "schema");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(out, { mode: 0o700 });
  // Do not forward credentials, personal CODEX_HOME, plugins or model-provider
  // configuration into even a schema-only child process.
  const env: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: home };
  for (const name of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "ComSpec",
    "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const run = (params: readonly string[]) => {
    const result = spawnSync(executable, [...params], {
      env, encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) {
      throw new Error("Public Codex schema generation failed; no runtime capabilities were assumed");
    }
    return result.stdout.trim();
  };
  const version = run(["--version"]).slice(0, 128);
  if (!/^codex-cli\s+[0-9]+\.[0-9]+\.[0-9]+/.test(version)) {
    throw new Error("Unrecognized Codex CLI public version");
  }
  run(["app-server", "generate-json-schema", "--experimental", "--out", out]);
  const read = (file: string): unknown => {
    const path = join(out, file);
    if (statSync(path).size > 16 * 1024 * 1024) throw new Error("Public Codex schema exceeds inspection bounds");
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const audit = auditNativePublicContinuityProtocol({
    requests: read("ClientRequest.json"),
    threadReadParams: read("v2/ThreadReadParams.json"),
    threadReadResponse: read("v2/ThreadReadResponse.json"),
    forkParams: read("v2/ThreadForkParams.json"),
  });
  console.log(JSON.stringify({
    codexVersion: version,
    inspection: "schema_only_no_app_server_started_no_user_history",
    ...audit,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Public Codex schema inspection failed");
  process.exitCode = 2;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
