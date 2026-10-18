import { diagnosticDurationMs, diagnosticFailureFields, emitDiagnosticEvent, type NativeToolInvocation } from "@chatgpt-tela/core";
import type { RemoteTurnBridge, TurnBridgeBackend } from "@chatgpt-tela/mcp";
import { turnCapabilityRoute } from "@chatgpt-tela/runtime";

function payloadBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    return 0;
  }
}

export class RoutedCodexTurnBridge implements TurnBridgeBackend {
  readonly #children = new Map<string, RemoteTurnBridge>();
  #activeOperations = 0;
  #admissionOpen = true;

  get activeOperationCount(): number { return this.#activeOperations; }

  /** Service lifecycle fence, not authority to stop an already running turn. */
  closeAdmission(): void { this.#admissionOpen = false; }
  reopenAdmission(): void { this.#admissionOpen = true; }

  mount(routeId: string, bridge: RemoteTurnBridge): () => void {
    if (!/^[A-Za-z0-9]{8,32}$/.test(routeId)) throw new Error("Codex profile route id is invalid");
    if (this.#children.has(routeId)) throw new Error("Codex profile route is already mounted");
    this.#children.set(routeId, bridge);
    let mounted = true;
    return () => {
      if (!mounted) return;
      mounted = false;
      if (this.#children.get(routeId) === bridge) this.#children.delete(routeId);
    };
  }

  #bridge(capability: string): RemoteTurnBridge {
    if (!this.#admissionOpen) throw new Error("Tela Codex service tool admission is closed for maintenance");
    const route = turnCapabilityRoute(capability);
    if (!route) throw new Error("turn capability is not routed by Tela Codex");
    const bridge = this.#children.get(route);
    if (!bridge) throw new Error("turn capability belongs to an inactive Tela Codex profile runtime");
    return bridge;
  }

  async inventory(capability: string, query = "") {
    const startedAt = Date.now();
    emitDiagnosticEvent("chatgpt_tela_codex", "tool_inventory_start");
    try {
      const bridge = this.#bridge(capability);
      this.#activeOperations++;
      try {
        const tools = await bridge.inventory(capability, query);
        emitDiagnosticEvent("chatgpt_tela_codex", "tool_inventory_complete", {
          count: tools.length,
          duration_ms: diagnosticDurationMs(startedAt),
        });
        return tools;
      } finally { this.#activeOperations--; }
    } catch (error) {
      const route = turnCapabilityRoute(capability);
      emitDiagnosticEvent("chatgpt_tela_codex", "tool_inventory_failed", {
        route_present: Boolean(route),
        route_mounted: Boolean(route && this.#children.has(route)),
        duration_ms: diagnosticDurationMs(startedAt),
      });
      throw error;
    }
  }

  async invoke(capability: string, invocation: NativeToolInvocation) {
    const startedAt = Date.now();
    const requestBytes = invocation.mode === "freeform"
      ? Buffer.byteLength(invocation.input, "utf8")
      : (() => {
          try { return Buffer.byteLength(JSON.stringify(invocation.arguments), "utf8"); }
          catch { return 0; }
        })();
    emitDiagnosticEvent("chatgpt_tela_codex", "tool_invoke_start", {
      mode: invocation.mode,
      request_bytes: requestBytes,
    });
    try {
      const bridge = this.#bridge(capability);
      this.#activeOperations++;
      try {
        const result = await bridge.invoke(capability, invocation);
        emitDiagnosticEvent("chatgpt_tela_codex", "tool_invoke_complete", {
          mode: invocation.mode,
          is_error: result.isError,
          duration_ms: diagnosticDurationMs(startedAt),
          request_bytes: requestBytes,
          result_bytes: payloadBytes(result.content),
        });
        return result;
      } finally { this.#activeOperations--; }
    } catch (error) {
      emitDiagnosticEvent("chatgpt_tela_codex", "tool_invoke_failed", {
        ...diagnosticFailureFields(error), phase: "invoke",
        mode: invocation.mode,
        duration_ms: diagnosticDurationMs(startedAt),
      });
      throw error;
    }
  }

  get routeCount(): number {
    return this.#children.size;
  }
}
