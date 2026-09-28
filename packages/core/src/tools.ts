export type NativeToolKind = "function" | "freeform" | "discovery" | "gateway" | "other";

export interface NativeToolDescriptor {
  readonly wireName: string;
  readonly name: string;
  readonly namespace?: string;
  readonly kind: NativeToolKind;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

export interface NativeToolObservation {
  readonly source: string;
  readonly tools: readonly NativeToolDescriptor[];
}

export interface NativeToolCatalogEntry extends NativeToolDescriptor {
  readonly observedFrom: readonly string[];
}

export type NativeToolInvocation =
  | {
      readonly callId: string;
      readonly wireName: string;
      readonly mode: "structured";
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | {
      readonly callId: string;
      readonly wireName: string;
      readonly mode: "freeform";
      readonly input: string;
    };

export interface NativeToolResult {
  readonly callId: string;
  readonly content: unknown;
  readonly isError: boolean;
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

function sameDescriptor(left: NativeToolDescriptor, right: NativeToolDescriptor): boolean {
  return left.wireName === right.wireName
    && left.name === right.name
    && left.namespace === right.namespace
    && left.kind === right.kind
    && left.description === right.description
    && JSON.stringify(canonical(left.inputSchema ?? null)) === JSON.stringify(canonical(right.inputSchema ?? null));
}

export class NativeToolInventory {
  readonly #tools: readonly NativeToolCatalogEntry[];
  readonly #byWireName: ReadonlyMap<string, NativeToolCatalogEntry>;

  private constructor(
    readonly threadId: string,
    readonly turnId: string,
    tools: readonly NativeToolCatalogEntry[],
  ) {
    this.#tools = Object.freeze([...tools]);
    this.#byWireName = new Map(tools.map(tool => [tool.wireName, tool]));
  }

  static fromObservations(
    threadId: string,
    turnId: string,
    observations: readonly NativeToolObservation[],
  ): NativeToolInventory {
    if (!threadId.trim() || !turnId.trim()) throw new Error("native thread and turn ids must be non-empty");
    const map = new Map<string, NativeToolCatalogEntry>();

    for (const observation of observations) {
      if (!observation.source.trim()) throw new Error("tool observation source must be non-empty");
      for (const tool of observation.tools) {
        if (!tool.wireName.trim() || !tool.name.trim()) throw new Error("native tool names must be non-empty");
        const current = map.get(tool.wireName);
        if (!current) {
          map.set(tool.wireName, Object.freeze({
            ...tool,
            observedFrom: Object.freeze([observation.source]),
          }));
          continue;
        }
        if (!sameDescriptor(current, tool)) {
          throw new Error(`conflicting native tool descriptor: ${tool.wireName}`);
        }
        if (!current.observedFrom.includes(observation.source)) {
          map.set(tool.wireName, Object.freeze({
            ...current,
            observedFrom: Object.freeze([...current.observedFrom, observation.source]),
          }));
        }
      }
    }

    return new NativeToolInventory(
      threadId,
      turnId,
      [...map.values()].sort((left, right) => left.wireName.localeCompare(right.wireName)),
    );
  }

  list(): readonly NativeToolCatalogEntry[] {
    return this.#tools;
  }

  exact(wireName: string): NativeToolCatalogEntry | undefined {
    return this.#byWireName.get(wireName);
  }

  search(query: string): readonly NativeToolCatalogEntry[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return this.list();
    return Object.freeze(this.#tools.filter(tool => [
      tool.wireName,
      tool.name,
      tool.namespace ?? "",
      tool.description,
      tool.kind,
    ].join("\n").toLowerCase().includes(needle)));
  }
}
