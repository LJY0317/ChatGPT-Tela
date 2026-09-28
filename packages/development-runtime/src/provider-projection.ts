import type {
  WebPhysicalContext,
  WebPhysicalContextSegment,
} from "@chatgpt-tela/chatgpt";

export const WEB_HISTORICAL_TOOL_ENTRY_TOKENS = 1_000;
export const WEB_HISTORICAL_TOOL_TOTAL_TOKENS = 10_000;
export const WEB_HISTORICAL_ASSISTANT_ENTRY_TOKENS = 5_000;
export const WEB_HISTORICAL_ASSISTANT_TOTAL_TOKENS = 20_000;

const APPROX_BYTES_PER_TOKEN = 4;
const OMITTED_TOOL_OUTPUT = "[settled tool evidence omitted from Tela Web working context]";
const OMITTED_ASSISTANT = "[settled assistant transcript omitted from Tela Web working context]";

export interface ProviderProjectionStats {
  readonly assistantRevisions: number;
  readonly truncatedAssistantRevisions: number;
  readonly omittedAssistantRevisions: number;
  readonly toolResultRevisions: number;
  readonly truncatedToolResults: number;
  readonly omittedToolResults: number;
  readonly originalRevisionBytes: number;
  readonly projectedRevisionBytes: number;
}

export interface ProviderProjectionResult {
  readonly context: WebPhysicalContext;
  readonly stats: ProviderProjectionStats;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function tokens(value: string): number {
  const length = bytes(value);
  return length === 0 ? 0 : Math.max(1, Math.ceil(length / APPROX_BYTES_PER_TOKEN));
}

function safeUtf8Prefix(buffer: Buffer, target: number): string {
  let end = Math.max(0, Math.min(target, buffer.length));
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function safeUtf8Suffix(buffer: Buffer, target: number): string {
  let start = Math.max(0, buffer.length - Math.min(target, buffer.length));
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

function truncate(value: string, tokenBudget: number): { readonly text: string; readonly truncated: boolean } {
  const byteBudget = tokenBudget * APPROX_BYTES_PER_TOKEN;
  const length = bytes(value);
  if (length <= byteBudget) return Object.freeze({ text: value, truncated: false });
  const buffer = Buffer.from(value, "utf8");
  const left = Math.floor(byteBudget / 2);
  const right = byteBudget - left;
  const removedTokens = Math.ceil((length - byteBudget) / APPROX_BYTES_PER_TOKEN);
  return Object.freeze({
    text: `${safeUtf8Prefix(buffer, left)}…${removedTokens} tokens truncated…${safeUtf8Suffix(buffer, right)}`,
    truncated: true,
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function projectToolResult(
  content: string,
  remainingTokens: number,
): { readonly content: string; readonly consumed: number; readonly truncated: boolean; readonly omitted: boolean } {
  let parsed: unknown;
  try { parsed = JSON.parse(content) as unknown; }
  catch {
    // The Native planner created tool-result revisions through stable JSON. If that invariant ever
    // changes, preserve the unknown representation rather than truncating structure blindly.
    return Object.freeze({ content, consumed: tokens(content), truncated: false, omitted: false });
  }
  const item = record(parsed);
  if (!item || item.type === "tool_search_output") {
    return Object.freeze({ content, consumed: tokens(content), truncated: false, omitted: false });
  }
  const output = item.output;
  const outputText = typeof output === "string"
    ? output
    : output === undefined
      ? ""
      : JSON.stringify(output);
  if (!outputText) {
    return Object.freeze({ content, consumed: tokens(content), truncated: false, omitted: false });
  }
  const budget = Math.max(0, Math.min(WEB_HISTORICAL_TOOL_ENTRY_TOKENS, remainingTokens));
  if (budget === 0) {
    return Object.freeze({
      content: JSON.stringify({ ...item, output: OMITTED_TOOL_OUTPUT }),
      consumed: 0,
      truncated: false,
      omitted: true,
    });
  }
  const projected = truncate(outputText, budget);
  const next = JSON.stringify({ ...item, output: projected.text });
  return Object.freeze({
    content: next,
    consumed: Math.min(budget, tokens(projected.text)),
    truncated: projected.truncated,
    omitted: false,
  });
}

function revisionSegment(
  segment: WebPhysicalContextSegment,
  content: string,
): WebPhysicalContextSegment {
  if (segment.type !== "revision") return segment;
  return Object.freeze({ ...segment, content });
}

/**
 * Create a deterministic provider-only view of old settled model/tool evidence.
 *
 * Native logical history remains authoritative and untouched. System/developer/user/steering and
 * tool-call structure are always exact. The active request is exact. Historical assistant prose
 * and tool-result payloads are considered provider presentation and are bounded newest-first.
 */
export function projectFreshWebPhysicalContext(context: WebPhysicalContext): ProviderProjectionResult {
  if (context.mode === "retained-delta") {
    return Object.freeze({
      context,
      stats: Object.freeze({
        assistantRevisions: 0,
        truncatedAssistantRevisions: 0,
        omittedAssistantRevisions: 0,
        toolResultRevisions: 0,
        truncatedToolResults: 0,
        omittedToolResults: 0,
        originalRevisionBytes: 0,
        projectedRevisionBytes: 0,
      }),
    });
  }

  const projected = [...context.segments];
  let assistantBudget = WEB_HISTORICAL_ASSISTANT_TOTAL_TOKENS;
  let toolBudget = WEB_HISTORICAL_TOOL_TOTAL_TOKENS;
  let assistantRevisions = 0;
  let truncatedAssistantRevisions = 0;
  let omittedAssistantRevisions = 0;
  let toolResultRevisions = 0;
  let truncatedToolResults = 0;
  let omittedToolResults = 0;
  let originalRevisionBytes = 0;
  let projectedRevisionBytes = 0;

  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const segment = projected[index]!;
    if (segment.type !== "revision") continue;
    originalRevisionBytes += bytes(segment.content);
    if (segment.revisionId === context.activeRequestRevisionId
      || segment.kind === "system"
      || segment.kind === "developer"
      || segment.kind === "user"
      || segment.kind === "steering"
      || segment.kind === "tool-call") {
      projectedRevisionBytes += bytes(segment.content);
      continue;
    }

    if (segment.kind === "assistant") {
      assistantRevisions += 1;
      const entryBudget = Math.max(0, Math.min(WEB_HISTORICAL_ASSISTANT_ENTRY_TOKENS, assistantBudget));
      if (entryBudget === 0) {
        projected[index] = revisionSegment(segment, OMITTED_ASSISTANT);
        projectedRevisionBytes += bytes(OMITTED_ASSISTANT);
        omittedAssistantRevisions += 1;
        continue;
      }
      const value = truncate(segment.content, entryBudget);
      projected[index] = revisionSegment(segment, value.text);
      const consumed = Math.min(entryBudget, tokens(value.text));
      assistantBudget -= consumed;
      projectedRevisionBytes += bytes(value.text);
      if (value.truncated) truncatedAssistantRevisions += 1;
      continue;
    }

    if (segment.kind === "tool-result") {
      toolResultRevisions += 1;
      const value = projectToolResult(segment.content, toolBudget);
      projected[index] = revisionSegment(segment, value.content);
      toolBudget = Math.max(0, toolBudget - value.consumed);
      projectedRevisionBytes += bytes(value.content);
      if (value.truncated) truncatedToolResults += 1;
      if (value.omitted) omittedToolResults += 1;
      continue;
    }

    projectedRevisionBytes += bytes(segment.content);
  }

  // Checkpoint text is already a derived bounded projection. Account for its transfer cost but do
  // not project it a second time.
  for (const segment of projected) {
    if (segment.type === "checkpoint") {
      originalRevisionBytes += bytes(segment.content);
      projectedRevisionBytes += bytes(segment.content);
    }
  }
  const transferTokens = projected.reduce((sum, segment) => sum + tokens(segment.content), 0);
  return Object.freeze({
    context: Object.freeze({
      ...context,
      transferTokens,
      segments: Object.freeze(projected),
    }),
    stats: Object.freeze({
      assistantRevisions,
      truncatedAssistantRevisions,
      omittedAssistantRevisions,
      toolResultRevisions,
      truncatedToolResults,
      omittedToolResults,
      originalRevisionBytes,
      projectedRevisionBytes,
    }),
  });
}
