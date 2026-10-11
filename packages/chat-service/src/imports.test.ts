import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, readdirSync, lstatSync, writeFileSync, linkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChatFileImporter, CHAT_IMPORT_MAX_BYTES } from "./imports";
import { ChatWorkspaceRegistry } from "./workspaces";
import { startChatService } from "./index";
import { createChatToolRuntime } from "./tools";

const executable = resolve(import.meta.dir, "../../../build/workspace-files-target/release/tela-workspace-files" + (process.platform === "win32" ? ".exe" : ""));
const nativeTest = existsSync(executable) ? test : test.skip;

nativeTest("native file ingress: exact binary, duplicate protection, bounded input and workspace identity", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tela-import-test-")));
  const root = join(base, "workspace"); mkdirSync(root); mkdirSync(join(root, "uploads"));
  const workspaces = new ChatWorkspaceRegistry({ allowedRoots: [root], storePath: join(base, "state.json") });
  const workspace = workspaces.open(root);
  const importer = new ChatFileImporter(workspaces, executable, join(base, "imports-v2"));
  try {
    await importer.initialize();
    const bytes = Buffer.from([0, 255, 128, 10, 0]);
    const request = { workspaceId: workspace.id, path: "uploads/file.bin", dataBase64: bytes.toString("base64") };
    const result = await importer.publish(request);
    expect(result).toMatchObject({ published: true, bytes: bytes.length, cleanupComplete: true,
      sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(readFileSync(join(root, request.path))).toEqual(bytes);
    await expect(importer.publish(request)).rejects.toThrow("already exists");
    expect(readFileSync(join(root, request.path))).toEqual(bytes);
    await expect(importer.publish({ ...request, path: "../outside" })).rejects.toThrow("refused");
    await expect(importer.publish({ ...request, path: "bad", dataBase64: "%%%" })).rejects.toThrow("invalid");
    await expect(importer.publish({ ...request, path: "big", dataBase64: Buffer.alloc(CHAT_IMPORT_MAX_BYTES + 1).toString("base64") })).rejects.toThrow("limit");
    await expect(importer.publish({ ...request, workspaceId: "unknown" })).rejects.toThrow();
    if (process.platform !== "win32") {
      symlinkSync(base, join(root, "linked"));
      await expect(importer.publish({ ...request, path: "linked/outside" })).rejects.toThrow("refused");
      expect(existsSync(join(base, "outside"))).toBe(false);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

nativeTest("runtime advertises import only with the native publisher and returns no file bytes", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tela-import-runtime-")));
  const root = join(base, "workspace"); mkdirSync(root);
  const plain = createChatToolRuntime({ allowedRoots: [root], stateRoot: join(base, "plain") });
  const runtime = createChatToolRuntime({ allowedRoots: [root], stateRoot: join(base, "native"), filePublisherExecutable: executable });
  try {
    await runtime.initialize();
    expect(plain.capabilities).not.toContain("import_file");
    expect(runtime.capabilities).toContain("open_file_import");
    const workspace = runtime.workspaces.open(root);
    expect(await runtime.call("open_file_import", { workspace_id: workspace.id })).toEqual({ workspace_id: workspace.id, maxBytes: CHAT_IMPORT_MAX_BYTES });
    const result = await runtime.call("import_file", { workspace_id: workspace.id, path: "empty.bin", data_base64: "" });
    expect(result).toMatchObject({ published: true, bytes: 0 });
    expect(JSON.stringify(result)).not.toContain("data_base64");
    expect(readFileSync(join(root, "empty.bin")).length).toBe(0);
  } finally { await runtime.close(); await plain.close(); rmSync(base, { recursive: true, force: true }); }
});

nativeTest("authenticated Chat HTTP import accepts the full binary budget and denies unauthenticated callers", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tela-import-http-")));
  const root = join(base, "workspace"); mkdirSync(root);
  const runtime = createChatToolRuntime({ allowedRoots: [root], stateRoot: join(base, "state"), filePublisherExecutable: executable });
  await runtime.initialize();
  const workspace = runtime.workspaces.open(root);
  const token = "fixture-only-bearer-token-32-characters";
  const service = await startChatService({ tools: runtime, bearerToken: token });
  try {
    const endpoint = new URL("v1/call", service.endpoint);
    const bytes = Buffer.alloc(CHAT_IMPORT_MAX_BYTES, 255);
    const body = JSON.stringify({ capability: "import_file", arguments: { workspace_id: workspace.id, path: "full.bin", data_base64: bytes.toString("base64") } });
    const denied = await fetch(endpoint, { method: "POST", body });
    expect(denied.status).toBe(401);
    expect(existsSync(join(root, "full.bin"))).toBe(false);
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
    expect(response.status).toBe(200);
    expect((await response.json() as { result: unknown }).result).toMatchObject({ published: true, bytes: CHAT_IMPORT_MAX_BYTES });
    expect(readFileSync(join(root, "full.bin"))).toEqual(bytes);
  } finally { await service.close(); rmSync(base, { recursive: true, force: true }); }
});

async function interruptedStage(workspace: { id: string; root: string; device: string; inode: string }, journalRoot: string) {
  const journal = join(journalRoot, createHash("sha256").update(workspace.id).digest("hex"));
  mkdirSync(journal, { recursive: true });
  const stat = lstatSync(journal, { bigint: true });
  const bytes = Buffer.from("original binary");
  const header = JSON.stringify({ version: 2, operation: "publish", journal,
    journal_device: stat.dev.toString(), journal_inode: stat.ino.toString(),
    root: workspace.root, device: workspace.device, inode: workspace.inode, path: "final.bin",
    bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }) + "\n";
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("checkpoint not reached")); }, 5000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", () => { clearTimeout(timer); reject(new Error("helper exited before checkpoint")); });
      child.stdout.on("data", data => {
        output += data.toString();
        if (output.includes("\n")) {
          clearTimeout(timer);
          const proof = JSON.parse(output.trim());
          if (proof.version === 2 && proof.staged === true) resolve(); else reject(new Error("invalid checkpoint"));
        }
      });
      child.stdin.write(Buffer.concat([Buffer.from(header), bytes]));
    });
    const closed = new Promise(resolve => child.once("close", resolve));
    child.kill("SIGKILL"); await closed;
  } finally { child.kill(); }
  const name = readdirSync(journal).find(name => name.endsWith(".json"))!;
  const receipt = JSON.parse(readFileSync(join(journal, name), "utf8")) as { stage_name: string };
  return { journal, stage: join(workspace.root, receipt.stage_name) };
}

nativeTest("process interruption recovery removes only proven scratch and preserves published and foreign files", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tela-import-crash-")));
  try {
    for (const phase of ["empty", "partial", "published"] as const) {
      const root = join(base, phase); mkdirSync(root);
      const workspaces = new ChatWorkspaceRegistry({ allowedRoots: [root], storePath: join(base, phase + ".json") });
      const workspace = workspaces.open(root);
      const journalRoot = join(base, phase + "-journal");
      const { journal, stage } = await interruptedStage(workspace, journalRoot);
      expect(readdirSync(stage)).toEqual([]); // durable checkpoint waits before creating file bytes
      if (phase !== "empty") writeFileSync(join(stage, "content"), "surviving binary");
      if (phase === "published") linkSync(join(stage, "content"), join(root, "final.bin"));
      const foreign = join(root, ".tela-import-foreign"); mkdirSync(foreign); writeFileSync(join(foreign, "keep"), "user");
      const restarted = new ChatFileImporter(workspaces, executable, journalRoot);
      await restarted.initialize(); await restarted.recover(workspace.id);
      expect(existsSync(stage)).toBe(false);
      expect(readdirSync(journal)).toEqual([]);
      expect(readFileSync(join(foreign, "keep"), "utf8")).toBe("user");
      if (phase === "published") expect(readFileSync(join(root, "final.bin"), "utf8")).toBe("surviving binary");
      else expect(existsSync(join(root, "final.bin"))).toBe(false);
      await restarted.close();
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

nativeTest("replaced stage is preserved and blocks another allocation", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tela-import-replaced-")));
  const root = join(base, "workspace"); mkdirSync(root);
  const workspaces = new ChatWorkspaceRegistry({ allowedRoots: [root], storePath: join(base, "state.json") });
  const workspace = workspaces.open(root);
  const journalRoot = join(base, "journal");
  try {
    const { stage, journal } = await interruptedStage(workspace, journalRoot);
    renameSync(stage, join(root, "original-stage")); mkdirSync(stage); writeFileSync(join(stage, "content"), "foreign");
    const restarted = new ChatFileImporter(workspaces, executable, journalRoot);
    await restarted.initialize();
    await expect(restarted.recover(workspace.id)).rejects.toThrow("ambiguous files were preserved");
    await expect(restarted.publish({ workspaceId: workspace.id, path: "next.bin", dataBase64: "AQ==" })).rejects.toThrow("refused");
    expect(readFileSync(join(stage, "content"), "utf8")).toBe("foreign");
    expect(readdirSync(journal)).toHaveLength(1);
    expect(existsSync(join(root, "next.bin"))).toBe(false);
    await restarted.close();
  } finally { rmSync(base, { recursive: true, force: true }); }
});
