import type { ServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import {
  ChatServiceClient,
  descriptorForService,
} from "@chatgpt-tela/service-protocol/client";
import { dynamicBackendCall } from "./dynamic-backend-call";

export type ChatDescriptorResolver = (
) => ServiceRuntimeDescriptor | undefined | Promise<ServiceRuntimeDescriptor | undefined>;

export class DynamicChatBackend {
  readonly #resolveDescriptor: ChatDescriptorResolver;

  constructor(resolveDescriptor: ChatDescriptorResolver) {
    this.#resolveDescriptor = resolveDescriptor;
  }

  async call(capability: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
    return dynamicBackendCall({
      service: "chat",
      resolveClient: async () => {
        const descriptor = await this.#resolveDescriptor();
        return descriptor ? new ChatServiceClient(descriptorForService(descriptor, "chat")) : undefined;
      },
      operation: client => client.call(capability, arguments_),
    });
  }

  async inventory(query = "") {
    return dynamicBackendCall({
      service: "chat",
      resolveClient: async () => {
        const descriptor = await this.#resolveDescriptor();
        return descriptor ? new ChatServiceClient(descriptorForService(descriptor, "chat")) : undefined;
      },
      operation: async client => {
        const catalog = await client.capabilityCatalog();
        const needle = query.trim().toLowerCase();
        return needle
          ? Object.freeze(catalog.filter(item => item.capability.toLowerCase().includes(needle)
            || item.description.toLowerCase().includes(needle)))
          : catalog;
      },
    });
  }
}
