import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runIndependentLifecycleProcess } from "./lifecycle-process";

const removeFixture = registerTemporaryFixtureCleanup();

test("independent lifecycle preserves CLI results and survives loss of its invoking process", async () => {
  const result = await runIndependentLifecycleProcess({ executable: process.execPath,
    arguments: ["-e", 'console.log("result");console.error("detail");process.exitCode=7'],
  });
  expect(result).toEqual({ code: 7, stdout: "result\n", stderr: "detail\n" });

  const root = mkdtempSync(join(tmpdir(), "tela-lifecycle-parent-test-"));
  const marker = join(root, "completed.json");
  const events = watch(root);
  try {
    const completed = new Promise<void>(resolve => events.on("change", () => { if (existsSync(marker)) resolve(); }));
    const worker = `await Bun.sleep(100);require("node:fs").writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.ppid}));`;
    const module = fileURLToPath(new URL("./lifecycle-process.ts", import.meta.url));
    const parent = Bun.spawn([process.execPath, "-e",
      `import {runIndependentLifecycleProcess} from ${JSON.stringify(module)};void runIndependentLifecycleProcess({executable:process.execPath,arguments:["-e",${JSON.stringify(worker)}]});process.exit(0);`],
      { env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root }, stdout: "ignore", stderr: "pipe" });
    expect(await parent.exited).toBe(0);
    await completed;
    const receipt = JSON.parse(readFileSync(marker, "utf8"));
    expect(receipt.parent).not.toBe(parent.pid);
  } finally {
    events.close();
    removeFixture(root);
  }
});
