import { createHash } from "node:crypto";

export interface McpToolContract {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ConnectorAbi {
  readonly generation: number;
  readonly displayName: string;
  readonly schemaFingerprint: string;
  readonly tools: readonly McpToolContract[];
}

export function fingerprintMcpToolContracts(tools: readonly McpToolContract[]): string {
  const normalized = [...tools]
    .map(tool => Object.freeze({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const duplicate = normalized.find((tool, index) => index > 0 && normalized[index - 1]?.name === tool.name);
  if (duplicate) throw new Error(`duplicate MCP tool contract: ${duplicate.name}`);
  return createHash("sha256")
    .update(JSON.stringify(canonical(normalized)))
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function defineConnectorAbi(input: {
  readonly generation: number;
  readonly displayName: string;
  readonly tools: readonly McpToolContract[];
}): ConnectorAbi {
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("connector ABI generation must be a positive safe integer");
  }
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error("connector ABI displayName is required");
  const tools = [...input.tools].sort((left, right) => left.name.localeCompare(right.name));
  const schemaFingerprint = fingerprintMcpToolContracts(tools);
  return Object.freeze({
    generation: input.generation,
    displayName,
    schemaFingerprint,
    tools: Object.freeze(tools.map(tool => Object.freeze({ ...tool }))),
  });
}

export function assertConnectorAbiIdentityStable(previous: ConnectorAbi, next: ConnectorAbi): void {
  if (previous.displayName === next.displayName && previous.schemaFingerprint !== next.schemaFingerprint) {
    throw new Error(`connector ${JSON.stringify(next.displayName)} cannot change its public MCP ABI in place`);
  }
}
