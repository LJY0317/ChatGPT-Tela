/**
 * Pure read-only inspection of Codex's generated public app-server JSON schema.
 * This is an evidence report, NEVER an execution permission or runtime feature
 * switch. It cannot prove server-side Legacy cost or effective engine behavior.
 */
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : undefined;
}
function properties(value: unknown): JsonObject {
  return object(object(value)?.properties) ?? {};
}
function definitions(value: unknown): JsonObject {
  return object(object(value)?.definitions) ?? {};
}
function methods(value: unknown): Set<string> {
  const result = new Set<string>();
  const variants = object(value)?.oneOf;
  if (!Array.isArray(variants)) throw new Error("Codex public request union is missing");
  for (const variant of variants) {
    const names = object(properties(variant).method)?.enum;
    if (!Array.isArray(names) || names.length !== 1 || typeof names[0] !== "string") {
      throw new Error("Codex public request method is malformed");
    }
    if (result.has(names[0])) throw new Error("Codex public request method is duplicated");
    result.add(names[0]);
  }
  return result;
}
function compactItemFields(threadItem: unknown): string[] {
  const variants = object(threadItem)?.oneOf;
  if (!Array.isArray(variants)) return [];
  for (const variant of variants) {
    const fields = properties(variant);
    const tag = object(fields.type)?.enum;
    if (Array.isArray(tag) && tag.length === 1 && tag[0] === "contextCompaction") {
      return Object.keys(fields).sort();
    }
  }
  return [];
}
function activeStatusFields(status: unknown): string[] {
  const variants = object(status)?.oneOf;
  if (!Array.isArray(variants)) return [];
  for (const variant of variants) {
    const fields = properties(variant);
    const tag = object(fields.type)?.enum;
    if (Array.isArray(tag) && tag.length === 1 && tag[0] === "active") {
      return Object.keys(fields).sort();
    }
  }
  return [];
}

export interface NativePublicContinuityProtocolAudit {
  readonly source: "generated_codex_app_server_experimental_schema";
  readonly methodCount: number;
  readonly observations: {
    readonly metadataOnlyThreadRead: boolean;
    readonly paginatedTurnsAndItems: boolean;
    readonly historyModes: readonly string[];
    readonly activeThreadStatusFields: readonly string[];
    readonly publicCompactionItemFields: readonly string[];
    readonly threadModelProvenance: "explicitly_not_per_turn" | "unverified";
    readonly forkToolControlFields: readonly string[];
    readonly futureProtocolCandidates: readonly string[];
  };
  readonly requirements: {
    readonly atomicCurrentTurnRevision: "not_proven";
    readonly boundedLegacyReadableContext: "not_proven";
    readonly historicalExecutedModelProvider: "not_proven";
    readonly preExecutionToolFreeFork: "not_proven";
  };
  readonly productionAutomaticHandoff: "default_deny";
}

export function auditNativePublicContinuityProtocol(input: {
  readonly requests: unknown;
  readonly threadReadParams: unknown;
  readonly threadReadResponse: unknown;
  readonly forkParams: unknown;
}): NativePublicContinuityProtocolAudit {
  const publicMethods = methods(input.requests);
  const thread = object(definitions(input.threadReadResponse).Thread);
  const mode = object(definitions(input.threadReadResponse).ThreadHistoryMode);
  const threadFields = properties(thread);
  if (!thread || !mode || !Object.hasOwn(threadFields, "historyMode")) {
    throw new Error("Codex public thread metadata contract is unavailable");
  }
  const modeValues = mode.enum;
  if (!Array.isArray(modeValues) || !modeValues.every(value => typeof value === "string")) {
    throw new Error("Codex public history modes are malformed");
  }
  const configuredModel = object(threadFields.model);
  const modelDescription = typeof configuredModel?.description === "string"
    ? configuredModel.description : "";
  const forkFields = properties(input.forkParams);
  const candidateMethods = [...publicMethods].filter(method =>
    /^(thread|turn|model)\/.*(context|compact|snapshot|checkpoint|provenance|execution|attest)/i.test(method)
    || /^attestation\//.test(method)).sort().slice(0, 24);
  return Object.freeze({
    source: "generated_codex_app_server_experimental_schema" as const,
    methodCount: publicMethods.size,
    observations: Object.freeze({
      metadataOnlyThreadRead: publicMethods.has("thread/read")
        && Object.hasOwn(properties(input.threadReadParams), "includeTurns"),
      paginatedTurnsAndItems: publicMethods.has("thread/turns/list")
        && publicMethods.has("thread/items/list"),
      historyModes: Object.freeze([...modeValues] as string[]),
      activeThreadStatusFields: Object.freeze(activeStatusFields(definitions(input.threadReadResponse).ThreadStatus)),
      publicCompactionItemFields: Object.freeze(compactItemFields(definitions(input.threadReadResponse).ThreadItem)),
      // A configured/persisted thread model is not an authenticated record
      // of the model actually executed for each historical segment.
      threadModelProvenance: /not per-turn execution telemetry/i.test(modelDescription)
        ? "explicitly_not_per_turn" as const : "unverified" as const,
      forkToolControlFields: Object.freeze(Object.keys(forkFields)
        .filter(field => /^(tool|allowedTools|disabledTools|noTools)/i.test(field)).sort()),
      futureProtocolCandidates: Object.freeze(candidateMethods),
    }),
    requirements: Object.freeze({
      // Schema fields and suggestive names do not attest atomic origin,
      // server-side resource bounds or pre-model tool suppression.
      atomicCurrentTurnRevision: "not_proven" as const,
      boundedLegacyReadableContext: "not_proven" as const,
      historicalExecutedModelProvider: "not_proven" as const,
      preExecutionToolFreeFork: "not_proven" as const,
    }),
    productionAutomaticHandoff: "default_deny" as const,
  });
}
