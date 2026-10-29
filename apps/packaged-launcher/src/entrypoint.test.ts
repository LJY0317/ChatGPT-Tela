import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ChatWorkspaceRegistry } from "../../../packages/chat-service/src/workspaces";
import { ChatProcessManager } from "../../../packages/chat-service/src/processes";

test("one compiled runtime dispatches isolated daemons, CLI and a real owned command", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-shared-runtime-"));
  const executable = join(root, process.platform === "win32" ? "tela.exe" : "tela");
  let manager: ChatProcessManager | undefined;
  try {
    const build = Bun.spawn([process.execPath, "build", fileURLToPath(new URL("./entrypoint.ts", import.meta.url)),
      "--compile", `--outfile=${executable}`], { stdout: "pipe", stderr: "pipe" });
    const [built, , buildError] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
    expect(buildError).not.toContain("error:");
    expect(built).toBe(0);
    // Match package finalization: Bun appends the bundle after its runtime's signed bytes.
    if (process.platform === "darwin") execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", executable]);
    const run = async (args: string[]) => {
      const child = Bun.spawn([executable, ...args], { env: { PATH: process.env.PATH }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, err };
    };
    const help = await run(["--help"]);
    expect(help.code).toBe(0); expect(help.out).toContain("ChatGPT Tela packaged runtime"); expect(help.err).toBe("");
    for (const service of ["gateway", "chat", "codex"]) {
      const refused = await run(["--tela-daemon", service, "--help"]);
      expect(refused.code).toBe(1); expect(refused.out).toBe("");
      expect(refused.err).toContain(`Tela ${service[0]!.toUpperCase() + service.slice(1)} daemon accepts no command-line arguments`);
      const selected = await run(["--tela-daemon", service]);
      expect(selected.code).toBe(1); expect(selected.out).toBe("");
      expect(selected.err).toContain(`Tela ${service[0]!.toUpperCase() + service.slice(1)} daemon requires`);
    }
    const registryPath = join(root, "workspaces.json"), approvedRootsPath = join(root, "roots.json");
    const registry = new ChatWorkspaceRegistry({ allowedRoots: [root], storePath: registryPath });
    const workspace = registry.open(root);
    writeFileSync(approvedRootsPath, JSON.stringify({ version: 1, roots: [root] }));
    manager = new ChatProcessManager({ workspaces: registry, storePath: join(root, "operations.json"),
      ownerWorker: { executable, workspaceStorePath: registryPath, approvedRootsPath } });
    const initial = await manager.exec({ workspaceId: workspace.id, command: "echo shared-runtime-worker > result.txt", yieldTimeMs: 0 });
    await manager.waitUntilResolved();
    expect(manager.status(workspace.id, initial.operationId)).toMatchObject({ state: "exited", exitCode: 0 });
    expect(readFileSync(join(root, "result.txt"), "utf8").trim()).toBe("shared-runtime-worker");
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
