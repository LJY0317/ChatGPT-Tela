import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const daemon of ["gateway", "chat", "codex"]) {
  test.each(["--help", "--unknown"])(`${daemon} rejects %s before service configuration or publication`, async flag => {
    const entry = fileURLToPath(new URL(`../../${daemon}-daemon/src/main.ts`, import.meta.url));
    // No production credentials or runtime authority are inherited by the fixture.
    const child = Bun.spawn([process.execPath, entry, flag], {
      env: { PATH: process.env.PATH }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("daemon accepts no command-line arguments");
  });
}
