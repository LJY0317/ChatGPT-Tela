import type { ServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import {
  ChatServiceClient,
  descriptorForService,
} from "@chatgpt-tela/service-protocol/client";

export type ChatDescriptorResolver = (
) => ServiceRuntimeDescriptor | undefined | Promise<ServiceRuntimeDescriptor | undefined>;

export class DynamicChatBackend {
  readonly #resolveDescriptor: ChatDescriptorResolver;

  constructor(resolveDescriptor: ChatDescriptorResolver) {
    this.#resolveDescriptor = resolveDescriptor;
  }

  async #client(): Promise<ChatServiceClient> {
    const descriptor = await this.#resolveDescriptor();
    if (!descriptor) throw new Error("Tela Chat backend is unavailable");
    return new ChatServiceClient(descriptorForService(descriptor, "chat"));
  }

  async call(capability: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
    return (await this.#client()).call(capability, arguments_);
  }

  async inventory(query = "") {
    const catalog = await (await this.#client()).capabilityCatalog();
    const needle = query.trim().toLowerCase();
    return needle
      ? Object.freeze(catalog.filter(item => item.capability.toLowerCase().includes(needle)
        || item.description.toLowerCase().includes(needle)))
      : catalog;
  }
}
