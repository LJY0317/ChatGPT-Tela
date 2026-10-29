import { runApplicationUpdate } from "./application-update";
import { diagnosePublicIngress, SystemTailscaleCommandRunner } from "@chatgpt-tela/tailscale-ingress";
import { probePublicMcp, probeUnifiedDevelopmentMcp } from "@chatgpt-tela/gateway";
import { readProductConfig } from "@chatgpt-tela/product-config";
import { resolveProductPaths, PackagedServiceShutdownNotStartedError } from "@chatgpt-tela/product-lifecycle";
import { writeDiagnosticIncident, type StructuralDiagnosticEvent } from "@chatgpt-tela/core";
import { join } from "node:path";
import {
  payloadRootForLauncherExecutable,
  resolvePackagedMenuBarLaunch,
  resolvePackagedServiceLaunch,
  runPackagedServiceLauncher,
} from "./runtime";
import { parsePackagedLifecycleCommand, runPackagedLifecycleCommand } from "./lifecycle";
import { LIFECYCLE_WORKER_ENV, runIndependentLifecycleProcess } from "./lifecycle-process";
import { runProductUninstall } from "@chatgpt-tela/product-uninstall";
import { runPackagedWorkCommand } from "./work";
import { readConfigurationInput, runPackagedBootstrapCommand } from "./bootstrap";
import { runPackagedChatCommand } from "./chat";
import { runPackagedServicesCommand } from "./services";
import { runPackagedDiagnosticsCommand } from "./diagnostics";
import { runMaintenanceCommand, openMaintenanceWindow, cleanupMaintenanceWindow } from "./maintenance";

const USAGE = `ChatGPT Tela packaged runtime

Usage:
  chatgpt-tela configure --file <product-config.json>
  chatgpt-tela configure --stdin [--if-missing]
  chatgpt-tela setup [--slot <profile>]
  chatgpt-tela ingress status --public [--public-dns-url <DNS-JSON-URL>]
  chatgpt-tela services <start|stop>
  chatgpt-tela services restart chat
  chatgpt-tela chat roots
  chatgpt-tela chat <allow-root|disallow-root> --path <folder>
  chatgpt-tela install (--dry-run | --apply) [--payload <package-directory>]
  chatgpt-tela repair  (--dry-run | --apply) [--payload <package-directory>]
  chatgpt-tela upgrade (--dry-run | --apply) [--payload <package-directory>]
  chatgpt-tela cancel-upgrade (--dry-run | --apply) --payload <source-package-directory>
  chatgpt-tela uninstall (--dry-run | --apply) [--remove-data]
  chatgpt-tela work [--slot <profile>] [--thread <id>] [--model <id>] [--cwd <folder>]
  chatgpt-tela diagnostics [list|decisions|inspect|record|activity|capture]

The package directory defaults to the directory containing this launcher. Use --dry-run before --apply.

Internal runtime commands:
  chatgpt-tela service <gateway|chat|codex>
  chatgpt-tela menu-bar
  chatgpt-tela maintenance-open [--payload <repair-package>]
`;

function serviceFromArguments(arguments_: readonly string[]): "gateway" | "chat" | "codex" {
  if (arguments_.length !== 2 || arguments_[0] !== "service") {
    throw new Error("usage: chatgpt-tela service <gateway|chat|codex>");
  }
  const service = arguments_[1];
  if (!(service === "gateway" || service === "chat" || service === "codex")) {
    throw new Error("packaged launcher service must be gateway, chat, or codex");
  }
  return service;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "application-update") {
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE ??= join(resolveProductPaths().logsRoot, "update.diagnostics.jsonl");
  }
  const lifecycleApply = ["install", "repair", "upgrade", "cancel-upgrade"].includes(args[0] ?? "")
    && parsePackagedLifecycleCommand(args).mode === "apply";
  if ((lifecycleApply || args[0] === "application-update" && args[1] !== "wait" || args[0] === "maintenance" && args[1] === "apply")
    && process.env[LIFECYCLE_WORKER_ENV] !== "1") {
    const result = await runIndependentLifecycleProcess({ executable: process.execPath,
      arguments: (lifecycleApply || args[0] === "application-update") && !args.includes("--payload")
        ? [...args, "--payload", payloadRootForLauncherExecutable()] : args,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code;
    return;
  }
  if (args[0] === "application-update") {
    const interruptWork = args.includes("--interrupt-work");
    if (interruptWork) args.splice(args.indexOf("--interrupt-work"), 1);
    const action = args[1], payloadIndex = args.indexOf("--payload"), targetIndex = args.indexOf("--target-build");
    if (!(action === "wait" || action === "prepare" || action === "finish" || action === "cancel") || payloadIndex < 0 || !args[payloadIndex + 1]
      || args.length !== (action === "prepare" ? 6 : 4) || (action === "prepare" && (targetIndex < 0 || !args[targetIndex + 1]))
      || interruptWork && action !== "prepare") {
      throw Error("usage: application-update <wait|prepare --target-build N [--interrupt-work]|finish|cancel> --payload app");
    }
    try {
      const result = await runApplicationUpdate(action, { payloadRoot: args[payloadIndex + 1]!, interruptWork,
        ...(targetIndex >= 0 ? { targetBuild: args[targetIndex + 1]! } : {}) });
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch (error) {
      if (!(error instanceof PackagedServiceShutdownNotStartedError)) throw error;
      process.stdout.write(JSON.stringify({ prepared: false, blockedService: error.service }) + "\n");
    }
    return;
  }
  if (args[0] === "ingress") {
    if (args[1] !== "status" || args[2] !== "--public"
      || !(args.length === 3 || args.length === 5 && args[3] === "--public-dns-url")) {
      throw new Error("usage: ingress status --public [--public-dns-url <DNS-JSON-URL>]");
    }
    const paths = resolveProductPaths();
    const config = readProductConfig(join(paths.configRoot, "product-v1.json"));
    const result = await diagnosePublicIngress(new URL(config.exposure.publicUrl), args[4] ?? "https://dns.google/resolve",
      config.exposure.kind === "tailscale-funnel" ? new SystemTailscaleCommandRunner(config.exposure.tailscaleCli) : undefined, {
        verify: (fetch, signal) => (config.publicMcpAbi === "stable" ? probePublicMcp : probeUnifiedDevelopmentMcp)(new URL(config.exposure.publicUrl), signal, fetch),
      });
    const observedAt = new Date().toISOString();
    const relays = Array.isArray(result.relays) ? result.relays : [];
    const timeline: StructuralDiagnosticEvent[] = relays.map(row => ({ ts: observedAt, event: "chatgpt_tela_ingress",
      stage: row.state === "unavailable" ? "public_relay_failed" : "public_relay_observed",
      phase: String(row.stage), relay_index: Number(row.index), tcp_connected: Boolean(row.tcpConnected),
      tls_connected: Boolean(row.tlsConnected), duration_ms: Number(row.durationMs),
      ...(row.errorCode ? { failure_class: String(row.errorCode).toLowerCase() } : {}),
      ...(typeof row.httpStatus === "number" ? { http_status: row.httpStatus } : {}),
    }));
    if (result.localIngress) timeline.push({ ts: observedAt, event: "chatgpt_tela_ingress", stage: "local_ingress_counter_observed",
      observed: result.localIngress.observed,
      ...(result.localIngress.before !== undefined ? { count_before: result.localIngress.before } : {}),
      ...(result.localIngress.after !== undefined ? { count_after: result.localIngress.after } : {}),
      ...(result.localIngress.delta !== undefined ? { count_delta: result.localIngress.delta } : {}),
      ...(result.localIngress.counterResetObserved !== undefined ? { counter_reset_observed: result.localIngress.counterResetObserved } : {}),
    });
    timeline.push({ ts: observedAt, event: "chatgpt_tela_ingress", stage: "public_ingress_probe",
      phase: String(result.stage ?? "http"), state: String(result.state), relay_count: relays.length,
      mcp_observed: result.mcpContract !== "not-probed", mcp_verified: result.mcpContract === "verified" });
    const ref = writeDiagnosticIncident(join(paths.logsRoot, "diagnostics"), {
      stage: "public_ingress_probe", observedAt, timeline,
    });
    process.stdout.write(`${JSON.stringify({ ...result, ref }, null, 2)}\n`);
    return;
  }
  if (args[0] === "diagnostics") {
    process.stdout.write(`${JSON.stringify(runPackagedDiagnosticsCommand(args), null, 2)}\n`);
    return;
  }
  if (args[0] === "chat") {
    const result = await runPackagedChatCommand(args, {payloadRoot:payloadRootForLauncherExecutable(),launcherExecutablePath:process.execPath});
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (args[0] === "maintenance-open") {
    process.stdout.write(`${JSON.stringify(await openMaintenanceWindow(payloadRootForLauncherExecutable(), process.execPath, args.slice(1)))}\n`);
    return;
  }
  if (args[0] === "maintenance-cleanup" && args.length === 3 && args[1] === "--workspace") {
    cleanupMaintenanceWindow(args[2]!);
    return;
  }
  if (args[0] === "maintenance") {
    const result = await runMaintenanceCommand(args, { executingBinaryPath: process.execPath });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    process.stdout.write(USAGE);
    return;
  }
  if (args[0] === "install" || args[0] === "repair" || args[0] === "upgrade" || args[0] === "cancel-upgrade") {
    const result = await runPackagedLifecycleCommand(args, {
      defaultPayloadRoot: payloadRootForLauncherExecutable(),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (args[0] === "configure" || args[0] === "setup" || args[0] === "bootstrap-status") {
    const result = await runPackagedBootstrapCommand(args, {
      payloadRoot: payloadRootForLauncherExecutable(), launcherExecutablePath: process.execPath,
      ...(args[0] === "configure" && args[1] === "--stdin"
        ? { configurationInput: await readConfigurationInput(process.stdin) } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (args[0] === "services") {
    const result = await runPackagedServicesCommand(args, {
      payloadRoot: payloadRootForLauncherExecutable(), launcherExecutablePath: process.execPath,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.success) process.exitCode = 1;
    return;
  }
  if (args[0] === "uninstall") {
    const allowed = new Set(["uninstall", "--dry-run", "--apply", "--remove-data"]);
    const unknown = args.find(argument => !allowed.has(argument));
    if (unknown) throw new Error(`unknown packaged uninstall argument: ${unknown}`);
    const dryRun = args.includes("--dry-run");
    const apply = args.includes("--apply");
    if (dryRun === apply) throw new Error("uninstall requires exactly one of --dry-run or --apply");
    const result = await runProductUninstall({
      mode: apply ? "apply" : "dry-run",
      removeData: args.includes("--remove-data"),
      ...(apply ? { executingBinaryPath: process.execPath } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (args[0] === "work") {
    process.exitCode = await runPackagedWorkCommand(args);
    return;
  }
  const launch = args.length === 1 && args[0] === "menu-bar"
    ? resolvePackagedMenuBarLaunch({
        payloadRoot: payloadRootForLauncherExecutable(),
        launcherExecutablePath: process.execPath,
      })
    : resolvePackagedServiceLaunch({
        service: serviceFromArguments(args),
        payloadRoot: payloadRootForLauncherExecutable(),
        launcherExecutablePath: process.execPath,
      });
  process.exitCode = await runPackagedServiceLauncher({ launch });
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
