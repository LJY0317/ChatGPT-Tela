import { diagnosticFingerprint, readDiagnosticSources } from "@chatgpt-tela/core";

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
  const state = object(thread.status)?.type;
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
  const pending = last("approval_wait_transition");
  const pendingStillObserved = pending?.phase === "pending";
  const review = last("approval_manual_review_required");
  const reviewRelated = pendingStillObserved && review
    && Date.parse(review.ts) >= Date.parse(pending.ts);
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
  const reviewEvidence = pendingStillObserved ? {
    lastObservedAt: pending.ts,
    waitingSeconds: Math.max(0, Math.floor((nowMs - Date.parse(pending.ts)) / 1000)),
    reasonClass: reviewRelated ? review.reason_class ?? "provider_warning" : "unclassified",
    approvalMode: reviewRelated ? review.approval_mode ?? "unknown" : "unknown",
    stillPendingInAvailableEvents: true,
    /** A past log is not a live browser proof; never grant/replay from it. */
    currentlyVisible: "not_verified",
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
      reviewEvidence,
      recentEvents: correlated.slice(-MAX_TIMELINE).map(event => ({
        at: event.ts, stage: event.stage,
        ...(typeof event.turn_phase === "string" ? { turnPhase: event.turn_phase } : {}),
        ...(typeof event.reason_class === "string" ? { reasonClass: event.reason_class } : {}),
        ...(typeof event.phase === "string" ? { phase: event.phase } : {}),
      })),
    },
    continuation: {
      classification: reviewEvidence ? "last_observed_manual_review"
        : recentTurns[0]?.status === "inProgress" ? "in_progress_without_verified_review"
        : "no_active_turn_verified",
      nextAction: reviewEvidence ? "inspect_current_owned_approval_before_any_click"
        : "inspect_latest_turn_and_resume_only_if_explicitly_authorized",
      canAutomaticallyApproveSecurityReview: false,
      canAutomaticallyReplayAcceptedTurn: false,
    },
  });
}
