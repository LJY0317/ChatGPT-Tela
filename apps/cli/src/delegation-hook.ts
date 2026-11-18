import { diagnosticFailureFields, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { runDelegationCommand } from "./delegation-command";

/** An approved host hook is a maintenance hint, never enrollment or delete authority.
 * No model-visible output and no dependency of Native work on Tela availability. */
export async function runDelegationHook(text: string, input: Parameters<typeof runDelegationCommand>[1] = {}): Promise<boolean> {
  try {
    const event = JSON.parse(text);
    if (event?.hook_event_name !== "PostToolUse" || typeof event.tool_name !== "string"
      || !event.tool_name.endsWith("close_agent") || typeof event.tool_input?.target !== "string"
      || !event.tool_input.target) return false;
    await runDelegationCommand(["reconcile-delegations", "--all"], input);
    return true;
  } catch (error) {
    emitDiagnosticEvent("chatgpt_tela_codex", "delegation_retention_hook_failed", diagnosticFailureFields(error));
    return false;
  }
}
