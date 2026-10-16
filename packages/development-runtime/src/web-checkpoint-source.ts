import {
  chatGptWebCheckpointSourceTokenLimit,
  chatGptCheckpointInputTokens,
  type ChatGptWebEffort,
  type WebPhysicalContext,
  type WebTurnMedia,
} from "@chatgpt-tela/chatgpt";

/**
 * The same bounded input contract applies to every Web-based checkpoint and
 * Native local compaction summarizer. This is independent of both Native's
 * logical token count and the provider's cached prompt prefix.
 *
 * A false fit is not permission to omit original user/developer/tool evidence.
 * The caller must request a verified checkpoint, recover original evidence,
 * or decline the operation rather than silently shorten its source.
 */
export function boundedWebCheckpointSource(
  physicalContext: WebPhysicalContext,
  media: readonly WebTurnMedia[],
  effort: ChatGptWebEffort,
): WebPhysicalContext | undefined {
  const transferTokens = Math.max(physicalContext.transferTokens, chatGptCheckpointInputTokens(physicalContext, media));
  if (!Number.isSafeInteger(transferTokens) || transferTokens < 0
    || transferTokens > chatGptWebCheckpointSourceTokenLimit(effort)) {
    return undefined;
  }
  return Object.freeze({ ...physicalContext, transferTokens });
}
