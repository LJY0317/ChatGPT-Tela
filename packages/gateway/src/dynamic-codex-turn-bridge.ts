import type { NativeToolInvocation, NativeToolResult } from "@chatgpt-tela/core";
import type { TurnBridgeBackend } from "@chatgpt-tela/mcp";
import {
  type ServiceRuntimeDescriptor,
} from "@chatgpt-tela/service-protocol";
import {
  CodexServiceClient,
  descriptorForService,
} from "@chatgpt-tela/service-protocol/client";

export type CodexDescriptorResolver = (
) => ServiceRuntimeDescriptor | undefined | Promise<ServiceRuntimeDescriptor | undefined>;

export class DynamicCodexTurnBridge implements TurnBridgeBackend {
  readonly #resolveDescriptor: CodexDescriptorResolver;

  constructor(resolveDescriptor: CodexDescriptorResolver) {
    this.#resolveDescriptor = resolveDescriptor;
  }

  async #client(): Promise<CodexServiceClient> {
    const descriptor = await this.#resolveDescriptor();
    if (!descriptor) throw new Error("Tela Codex backend is unavailable");
    return new CodexServiceClient(descriptorForService(descriptor, "codex"));
  }

  async inventory(capability: string, query = "") {
    return (await this.#client()).inventory(capability, query);
  }

  async invoke(capability: string, invocation: NativeToolInvocation): Promise<NativeToolResult> {
    return (await this.#client()).invoke(capability, invocation);
  }
}
