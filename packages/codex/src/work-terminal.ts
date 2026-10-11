import { spawn } from "node:child_process";
import { parseCodexTerminalSessionContract } from "@chatgpt-tela/service-protocol";

export function workTerminalArguments(input: {
  readonly session: unknown;
  readonly threadId?: string;
  readonly model?: string;
  readonly cwd?: string;
}): readonly string[] {
  const session = parseCodexTerminalSessionContract(input.session);
  const args = ["--remote", session.endpoint];
  for (const [name, value] of [["--model", input.model], ["--cd", input.cwd]] as const) {
    if (value !== undefined) {
      if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`invalid ${name}`);
      args.push(name, value);
    }
  }
  if (input.threadId !== undefined) {
    if (!input.threadId.trim() || input.threadId.startsWith("-") || /[\s\u007f]/.test(input.threadId)) {
      throw new Error("invalid Work thread id");
    }
    args.push("resume", input.threadId);
  }
  return Object.freeze(args);
}

/** Foreground official TUI only. It owns input, approvals, model switching and turn lifecycle. */
export async function runWorkTerminal(input: {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<number> {
  const env = { ...(input.environment ?? process.env) };
  // A calling agent may carry an unrelated per-turn route capability. Remote clients do not need it.
  delete env.OPENAI_ORGANIZATION;
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(input.executable, [...input.arguments], { stdio: "inherit", env, shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
}
