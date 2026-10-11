import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, opendirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ChatWorkspaceRegistry } from "./workspaces";

export const CHAT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/** Registry and product-private journals supply authority; requests never choose absolute roots. */
export class ChatFileImporter {
  private readonly executable: string;
  private readonly journalRoot: string;
  private active = false;
  private closing = false;
  private publication: Promise<Record<string, unknown>> | undefined;
  constructor(private readonly workspaces: ChatWorkspaceRegistry, executable: string, journalRoot: string) {
    if (!isAbsolute(executable) || !isAbsolute(journalRoot)) throw new Error("file publisher configuration is invalid");
    const stat = lstatSync(executable);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("file publisher executable is unsafe");
    this.executable = realpathSync(executable);
    mkdirSync(journalRoot, { recursive: true, mode: 0o700 });
    if (lstatSync(journalRoot).isSymbolicLink()) throw new Error("file import journal is unsafe");
    this.journalRoot = realpathSync(journalRoot);
  }

  private environment(): NodeJS.ProcessEnv {
    return process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {};
  }

  async initialize(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try { child = spawn(this.executable, ["--protocol-version"], {
        env: this.environment(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      }); } catch { reject(new Error("file publisher protocol check failed")); return; }
      let output = "";
      const timer = setTimeout(() => child.kill(), 5000);
      child.stdin!.on("error", () => {});
      child.stdin!.end();
      child.stdout!.on("data", chunk => { output += chunk.toString(); if (output.length > 1024) child.kill(); });
      child.stderr!.resume();
      child.on("error", () => { clearTimeout(timer); reject(new Error("file publisher protocol check failed")); });
      child.on("close", code => {
        clearTimeout(timer);
        if (code === 0 && output === "2\n") resolve(); else reject(new Error("file publisher protocol check failed"));
      });
    });
  }

  private async invoke(workspaceId: string, operation: "publish" | "recover", path: string, bytes: Buffer) {
    return this.workspaces.use(workspaceId, async () => {
      if (this.closing) throw new Error("file importer is stopping");
      if (this.active) throw new Error("another file import is in progress; wait for its result");
      const workspace = this.workspaces.get(workspaceId);
      const journal = join(this.journalRoot, createHash("sha256").update(workspace.id).digest("hex"));
      mkdirSync(journal, { mode: 0o700, recursive: true });
      const journalStat = lstatSync(journal, { bigint: true });
      if (!journalStat.isDirectory() || journalStat.isSymbolicLink()) throw new Error("file import journal is unsafe");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const header = Buffer.from(JSON.stringify({ version: 2, operation, journal: realpathSync(journal),
        journal_device: journalStat.dev.toString(), journal_inode: journalStat.ino.toString(),
        root: workspace.root, device: workspace.device, inode: workspace.inode, path, bytes: bytes.length, sha256 }) + "\n");
      if (header.length > 8192) throw new Error("file import request exceeds the protocol limit");
      this.active = true;
      try {
        const result = await (this.publication = new Promise<Record<string, unknown>>((resolve, reject) => {
          let child: ReturnType<typeof spawn>;
          try { child = spawn(this.executable, [], { env: this.environment(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
          catch { reject(new Error("file publisher could not start")); return; }
          let output = "", errorOutput = "";
          let staged = false;
          let failed = false;
          const fail = () => { failed = true; child.kill(); };
          const timer = setTimeout(fail, 15_000);
          child.stdout!.on("data", chunk => {
            output += chunk.toString();
            if (output.length > 1024) { fail(); return; }
            if (operation === "publish" && !staged && output.includes("\n")) {
              const newline = output.indexOf("\n");
              try {
                const proof = JSON.parse(output.slice(0, newline));
                if (proof.version !== 2 || proof.staged !== true) { fail(); return; }
                staged = true; output = output.slice(newline + 1);
                child.stdin!.end("commit\n");
              } catch { fail(); }
            }
          });
          child.stderr!.on("data", chunk => { errorOutput += chunk.toString(); if (errorOutput.length > 1024) fail(); });
          child.stdin!.on("error", fail);
          child.on("error", () => { clearTimeout(timer); reject(new Error("file publisher could not start")); });
          child.on("close", code => {
            clearTimeout(timer);
            if (failed) { reject(new Error("file import outcome is unknown; check the destination before retrying")); return; }
            try {
              if (code !== 0) {
                const kind = JSON.parse(errorOutput).error;
                if (kind === "AlreadyExists") throw new Error("destination already exists; choose a different filename");
                if (operation === "recover") throw new Error("temporary file recovery needs attention; ambiguous files were preserved");
                throw new Error("file import refused; verify the folder, filename and pending recovery state");
              }
              const value = JSON.parse(output) as Record<string, unknown>;
              if (value.version !== 2 || (operation === "recover" ? value.recovered !== true
                : !staged || value.published !== true || value.bytes !== bytes.length || value.sha256 !== sha256 || typeof value.cleanupComplete !== "boolean")) {
                throw new Error("file import outcome is unknown; check the destination before retrying");
              }
              resolve(value);
            } catch (error) { reject(error instanceof SyntaxError ? new Error("file publisher returned an invalid response; check the destination before retrying") : error); }
          });
          const body = Buffer.concat([header, bytes]);
          if (operation === "publish") child.stdin!.write(body); else child.stdin!.end(body);
        }));
        return { workspace, sha256, result };
      } finally { this.active = false; this.publication = undefined; }
    });
  }

  async recover(workspaceId: string): Promise<void> {
    await this.invoke(workspaceId, "recover", "unused", Buffer.alloc(0));
  }

  async publish(input: { readonly workspaceId: string; readonly path: string; readonly dataBase64: string }) {
    if (typeof input.path !== "string" || !input.path || Buffer.byteLength(input.path) > 4096) throw new Error("destination path is invalid");
    const encoded = input.dataBase64;
    if (typeof encoded !== "string" || encoded.length > Math.ceil(CHAT_IMPORT_MAX_BYTES / 3) * 4) throw new Error("file exceeds the 2 MiB import limit");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.length > CHAT_IMPORT_MAX_BYTES) throw new Error("file data is invalid or exceeds the import limit");
    const { workspace, sha256, result } = await this.invoke(input.workspaceId, "publish", input.path, bytes);
    return Object.freeze({ workspace_id: workspace.id, path: input.path, bytes: bytes.length, sha256,
      published: true, cleanupComplete: result.cleanupComplete });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.publication?.catch(() => {});
  }
}

/** Conservative uninstall gate: bounded, no symlink traversal, no payload/receipt reads. */
export function hasPendingFileImports(journalRoot: string): boolean {
  try {
    if (!existsSync(journalRoot)) return false;
    const stat = lstatSync(journalRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    const root = opendirSync(journalRoot);
    try {
      for (let count = 0; count <= 64; count++) {
        const entry = root.readSync();
        if (!entry) return false;
        if (count === 64 || !entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) return true;
        const childPath = join(journalRoot, entry.name);
        const childStat = lstatSync(childPath);
        if (!childStat.isDirectory() || childStat.isSymbolicLink()) return true;
        const child = opendirSync(childPath);
        try { if (child.readSync()) return true; } finally { child.closeSync(); }
      }
      return true;
    } finally { root.closeSync(); }
  } catch { return true; }
}
