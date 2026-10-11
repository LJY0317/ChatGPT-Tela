import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ChatWorkspaceRegistry } from "./workspaces";

export const CHAT_EXPORT_MAX_BYTES = 2 * 1024 * 1024;
/** Export authority stays in Chat and the pinned native workspace helper. No cache or public URL. */
export class ChatFileExporter {
  readonly #executable: string;
  #supported = false;
  #closing = false;
  #active: ReturnType<typeof spawn> | undefined;
  #operation: Promise<Buffer> | undefined;
  constructor(private readonly workspaces: ChatWorkspaceRegistry, executable: string) {
    if (!isAbsolute(executable)) throw new Error("file exporter configuration is invalid");
    const stat = lstatSync(executable);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("file exporter executable is unsafe");
    this.#executable = realpathSync(executable);
  }
  get supported() { return this.#supported && !this.#closing; }
  async #invoke(args: string[], input: Buffer, maximum: number): Promise<Buffer> {
    if (this.#closing || this.#active) throw new Error("file export is unavailable or busy");
    const child = spawn(this.#executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {} });
    this.#active = child;
    const operation = new Promise<Buffer>((resolve, reject) => {
      let size = 0, failed = false;
      const chunks: Buffer[] = [];
      const stop = () => { failed = true; child.kill(); };
      const timer = setTimeout(stop, 15_000);
      child.stdin.on("error", stop);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximum) stop(); else chunks.push(chunk);
      });
      child.stderr.resume(); // Native diagnostic details are not exposed or persisted.
      child.on("error", stop);
      child.on("close", code => {
        clearTimeout(timer);
        if (!failed && !this.#closing && code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error("file export failed; verify the file and workspace before retrying"));
      });
      child.stdin.end(input);
    });
    this.#operation = operation;
    try { return await operation; }
    finally { this.#active = undefined; this.#operation = undefined; }
  }
  async initialize(): Promise<void> {
    try { this.#supported = (await this.#invoke(["--export-version"], Buffer.alloc(0), 1024)).toString() === "1\n"; }
    catch { this.#supported = false; }
  }
  async read(workspaceId: string, path: string) {
    return this.workspaces.use(workspaceId, async () => {
      if (!this.supported) throw new Error("file export is not supported by this installation");
      const workspace = this.workspaces.get(workspaceId);
      const request = Buffer.from(JSON.stringify({ version: 1, root: workspace.root, device: workspace.device, inode: workspace.inode, path }));
      if (request.length > 8192) throw new Error("file export request exceeds the protocol limit");
      const result = await this.#invoke(["--export"], request, CHAT_EXPORT_MAX_BYTES + 1024);
      const end = result.indexOf(10);
      if (end < 0 || end > 1024) throw new Error("invalid file export receipt");
      let receipt: { version?: number; bytes?: number; sha256?: string };
      try { receipt = JSON.parse(result.subarray(0, end).toString()); } catch { throw new Error("invalid file export receipt"); }
      const bytes = result.subarray(end + 1);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (receipt.version !== 1 || receipt.bytes !== bytes.length || bytes.length > CHAT_EXPORT_MAX_BYTES || receipt.sha256 !== digest) {
        throw new Error("invalid file export receipt");
      }
      return Object.freeze({ name: path.split("/").at(-1)!, bytes: bytes.length, sha256: digest, dataBase64: bytes.toString("base64") });
    });
  }
  async close() {
    this.#closing = true;
    this.#active?.kill();
    await this.#operation?.catch(() => {});
  }
}
