import { CONTEXT_HISTORY_TOOL, isNativeGoalTool } from "@chatgpt-tela/core";
import { randomUUID } from "node:crypto";
import type { TurnBridgeBackend } from "@chatgpt-tela/mcp";
import type { ChatCapabilityContract } from "@chatgpt-tela/service-protocol";
import type { ServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import {
  ChatServiceClient,
  descriptorForService,
} from "@chatgpt-tela/service-protocol/client";
import { dynamicBackendCall } from "./dynamic-backend-call";

const turnControls: readonly ChatCapabilityContract[] = [
  { capability: CONTEXT_HISTORY_TOOL.name, description: CONTEXT_HISTORY_TOOL.description,
    inputSchema: { ...CONTEXT_HISTORY_TOOL.inputSchema,
      required: ["history_control", ...CONTEXT_HISTORY_TOOL.inputSchema.required],
      properties: { history_control: { type: "string" }, ...CONTEXT_HISTORY_TOOL.inputSchema.properties } } },
  { capability: "goal_control_inventory", description: "Discover the original Native Goal tools for this exact task. Does not expose Native work tools.",
    inputSchema: { type: "object", required: ["goal_control"], properties: { goal_control: { type: "string" } }, additionalProperties: false } },
  { capability: "goal_control_call", description: "Call an original Native Goal tool returned by goal_control_inventory with its exact schema. Native owns the Goal and continuation lifecycle.",
    inputSchema: { type: "object", required: ["goal_control", "call_id", "wire_name", "arguments"], properties: {
      goal_control: { type: "string" }, call_id: { type: "string" }, wire_name: { type: "string" }, arguments: { type: "object" },
    }, additionalProperties: false } },
];

export type ChatDescriptorResolver = (
) => ServiceRuntimeDescriptor | undefined | Promise<ServiceRuntimeDescriptor | undefined>;

export class DynamicChatBackend {
  readonly #resolveDescriptor: ChatDescriptorResolver;

  constructor(resolveDescriptor: ChatDescriptorResolver, readonly goalBridge?: TurnBridgeBackend) {
    this.#resolveDescriptor = resolveDescriptor;
  }

  async call(capability: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.goalBridge && capability === CONTEXT_HISTORY_TOOL.name) {
      const { history_control, ...selection } = arguments_;
      if (typeof history_control !== "string") throw Error("history control capability is required");
      return this.goalBridge.invoke(history_control, { callId: randomUUID(), wireName: CONTEXT_HISTORY_TOOL.wireName,
        mode: "structured", arguments: selection });
    }
    if (this.goalBridge && (capability === "goal_control_inventory" || capability === "goal_control_call")) {
      if (typeof arguments_.goal_control !== "string") throw Error("Goal control capability is required");
      const tools = (await this.goalBridge.inventory(arguments_.goal_control)).filter(isNativeGoalTool);
      if (capability === "goal_control_inventory") return tools;
      if (typeof arguments_.call_id !== "string" || typeof arguments_.wire_name !== "string"
        || !tools.some(tool => tool.wireName === arguments_.wire_name)
        || !arguments_.arguments || typeof arguments_.arguments !== "object" || Array.isArray(arguments_.arguments)) {
        throw Error("Goal control call must match an advertised Native Goal tool");
      }
      return this.goalBridge.invoke(arguments_.goal_control, { callId: arguments_.call_id,
        wireName: arguments_.wire_name, mode: "structured", arguments: arguments_.arguments as Record<string, unknown> });
    }
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
        const catalog = [...await client.capabilityCatalog(), ...(this.goalBridge ? turnControls : [])];
        const needle = query.trim().toLowerCase();
        return needle
          ? Object.freeze(catalog.filter(item => item.capability.toLowerCase().includes(needle)
            || item.description.toLowerCase().includes(needle)))
          : catalog;
      },
    });
  }
}
