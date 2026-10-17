import { diagnosticFingerprint } from "@chatgpt-tela/core";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_STAGE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,63}$/;
const STATUS = ["inProgress", "completed", "failed", "interrupted"] as const;
const APPROVAL = ["pending", "none", "unavailable"] as const;
const CAUSE = ["automation_unavailable", "dom_observation_failed", "bridge_preview_failed", "no_active_surface", "surface_not_selected"] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid work inspection contract");
  return value as Record<string, unknown>;
}
function time(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) throw Error("invalid work inspection timestamp");
  return new Date(value).toISOString();
}
function reason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SAFE_REASON.test(value)) throw Error("invalid work inspection reason");
  return value;
}

/** Redact and revalidate untrusted service JSON before it reaches a model.
 * Never forward native content, browser images, credentials, tool arguments or paths. */
export function parseCodexWorkInspectionContract(value: unknown, expectedSlot: number, expectedThreadId: string) {
  if (!Number.isSafeInteger(expectedSlot) || expectedSlot < 1 || expectedSlot > 99 || !ID.test(expectedThreadId)) {
    throw Error("invalid work inspection request identity");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 40 * 1024) throw Error("work inspection exceeds public projection budget");
  const doc = object(value), native = object(doc.native), diag = object(doc.diagnostics);
  const browser = object(doc.browser), host = object(doc.hostPlatformReview);
  if (doc.contractVersion !== 1 || doc.slot !== expectedSlot || doc.threadId !== expectedThreadId
    || doc.identityVerified !== true || !["active", "idle", "notLoaded"].includes(String(native.state))
    || !["paginated", "legacy"].includes(String(native.historyMode))
    || browser.scope !== "selected_profile_only" || browser.attributableToThread !== false
    || (browser.activeSurfaceCount !== null && (!Number.isSafeInteger(browser.activeSurfaceCount)
      || (browser.activeSurfaceCount as number) < 0 || (browser.activeSurfaceCount as number) > 128))
    || typeof browser.selectedSurface !== "boolean"
    || !APPROVAL.includes(browser.approvalState as typeof APPROVAL[number])
    || host.visibility !== "outside_tela_pre_ingress" || host.agentMayApprove !== false
    || browser.approvalAuthority !== "observation_only"
    || diag.fingerprint !== diagnosticFingerprint(expectedThreadId)) throw Error("work inspection identity or authority is unproven");
  if (browser.observationReason !== undefined
    && (browser.approvalState !== "unavailable" || !CAUSE.includes(browser.observationReason as typeof CAUSE[number]))) {
    throw Error("invalid browser observation reason");
  }
  if (!Array.isArray(native.recentTurns) || native.recentTurns.length > 4
    || native.recentTurns.some(item => {
      const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
      return typeof row.id !== "string" || !ID.test(row.id)
        || !STATUS.includes(row.status as typeof STATUS[number]);
    })) throw Error("invalid Native turn statuses");
  if (!Array.isArray(diag.recentEvents) || diag.recentEvents.length > 24
    || diag.recentEvents.some(item => {
      const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
      return typeof row.stage !== "string" || !SAFE_STAGE.test(row.stage)
        || time(row.at) === null;
    })) throw Error("invalid bounded diagnostic events");
  const review = diag.reviewEvidence === null ? null : object(diag.reviewEvidence);
  if (review && (typeof review.reasonClass !== "string" || !SAFE_REASON.test(review.reasonClass)
    || review.currentlyVisible !== "not_verified")) throw Error("invalid historical approval evidence");
  return Object.freeze({
    contractVersion: 1 as const,
    slot: expectedSlot, threadId: expectedThreadId, identityVerified: true as const,
    observedAt: time(doc.observedAt),
    native: Object.freeze({
      state: native.state as "active" | "idle" | "notLoaded",
      historyMode: native.historyMode as "paginated" | "legacy",
      updatedAt: time(native.updatedAt),
      recentTurns: (native.recentTurns as Record<string, unknown>[]).map(t => ({ id: t.id as string, status: t.status as string })),
    }),
    diagnostics: Object.freeze({
      scopeFingerprint: diag.fingerprint as string,
      lastObservedAt: time(diag.lastObservedAt),
      historicalApproval: review ? {
        reasonClass: review.reasonClass as string,
        lastObservedAt: time(review.lastObservedAt),
        currentlyVisible: "not_verified" as const,
      } : null,
      recentEvents: (diag.recentEvents as Record<string, unknown>[]).map(item => Object.freeze({
        at: time(item.at), stage: item.stage as string,
        ...(reason(item.reasonClass) ? { reasonClass: reason(item.reasonClass)! } : {}),
      })),
    }),
    browser: Object.freeze({
      scope: "selected_profile_only" as const,
      attributableToThread: false as const,
      activeSurfaceCount: browser.activeSurfaceCount as number | null,
      selectedSurface: browser.selectedSurface as boolean,
      approvalState: browser.approvalState as typeof APPROVAL[number],
      ...(browser.observationReason ? { observationReason: browser.observationReason as typeof CAUSE[number] } : {}),
    }),
    hostPlatformReview: Object.freeze({
      visibility: "outside_tela_pre_ingress" as const, agentMayApprove: false as const,
    }),
  });
}
