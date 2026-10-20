import { spawn } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LIFECYCLE_WORKER_ENV = "CHATGPT_TELA_LIFECYCLE_WORKER";

/** The caller may be inside the Desktop app this operation closes. Keep the
 * existing lifecycle in a separate OS session, with files rather than caller
 * pipes, so losing that caller does not interrupt installation/restoration.
 * The normal CLI still waits and returns the worker's output and exit code. */
export async function runIndependentLifecycleProcess(input: {
  executable: string; arguments: readonly string[];
  environment?: NodeJS.ProcessEnv;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const directory = mkdtempSync(join(tmpdir(), "chatgpt-tela-lifecycle-"));
  const executable = join(directory, process.platform === "win32" ? "launcher.exe" : "launcher");
  const stdout = join(directory, "stdout"), stderr = join(directory, "stderr");
  try {
    copyFileSync(input.executable, executable);
    chmodSync(executable, 0o700);
    const output = openSync(stdout, "wx", 0o600), errors = openSync(stderr, "wx", 0o600);
    let child;
    try {
      child = spawn(executable, [...input.arguments], {
        detached: true, windowsHide: true, stdio: ["ignore", output, errors],
        env: { ...(input.environment ?? process.env), [LIFECYCLE_WORKER_ENV]: "1" },
      });
    } finally { closeSync(output); closeSync(errors); }
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve(code ?? 1));
    });
    return { code, stdout: readFileSync(stdout, "utf8"), stderr: readFileSync(stderr, "utf8") };
  } finally {
    // If the caller itself dies, the child and these receipts survive. The
    // existing durable lifecycle journal owns recovery; never replay here.
    rmSync(directory, { recursive: true, force: true });
  }
}
