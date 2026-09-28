import type { NativeToolInvocation } from "@chatgpt-tela/core";
import type { RemoteTurnBridge, TurnBridgeBackend } from "@chatgpt-tela/mcp";
import { turnCapabilityRoute } from "@chatgpt-tela/runtime";

export class RoutedCodexTurnBridge implements TurnBridgeBackend {
  readonly #children = new Map<string, RemoteTurnBridge>();

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
    const route = turnCapabilityRoute(capability);
    if (!route) throw new Error("turn capability is not routed by Tela Codex");
    const bridge = this.#children.get(route);
    if (!bridge) throw new Error("turn capability belongs to an inactive Tela Codex profile runtime");
    return bridge;
  }

  inventory(capability: string, query = "") {
    return this.#bridge(capability).inventory(capability, query);
  }

  invoke(capability: string, invocation: NativeToolInvocation) {
    return this.#bridge(capability).invoke(capability, invocation);
  }

  get routeCount(): number {
    return this.#children.size;
  }
}
