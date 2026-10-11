import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDefaultDesktopNativeCatalog } from "../runtime";
import type { DefaultDesktopInstallation } from "../platform";

const checks: {name: string; run: () => Promise<void>}[] = [];
const fixtureTest = (name: string, run: () => Promise<void>) => { checks.push({name, run}); };
function fixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), "tela-native-preparation-"));
  const executable = join(root, "engine");
  writeFileSync(executable, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  const installation: DefaultDesktopInstallation = {
    platform: "linux", chatGptExecutable: join(root, "never-launch-desktop"),
    codexExecutable: executable, codexHome: join(root, "fixture-home"),
    userDataDir: join(root, "fixture-data"), normalQuitSupported: true,
  };
  return { root, installation };
}
fixtureTest("Native catalog preparation leaves the event loop free for simultaneous Web preparation", async () => {
  const { root, installation } = fixture('sleep 0.2\nprintf \'{"models":[],"home":"%s","organization":"%s"}\' "$CODEX_HOME" "${OPENAI_ORGANIZATION-unset}"');
  try {
    let finished = false;
    const pending = readDefaultDesktopNativeCatalog({ installation, environment: { OPENAI_ORGANIZATION: "fixture-route" } });
    void pending.then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(finished, false);
    assert.deepEqual(await pending, { models: [], home: installation.codexHome, organization: "unset" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
fixtureTest("failed and cancelled preparation is bounded and never launches Desktop", async () => {
  const invalid = fixture('printf "not-json"');
  try { await assert.rejects(readDefaultDesktopNativeCatalog({ installation: invalid.installation })); }
  finally { rmSync(invalid.root, { recursive: true, force: true }); }
  const cancelled = fixture('exec sleep 20');
  const controller = new AbortController();
  try {
    const pending = readDefaultDesktopNativeCatalog({ installation: cancelled.installation, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending);
  } finally { rmSync(cancelled.root, { recursive: true, force: true }); }
});

if (process.platform === "win32") throw new Error("Shell fixture is POSIX-only; Windows process behavior is not verified by this fixture");
for (const check of checks) { await check.run(); console.log(`passed: ${check.name}`); }
