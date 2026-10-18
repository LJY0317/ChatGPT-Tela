import { diagnosticFingerprint } from "./diagnostic-events";
import { readDiagnosticSources } from "./diagnostic-store";

const THREAD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TURN_STATUS = new Set(["inProgress", "completed", "failed", "interrupted"]);
const MAX_TURNS = 4;
const MAX_TIMELINE = 24;

type Json = Record<string, unknown>;
type ThreadReader = {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
};

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json : undefined;
}

/** The only entry for reading an exact, owner-selected Native conversation.
 * All reads use public metadata and bounded structural diagnostics; never
 * includeTurns=true, raw message bodies, UI actions, or turn starts. */
export async function inspectNativeThread(input: {
  readonly rpc: ThreadReader;
  readonly threadId: string;
  readonly slot: number;
  readonly diagnosticPaths: readonly string[];
  readonly minutes?: number;
  readonly nowMs?: number;
}) {
  const { threadId, slot, rpc } = input;
  if (!THREAD_ID.test(threadId)) throw new Error("thread inspect requires an exact Native UUID");
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("invalid profile slot");
  const minutes = input.minutes ?? 30;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) {
    throw new Error("--minutes must be an integer from 1 to 120");
  }
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("invalid observation time");

  const metadata = object(await rpc.request("thread/read", {
    threadId, includeTurns: false,
  }, AbortSignal.timeout(10_000)));
  const thread = object(metadata?.thread);
  if (!thread || thread.id !== threadId) {
    throw new Error("the requested Native conversation is not owned by this profile");
  }
  // Supported Native builds expose thread/read.status as either a public
  // discriminated object or the same finite string enum. Keep exact owner,
  // history, turn-metadata and status validation unchanged across both.
  const state = typeof thread.status === "string"
    ? thread.status : object(thread.status)?.type;
  if (!["active", "idle", "notLoaded"].includes(String(state))) {
    throw new Error("Native conversation status is not proven");
  }
  const historyMode = thread.historyMode;
  if (historyMode !== "paginated" && historyMode !== "legacy") {
    throw new Error("Native history indexing capability is unknown");
  }
  const updatedAt = typeof thread.updatedAt === "number"
    && Number.isSafeInteger(thread.updatedAt) && thread.updatedAt > 0
    ? new Date(thread.updatedAt * 1000).toISOString()
    : null;

  let recentTurns: readonly { id: string; status: string }[] = [];
  if (historyMode === "paginated") {
    const page = object(await rpc.request("thread/turns/list", {
      threadId, sortDirection: "desc", itemsView: "notLoaded", limit: MAX_TURNS,
    }, AbortSignal.timeout(10_000)));
    const rows = page?.data;
    if (!Array.isArray(rows) || rows.length > MAX_TURNS
      || Buffer.byteLength(JSON.stringify(page), "utf8") > 8 * 1024) {
      throw new Error("Native latest-turn metadata is not bounded");
    }
    recentTurns = Object.freeze(rows.map(value => {
      const row = object(value);
      if (!row || typeof row.id !== "string" || !THREAD_ID.test(row.id)
        || !TURN_STATUS.has(String(row.status)) || row.itemsView !== "notLoaded"
        || !Array.isArray(row.items) || row.items.length !== 0) {
        throw new Error("Native latest-turn metadata does not match the public contract");
      }
      return Object.freeze({ id: row.id, status: row.status as string });
    }));
  }

  const fingerprint = diagnosticFingerprint(threadId);
  const logs = readDiagnosticSources(input.diagnosticPaths, {
    fromMs: nowMs - minutes * 60_000,
    toMs: nowMs,
  });
  const correlated = logs.events.filter(event => event.scope_fingerprint === fingerprint
    && (event.event === "chatgpt_tela_work" || event.event === "chatgpt_tela_codex"));
  const last = (stage: string) => correlated.filter(event => event.stage === stage).at(-1);
  const lastPlan = last("web_turn_plan");
  const lastObserved = correlated.at(-1);
  const coverage = {
    sourcesRead: logs.coverage.filter(item => item.state === "read").length,
    sourcesUnavailable: logs.coverage.filter(item => item.state !== "read").length,
    limited: logs.sourceLimitReached || logs.coverage.some(item =>
      item.truncated || item.eventLimitReached),
    eventsMatched: correlated.length,
  };
  const lastWebPlan = lastPlan ? {
    observedAt: lastPlan.ts,
    ...(typeof lastPlan.transfer_estimate === "number" ? { transferEstimate: lastPlan.transfer_estimate } : {}),
    ...(typeof lastPlan.retained_surface === "boolean" ? { retainedSurface: lastPlan.retained_surface } : {}),
    ...(typeof lastPlan.retained_delta === "boolean" ? { retainedDelta: lastPlan.retained_delta } : {}),
  } : null;
  return Object.freeze({
    contractVersion: 1,
    privacy: "read-only-metadata-and-structural-diagnostics",
    threadId, slot, identityVerified: true,
    native: { state, historyMode, updatedAt, recentTurns },
    diagnostics: {
      windowMinutes: minutes,
      fingerprint,
      coverage,
      lastObservedAt: lastObserved?.ts ?? null,
      lastWebPlan,
      recentEvents: correlated.slice(-MAX_TIMELINE).map(event => ({
        at: event.ts, stage: event.stage,
        ...(typeof event.turn_phase === "string" ? { turnPhase: event.turn_phase } : {}),
        ...(typeof event.reason_class === "string" ? { reasonClass: event.reason_class } : {}),
        ...(typeof event.phase === "string" ? { phase: event.phase } : {}),
      })),
    },
    continuation: {
      classification: recentTurns[0]?.status === "inProgress"
        ? "in_progress"
        : "no_active_turn_verified",
      nextAction: "inspect_latest_turn",
      canAutomaticallyReplayAcceptedTurn: false,
    },
  });
}

/**
 * Read-only evidence for a known Native UUID even when its owning profile is
 * stopped, orphaned, or the current Codex metadata schema cannot be proven.
 * This is deliberately NOT a Native thread inspection, an ownership lease,
 * a live browser observation, or permission to resume/replay/approve.
 */
export function inspectNativeThreadHistoricalEvidence(input: {
  readonly threadId: string;
  readonly diagnosticPaths: readonly string[];
  readonly minutes?: number;
  readonly nowMs?: number;
}) {
  if (!THREAD_ID.test(input.threadId)) throw new Error("historical evidence requires an exact Native UUID");
  const minutes = input.minutes ?? 30;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 360) {
    throw new Error("--minutes must be an integer from 1 to 360");
  }
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("invalid observation time");
  const fingerprint = diagnosticFingerprint(input.threadId);
  const logs = readDiagnosticSources(input.diagnosticPaths, {
    fromMs: nowMs - minutes * 60_000, toMs: nowMs,
  });
  const events = logs.events.filter(event => event.scope_fingerprint === fingerprint
    && ["chatgpt_tela_work", "chatgpt_tela_codex", "chatgpt_tela_browser"].includes(event.event));
  const last = (stage: string) => events.filter(event => event.stage === stage).at(-1);
  const lastNativeFailure = events.filter(event =>
    ["native_execution_failed", "web_turn_identity_rejected"].includes(event.stage)).at(-1);
  const lastTerminal = events.filter(event =>
    ["native_execution_failed", "native_turn_retired", "native_outcome_committed", "web_turn_failed"]
      .includes(event.stage)).at(-1);
  const observedUntil = events.at(-1)?.ts ?? null;
  // Correlation is deliberately time- and thread-scoped, not an assertion of
  // causation or an authoritative Native turn identity. The original accepted
  // operation may already have produced effects; no retry may follow from it.
  const rejected = last("web_turn_identity_rejected");
  const rejectionAt = rejected ? Date.parse(rejected.ts) : Number.NaN;
  const preceding = (stage: string, withinMs: number) => events.filter(event =>
    event.stage === stage && Number.isFinite(rejectionAt)
    && Date.parse(event.ts) <= rejectionAt
    && rejectionAt - Date.parse(event.ts) <= withinMs).at(-1);
  const rendererPause = preceding("renderer_unresponsive", 30_000);
  const revoked = preceding("inspection_ownership_revoked", 10_000);
  const classified = preceding("inspection_input_classified", 10_000);
  const nativeFailureFollowingRejection = events.some(event => event.stage === "native_execution_failed"
    && Number.isFinite(rejectionAt) && Date.parse(event.ts) >= rejectionAt
    && Date.parse(event.ts) - rejectionAt <= 30_000);
  return Object.freeze({
    contractVersion: 1 as const,
    privacy: "allowlisted-structural-events-only" as const,
    threadId: input.threadId,
    scopeFingerprint: fingerprint,
    identityVerified: false as const,
    contentRead: false as const,
    mutating: false as const,
    coverage: {
      sourcesRead: logs.coverage.filter(item => item.state === "read").length,
      sourcesUnavailable: logs.coverage.filter(item => item.state !== "read").length,
      limited: logs.sourceLimitReached || logs.coverage.some(item => item.truncated || item.eventLimitReached),
      eventsMatched: events.length,
    },
    lastObservedAt: observedUntil,
    lastNativeOutcome: lastTerminal
      ? { at: lastTerminal.ts, stage: lastTerminal.stage,
        ...(typeof lastTerminal.reason_class === "string" ? { reasonClass: lastTerminal.reason_class } : {}) }
      : null,
    lastNativeFailure: lastNativeFailure
      ? { at: lastNativeFailure.ts, stage: lastNativeFailure.stage,
        ...(typeof lastNativeFailure.reason_class === "string" ? { reasonClass: lastNativeFailure.reason_class } : {}) }
      : null,
    recentEvents: events.slice(-MAX_TIMELINE).map(event => ({
      at: event.ts, stage: event.stage,
      ...(typeof event.reason_class === "string" ? { reasonClass: event.reason_class } : {}),
      ...(typeof event.phase === "string" ? { phase: event.phase } : {}),
      ...(typeof event.manual_consent === "boolean" ? { manualConsent: event.manual_consent } : {}),
    })),
    continuation: {
      canAutomaticallyReplayAcceptedTurn: false as const,
      nextAction: "inspect_latest_turn" as const,
    },
  });
}
