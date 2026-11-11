import { execFile } from "node:child_process";
import type { DefaultDesktopInstallation } from "./platform";

/** Read account-specific Native metadata without blocking browser startup or launching Desktop. */
export function readDefaultDesktopNativeCatalog(input: {
  readonly installation: DefaultDesktopInstallation;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...(input.environment ?? {}), CODEX_HOME: input.installation.codexHome };
  // The Web route capability must never become a Native discovery account header.
  delete environment.OPENAI_ORGANIZATION;
  return new Promise((resolve, reject) => {
    execFile(input.installation.codexExecutable, ["debug", "models"], {
      env: environment, timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
      ...(input.signal ? { signal: input.signal } : {}),
      encoding: "utf8", windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(error.name === "AbortError"
          ? "Native model catalog discovery was cancelled"
          : "Native model catalog discovery failed"));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("Native model catalog discovery returned invalid JSON")); }
    });
  });
}
