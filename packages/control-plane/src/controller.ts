import {
  startCodexService,
  type CodexProfileStatus,
  type CodexService,
} from "@chatgpt-tela/codex-service";
import {
  startPublicGateway,
  type PublicGateway,
} from "@chatgpt-tela/gateway";
import {
  type TurnBridgeBackend,
} from "@chatgpt-tela/mcp";
import type { ProductControlConfig } from "./config";

export type ProductProfileStatus = CodexProfileStatus;

export interface ProductControlStatus {
  readonly publicMcp: PublicGateway["status"];
  readonly profiles: readonly ProductProfileStatus[];
}

export interface ProductControlPlane {
  readonly config: ProductControlConfig;
  readonly codex: CodexService;
  readonly gateway: PublicGateway;
  status(): Promise<ProductControlStatus>;
  startProfile(slot: number): Promise<ProductProfileStatus>;
  stopProfile(slot: number): Promise<ProductProfileStatus>;
  close(): Promise<void>;
  readonly activeProfileCount: number;
}

export async function startProductControlPlane(input: {
  readonly config: ProductControlConfig;
  readonly profileRuntimeCommand: readonly [string, ...string[]];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}): Promise<ProductControlPlane> {
  const codex = await startCodexService({
    config: input.config.multiProfile
      ? { multiProfile: input.config.multiProfile }
      : {},
    profileRuntimeCommand: input.profileRuntimeCommand,
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  let gateway: PublicGateway | undefined;
  try {
    gateway = await startPublicGateway({
      chat: {
        async inventory() { return []; },
        async call() { throw new Error("Tela Chat backend is unavailable in the legacy control-plane runtime"); },
      },
      codex: codex.tools,
      config: {
        publicUrl: input.config.exposure.publicUrl,
        localPort: input.config.exposure.localPort,
        allowUnauthenticatedPublicEndpoint: input.config.exposure.allowUnauthenticatedPublicEndpoint,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    await Promise.allSettled([codex.close()]);
    throw error;
  }

  let closing: Promise<void> | undefined;
  const ownedGateway = gateway;
  return Object.freeze({
    config: input.config,
    codex,
    gateway: ownedGateway,
    async status() {
      return Object.freeze({ publicMcp: ownedGateway.status, profiles: await codex.profiles() });
    },
    startProfile: (slot: number) => codex.startProfile(slot),
    stopProfile: (slot: number) => codex.stopProfile(slot),
    close() {
      if (closing) return closing;
      closing = (async () => {
        // Quiesce the public ingress first, then stop Codex.
        const gatewayResult = await Promise.allSettled([ownedGateway.close()]);
        const codexResult = await Promise.allSettled([codex.close()]);
        const failures = [...gatewayResult, ...codexResult]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(result => result.reason);
        if (failures.length > 0) throw new AggregateError(failures, "product control-plane shutdown was incomplete");
      })().catch(error => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
    get activeProfileCount() { return codex.activeProfileCount; },
  });
}
