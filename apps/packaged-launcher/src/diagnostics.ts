import { join } from "node:path";
import { diagnosticCenter, diagnosticSourcePaths } from "@chatgpt-tela/core";
import { resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import { observeTelaDecisions } from "./decision-observation";

const OPTIONS: Readonly<Record<string, readonly string[]>> = {
  list: [],
  decisions: [],
  inspect: ["--ref"],
  capture: ["--minutes", "--mode"],
  activity: ["--at", "--minutes", "--symptom", "--report-origin", "--operation", "--recovered-at", "--output-started-at"],
  record: ["--at", "--minutes", "--symptom", "--report-origin", "--operation", "--recovered-at", "--output-started-at"],
};

/** Local bounded diagnostics; never starts services or embeds private artifacts. */
export function runPackagedDiagnosticsCommand(args: readonly string[],
  paths: Pick<ReturnType<typeof resolveProductPaths>, "logsRoot"> = resolveProductPaths()): unknown {
  const command = args[1] ?? "list";
  if (args[0] !== "diagnostics" || !Object.hasOwn(OPTIONS, command)) {
    throw new Error("usage: diagnostics [list|decisions|inspect|record|activity|capture]");
  }
  const flags = new Map<string, string>();
  for (let i = 2; i < args.length; i += 2) {
    const name = args[i]!;
    const value = args[i + 1];
    if (!OPTIONS[command]!.includes(name) || !value || value.startsWith("--") || flags.has(name)) {
      throw new Error("invalid, missing or repeated diagnostic option");
    }
    flags.set(name, value);
  }
  if (command === "decisions") return observeTelaDecisions(paths.logsRoot);
  return diagnosticCenter(join(paths.logsRoot, "diagnostics"), diagnosticSourcePaths(paths.logsRoot), command, name => flags.get(name));
}
