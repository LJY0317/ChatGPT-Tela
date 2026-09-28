import type { NativeToolInvocation, NativeToolResult } from "@chatgpt-tela/core";
import type { TurnBridgeBackend } from "@chatgpt-tela/mcp";
import {
  type ServiceRuntimeDescriptor,
} from "@chatgpt-tela/service-protocol";
import {
  CodexServiceClient,
  descriptorForService,
} from "@chatgpt-tela/service-protocol/client";
import { dynamicBackendCall } from "./dynamic-backend-call";

export type CodexDescriptorResolver = (
) => ServiceRuntimeDescriptor | undefined | Promise<ServiceRuntimeDescriptor | undefined>;

export class DynamicCodexTurnBridge implements TurnBridgeBackend {
  readonly #resolveDescriptor: CodexDescriptorResolver;

  constructor(resolveDescriptor: CodexDescriptorResolver) {
    this.#resolveDescriptor = resolveDescriptor;
  }

  async inventory(capability: string, query = "") {
    return dynamicBackendCall({
      service: "codex",
      resolveClient: async () => {
        const descriptor = await this.#resolveDescriptor();
        return descriptor ? new CodexServiceClient(descriptorForService(descriptor, "codex")) : undefined;
      },
      operation: client => client.inventory(capability, query),
    });
  }

  async invoke(capability: string, invocation: NativeToolInvocation): Promise<NativeToolResult> {
    return dynamicBackendCall({
      service: "codex",
      resolveClient: async () => {
        const descriptor = await this.#resolveDescriptor();
        return descriptor ? new CodexServiceClient(descriptorForService(descriptor, "codex")) : undefined;
      },
      operation: client => client.invoke(capability, invocation),
    });
  }
}
