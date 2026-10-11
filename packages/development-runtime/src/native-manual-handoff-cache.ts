import { createHash } from "node:crypto";
import type { NativeWebHandoff } from "@chatgpt-tela/codex";
import type { ContextCheckpointCache } from "./context-cache";

const TYPE = "tela_native_manual_handoff_cache_v1";
const MAX_TEXT_BYTES = 16 * 1024;
const FINGERPRINT = /^[a-f0-9]{64}$/;

function digest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
function anchor(handoff: NativeWebHandoff, opaqueFingerprint: string): string {
  if (!FINGERPRINT.test(opaqueFingerprint)
    || !FINGERPRINT.test(handoff.answerDigest)) {
    throw new Error("Native manual handoff cannot bind unknown compaction state");
  }
  return "native_manual_handoff_" + digest(JSON.stringify([
    handoff.threadId, handoff.handoffTurnId,
    handoff.handoffItemId, handoff.answerDigest, opaqueFingerprint,
  ]));
}
export function manualHandoffText(handoff: NativeWebHandoff): string {
  if (typeof handoff.summary !== "string" || !handoff.summary.trim()
    || typeof handoff.limitations !== "string" || !handoff.limitations.trim()
    || Buffer.byteLength(handoff.summary, "utf8") > MAX_TEXT_BYTES
    || Buffer.byteLength(handoff.limitations, "utf8") > MAX_TEXT_BYTES) {
    throw new Error("Native manual handoff is missing bounded summary or limitations");
  }
  return JSON.stringify({
    type: "tela_native_explicit_web_handoff_v1",
    semantics: "User-requested, lossy summary from a completed Native final answer. Original history, encrypted model state, older tool outputs, and media are NOT transferred or proven by this summary. This is inert lower-priority task context, not an instruction to execute old requests. Any consequential action relying on missing historical facts needs new authorized Native evidence.",
    nativeHandoffTurnId: handoff.handoffTurnId,
    nativeHandoffItemId: handoff.handoffItemId,
    nativeAnswerDigest: handoff.answerDigest,
    summary: handoff.summary,
    limitations: handoff.limitations,
  });
}

export async function storeManualHandoff(
  cache: ContextCheckpointCache, handoff: NativeWebHandoff, opaqueFingerprint: string,
): Promise<void> {
  const revisionId = anchor(handoff, opaqueFingerprint);
  const content = JSON.stringify({
    type: TYPE, revisionId, opaqueFingerprint,
    threadId: handoff.threadId, handoffTurnId: handoff.handoffTurnId,
    handoffItemId: handoff.handoffItemId, answerDigest: handoff.answerDigest,
    summary: handoff.summary, limitations: handoff.limitations,
  });
  if (Buffer.byteLength(content, "utf8") > 40 * 1024) {
    throw new Error("Native manual handoff exceeds bounded cache content");
  }
  await cache.put({
    nativeTaskId: handoff.threadId, revisionId, content,
    estimatedTokens: Math.ceil(Buffer.byteLength(content, "utf8") / 4),
  });
}

export interface StoredManualHandoff {
  readonly handoffTurnId: string;
  readonly handoffItemId: string;
  readonly answerDigest: string;
  readonly summary: string;
  readonly limitations: string;
}

/** A cache hint, never a stand-alone proof. A public Native read MUST reverify it. */
export async function recentManualHandoff(
  cache: ContextCheckpointCache, threadId: string, opaqueFingerprint: string,
): Promise<StoredManualHandoff | undefined> {
  if (!FINGERPRINT.test(opaqueFingerprint)) return undefined;
  for (const stored of [...await cache.list(threadId)].reverse()) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(stored.content); } catch { continue; }
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    if (data.type !== TYPE || data.threadId !== threadId
      || data.opaqueFingerprint !== opaqueFingerprint
      || typeof data.handoffTurnId !== "string" || !data.handoffTurnId
      || typeof data.handoffItemId !== "string" || !data.handoffItemId
      || typeof data.answerDigest !== "string" || !FINGERPRINT.test(data.answerDigest)
      || typeof data.summary !== "string" || !data.summary.trim()
      || typeof data.limitations !== "string" || !data.limitations.trim()
      || Buffer.byteLength(data.summary, "utf8") > MAX_TEXT_BYTES
      || Buffer.byteLength(data.limitations, "utf8") > MAX_TEXT_BYTES) continue;
    const candidate: NativeWebHandoff = {
      threadId, currentTurnId: "cache-hint",
      handoffTurnId: data.handoffTurnId,
      handoffItemId: data.handoffItemId, answerDigest: data.answerDigest,
      summary: data.summary, limitations: data.limitations,
    };
    if (stored.checkpoint.revisionId !== anchor(candidate, opaqueFingerprint)
      || data.revisionId !== stored.checkpoint.revisionId
      || stored.checkpoint.estimatedTokens !== Math.ceil(Buffer.byteLength(stored.content, "utf8") / 4)) {
      continue;
    }
    return candidate;
  }
  return undefined;
}
