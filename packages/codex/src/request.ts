import type {
  NativeToolDescriptor,
  NativeToolObservation,
} from "@chatgpt-tela/core";

export interface NativeTurnClaim {
  readonly threadId: string;
  readonly turnId: string;
  readonly requestKind: "turn";
  readonly parentThreadId?: string;
  readonly agentName?: string;
  readonly subagentKind?: string;
  readonly toolObservations: readonly NativeToolObservation[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`native Codex request is missing ${field}`);
  }
  const normalized = value.trim();
  if (normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`native Codex request has invalid ${field}`);
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function turnMetadata(body: Record<string, unknown>): Record<string, unknown> {
  const clientMetadata = record(body.client_metadata);
  const raw = clientMetadata?.["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try {
      const parsed = record(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      // Use one stable fail-closed error for malformed metadata.
    }
    throw new Error("native Codex turn metadata is invalid JSON");
  }
  const parsed = record(raw);
  if (!parsed) throw new Error("native Codex request is missing turn metadata");
  return parsed;
}

function schemaFrom(spec: Record<string, unknown>): Readonly<Record<string, unknown>> | undefined {
  return record(spec.parameters) ?? record(spec.input_schema);
}

function wireName(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}__${name}` : name;
}

function descriptor(
  spec: Record<string, unknown>,
  kind: NativeToolDescriptor["kind"],
  namespace?: string,
  fallbackName?: string,
): NativeToolDescriptor | undefined {
  const name = optionalString(spec.name) ?? fallbackName;
  if (!name) return undefined;
  const inputSchema = schemaFrom(spec);
  return Object.freeze({
    wireName: wireName(namespace, name),
    name,
    ...(namespace ? { namespace } : {}),
    kind,
    description: typeof spec.description === "string" ? spec.description : "",
    ...(inputSchema ? { inputSchema: Object.freeze({ ...inputSchema }) } : {}),
  });
}

function toolsFromSpecs(specs: readonly unknown[]): readonly NativeToolDescriptor[] {
  const tools: NativeToolDescriptor[] = [];

  for (const value of specs) {
    const spec = record(value);
    if (!spec) continue;
    const type = optionalString(spec.type);

    if (type === "function") {
      const tool = descriptor(spec, "function");
      if (tool) tools.push(tool);
      continue;
    }

    if (type === "custom") {
      const tool = descriptor(spec, "freeform");
      if (tool) tools.push(tool);
      continue;
    }

    if (type === "tool_search") {
      const tool = descriptor(spec, "discovery", undefined, "tool_search");
      if (tool) tools.push(tool);
      continue;
    }

    if (type === "namespace" && Array.isArray(spec.tools)) {
      const rawNamespace = optionalString(spec.name);
      const namespace = rawNamespace === "functions" ? undefined : rawNamespace;
      for (const nestedValue of spec.tools) {
        const nested = record(nestedValue);
        if (!nested) continue;
        const nestedType = optionalString(nested.type);
        const tool = nestedType === "function"
          ? descriptor(nested, "function", namespace)
          : nestedType === "custom" && namespace === undefined
            ? descriptor(nested, "freeform")
            : undefined;
        if (tool) tools.push(tool);
      }
      continue;
    }

    // Preserve future named client-side tool shapes as observations. Invocation code must still
    // opt into their semantics explicitly because kind=other carries no function-call guarantee.
    const tool = descriptor(spec, "other");
    if (tool) tools.push(tool);
  }

  return Object.freeze(tools);
}

function toolObservations(body: Record<string, unknown>): readonly NativeToolObservation[] {
  const observations: NativeToolObservation[] = [];

  if (Array.isArray(body.tools)) {
    observations.push(Object.freeze({
      source: "request.body.tools",
      tools: toolsFromSpecs(body.tools),
    }));
  }

  if (Array.isArray(body.input)) {
    for (const [index, value] of body.input.entries()) {
      const item = record(value);
      if (!item || !Array.isArray(item.tools)) continue;
      if (item.type === "additional_tools") {
        observations.push(Object.freeze({
          source: `request.input.additional_tools:${index}`,
          tools: toolsFromSpecs(item.tools),
        }));
      } else if (item.type === "tool_search_output") {
        observations.push(Object.freeze({
          source: `request.input.tool_search_output:${index}`,
          tools: toolsFromSpecs(item.tools),
        }));
      }
    }
  }

  return Object.freeze(observations);
}

/**
 * Parse current-turn identity and native tool advertisements from a Codex Responses request.
 *
 * Filesystem, workspace, and sandbox fields in request metadata are intentionally not interpreted
 * as authority. They may become consistency claims later, but only canonical Native state can
 * create filesystem/tool execution authority.
 */
export function parseNativeTurnClaim(value: unknown): NativeTurnClaim {
  const body = record(value);
  if (!body) throw new Error("native Codex request body must be an object");
  const metadata = turnMetadata(body);
  if (metadata.request_kind !== "turn") {
    throw new Error("native Codex request is not a current turn");
  }

  const threadId = requiredIdentifier(metadata.thread_id, "thread_id");
  const turnId = requiredIdentifier(metadata.turn_id, "turn_id");
  const parentThreadId = optionalString(metadata.parent_thread_id);
  const agentName = optionalString(metadata.agent_name);
  const subagentKind = optionalString(metadata.subagent_kind);

  return Object.freeze({
    threadId,
    turnId,
    requestKind: "turn" as const,
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(agentName ? { agentName } : {}),
    ...(subagentKind ? { subagentKind } : {}),
    toolObservations: toolObservations(body),
  });
}
