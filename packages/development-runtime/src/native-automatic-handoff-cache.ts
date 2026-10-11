import { createHash } from "node:crypto";
import {
  automaticNativeHandoffText,
  parseStructuredNativeHandoff,
  type AutomaticNativeHandoff,
} from "@chatgpt-tela/codex";
import type { ContextCheckpointCache } from "./context-cache";

const TYPE = "tela_native_automatic_handoff_cache_v1";
const FINGERPRINT = /^[a-f0-9]{64}$/;
const PREFIX = "native_automatic_handoff_v1_";
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function revisionId(handoff: Pick<AutomaticNativeHandoff, "threadId" | "sourceTurnId">,
  fingerprint: string): string {
  return PREFIX + digest(JSON.stringify([handoff.threadId, handoff.sourceTurnId, fingerprint]));
}

/** The cache is a lower-priority summary, never current Native tool authority. */
export async function storeAutomaticNativeHandoff(
  cache: ContextCheckpointCache, handoff: AutomaticNativeHandoff, fingerprint: string,
): Promise<void> {
  if (!FINGERPRINT.test(fingerprint)
    || !FINGERPRINT.test(handoff.answerDigest)
    || digest(handoff.content) !== handoff.answerDigest) {
    throw new Error("Automatic Native handoff cache cannot bind opaque source");
  }
  automaticNativeHandoffText(handoff);
  const revision = revisionId(handoff, fingerprint);
  const content = JSON.stringify({
    type: TYPE, revisionId: revision, opaqueFingerprint: fingerprint,
    threadId: handoff.threadId, sourceTurnId: handoff.sourceTurnId,
    answerDigest: handoff.answerDigest, content: handoff.content,
  });
  if (Buffer.byteLength(content, "utf8") > 32 * 1024) {
    throw new Error("Automatic Native handoff is too large for its private derived cache");
  }
  await cache.put({
    nativeTaskId: handoff.threadId, revisionId: revision,
    content, estimatedTokens: Math.ceil(Buffer.byteLength(content, "utf8") / 4),
  });
}

/** Integrity-checked candidate only; the caller must reverify public source ancestry. */
export async function recentAutomaticNativeHandoff(
  cache: ContextCheckpointCache, threadId: string, fingerprint: string,
): Promise<AutomaticNativeHandoff | undefined> {
  if (!FINGERPRINT.test(fingerprint)) return undefined;
  for (const cached of [...await cache.list(threadId)].reverse()) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(cached.content); } catch { continue; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)
      || obj.type !== TYPE || obj.threadId !== threadId
      || obj.opaqueFingerprint !== fingerprint
      || typeof obj.sourceTurnId !== "string" || !obj.sourceTurnId.trim()
      || obj.sourceTurnId.length > 512
      || typeof obj.content !== "string"
      || typeof obj.answerDigest !== "string"
      || !FINGERPRINT.test(obj.answerDigest)
      || digest(obj.content) !== obj.answerDigest) continue;
    const handoff: AutomaticNativeHandoff = {
      threadId, currentTurnId: "cache-hint", sourceTurnId: obj.sourceTurnId,
      answerDigest: obj.answerDigest, content: obj.content,
    };
    if (cached.checkpoint.revisionId !== revisionId(handoff, fingerprint)
      || obj.revisionId !== cached.checkpoint.revisionId
      || cached.checkpoint.estimatedTokens !== Math.ceil(Buffer.byteLength(cached.content, "utf8") / 4)) {
      continue;
    }
    try {
      parseStructuredNativeHandoff(handoff.content);
      automaticNativeHandoffText(handoff);
      return handoff;
    } catch { continue; }
  }
  return undefined;
}
