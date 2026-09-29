import { existsSync, lstatSync, readFileSync } from "node:fs";

interface DiagnosticEvent {
  readonly ts?: unknown;
  readonly event?: unknown;
  readonly stage?: unknown;
  readonly context_mode?: unknown;
  readonly retained_surface?: unknown;
  readonly retained_delta?: unknown;
  readonly physical_rollover?: unknown;
  readonly logical_tokens?: unknown;
  readonly transfer_tokens?: unknown;
  readonly epoch_estimated_input_tokens?: unknown;
  readonly epoch_rollover_token_limit?: unknown;
  readonly previous_epoch_estimated_input_tokens?: unknown;
  readonly previous_epoch_rollover_token_limit?: unknown;
}

function eventTime(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function readEvents(path: string): DiagnosticEvent[] {
  if (!existsSync(path)) return [];
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) return [];
    return readFileSync(path, "utf8").split("\n").flatMap(line => {
      if (!line.trim()) return [];
      try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === "object" && !Array.isArray(value)
          ? [value as DiagnosticEvent]
          : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/**
 * Passive live canary for retained Web context.
 *
 * It never opens a browser, submits a prompt, or reads prompt/tool content. It inspects only the
 * bounded structural `web_turn_plan` diagnostics emitted by real Work turns. Therefore a PASS is
 * evidence that an actual product turn reused the existing browser epoch and transmitted an exact
 * retained delta; absence is merely "not observed", not proof that retention is broken.
 */
export function summarizeRetentionCanary(input: {
  readonly paths: readonly string[];
  readonly minutes?: number;
  readonly nowMs?: number;
}): Readonly<Record<string, unknown>> {
  const minutes = input.minutes ?? 15;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) {
    throw new Error("retention-canary --minutes must be an integer from 1 to 120");
  }
  const nowMs = input.nowMs ?? Date.now();
  const fromMs = nowMs - minutes * 60_000;
  let scanned = 0;
  let workPlans = 0;
  let freshPlans = 0;
  let retainedPlans = 0;
  let retainedSurfacePlans = 0;
  let provenRetainedPlans = 0;
  let physicalRollovers = 0;
  let latestMs = 0;
  let latestProofMs = 0;
  let maxLogicalTokens = 0;
  let maxTransferTokens = 0;
  let minRetainedTransferTokens: number | undefined;
  let maxRetainedLogicalTokens = 0;
  let latestRolloverPressure: Readonly<Record<string, number>> | undefined;

  for (const path of new Set(input.paths)) {
    for (const item of readEvents(path)) {
      scanned += 1;
      const ts = eventTime(item.ts);
      if (ts === undefined || ts < fromMs || ts > nowMs + 60_000) continue;
      if (item.event !== "chatgpt_tela_work" || item.stage !== "web_turn_plan") continue;
      workPlans += 1;
      latestMs = Math.max(latestMs, ts);
      const logical = safeInteger(item.logical_tokens);
      const transfer = safeInteger(item.transfer_tokens);
      if (logical !== undefined) maxLogicalTokens = Math.max(maxLogicalTokens, logical);
      if (transfer !== undefined) maxTransferTokens = Math.max(maxTransferTokens, transfer);
      const retainedDelta = item.context_mode === "retained-delta" || item.retained_delta === true;
      if (retainedDelta) {
        retainedPlans += 1;
        if (logical !== undefined) maxRetainedLogicalTokens = Math.max(maxRetainedLogicalTokens, logical);
        if (transfer !== undefined) {
          minRetainedTransferTokens = minRetainedTransferTokens === undefined
            ? transfer
            : Math.min(minRetainedTransferTokens, transfer);
        }
      } else {
        freshPlans += 1;
      }
      if (item.retained_surface === true) retainedSurfacePlans += 1;
      if (retainedDelta && item.retained_surface === true) {
        provenRetainedPlans += 1;
        latestProofMs = Math.max(latestProofMs, ts);
      }
      if (item.physical_rollover === true) {
        physicalRollovers += 1;
        const estimated = safeInteger(item.previous_epoch_estimated_input_tokens)
          ?? safeInteger(item.epoch_estimated_input_tokens);
        const limit = safeInteger(item.previous_epoch_rollover_token_limit)
          ?? safeInteger(item.epoch_rollover_token_limit);
        if (estimated !== undefined && limit !== undefined) {
          latestRolloverPressure = Object.freeze({ estimatedTokens: estimated, rolloverLimitTokens: limit });
        }
      }
    }
  }

  const status = provenRetainedPlans > 0 ? "pass" : "not-observed";
  return Object.freeze({
    status,
    privacy: "structural-retention-diagnostics-only",
    contentRead: false,
    pathsEmitted: false,
    mutating: false,
    window: Object.freeze({
      minutes,
      from: new Date(fromMs).toISOString(),
      to: new Date(nowMs).toISOString(),
    }),
    evidence: Object.freeze({
      scannedEvents: scanned,
      workTurnPlans: workPlans,
      freshPlans,
      retainedDeltaPlans: retainedPlans,
      retainedSurfacePlans,
      provenRetainedPlans,
      physicalRollovers,
      maxLogicalTokens,
      maxTransferTokens,
      maxRetainedLogicalTokens,
      minRetainedTransferTokens: minRetainedTransferTokens ?? null,
      ...(latestRolloverPressure ? { latestRolloverPressure } : {}),
    }),
    latestWorkTurnAt: latestMs > 0 ? new Date(latestMs).toISOString() : null,
    latestRetainedProofAt: latestProofMs > 0 ? new Date(latestProofMs).toISOString() : null,
    interpretation: status === "pass"
      ? "A real Work turn reused an existing browser epoch and sent retained-delta context."
      : workPlans === 0
        ? "No recent Work turn plan was observed. Use Tela Work, then run this canary again."
        : "Recent Work turns were observed, but none proved retained-delta plus retained-surface reuse. Run a second turn in the same Work task and retry.",
  });
}
