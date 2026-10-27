import { basename } from "node:path";
import type { ServiceRegistrationCommandRunner, ServiceRegistrationCommandResult } from "@chatgpt-tela/product-lifecycle";

export class LaunchdUpgradeRunner implements ServiceRegistrationCommandRunner {
  readonly jobs = new Map<string, { path: string; running: boolean }>();
  readonly calls: string[] = [];
  failBootstrapOnce = false;
  failAfterBootstrapOnce = false;
  async run(command: string, args: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    if (command !== "/bin/launchctl") throw Error(`unexpected command: ${command}`);
    this.calls.push(args.join(" "));
    const target = args.at(-1)!;
    if (args[0] === "bootstrap") {
      if (this.failBootstrapOnce) { this.failBootstrapOnce = false; return { exitCode: 1, stdout: "", stderr: "interrupted reload" }; }
      const label = basename(target, ".plist");
      this.jobs.set(label, { path: target, running: false });
      if (this.failAfterBootstrapOnce) {
        this.failAfterBootstrapOnce = false;
        throw Error("bootstrap acknowledged before journal write");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const label = target.split("/").at(-1)!;
    const job = this.jobs.get(label);
    if (args[0] === "print") return job
      ? { exitCode: 0, stdout: `job = {\n path = ${job.path}\n state = ${job.running ? "running" : "not running"}\n}\n`, stderr: "" }
      : { exitCode: 113, stdout: "", stderr: "not loaded" };
    if (args[0] === "bootout") {
      this.jobs.delete(label);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "kickstart" && job) {
      job.running = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw Error(`unexpected launchctl arguments: ${args.join(" ")}`);
  }
}
