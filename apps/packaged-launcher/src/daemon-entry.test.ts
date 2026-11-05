import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDiagnosticIncidents, readDiagnosticIncident } from "@chatgpt-tela/core";

test("an import failure before daemon hooks records a classified incident and retains fatal exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-daemon-import-"));
  const module = new URL("./daemon-entry.ts", import.meta.url).href;
  const source = `import { launchDaemon } from ${JSON.stringify(module)};
    await launchDaemon("chat", () => import("./tela-intentionally-missing-entrypoint"));`;
  try {
    const child = Bun.spawn([process.execPath, "--eval", source], {
      env: { ...process.env, CHATGPT_TELA_DIAGNOSTIC_FILE: join(root, "chat.diagnostics.jsonl") },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0); // Manual execution keeps the runtime's fatal stderr.
    const incidents = listDiagnosticIncidents(join(root, "diagnostics"));
    const record = incidents.find(item => item.stage === "daemon_startup_failed");
    expect(record).toBeDefined();
    const incident = JSON.stringify(readDiagnosticIncident(join(root, "diagnostics"), record!.ref));
    expect(incident).toContain("not_found");
    expect(incident).not.toContain("tela-intentionally-missing-entrypoint");
    expect(readdirSync(root).some(file => file.endsWith(".log"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
