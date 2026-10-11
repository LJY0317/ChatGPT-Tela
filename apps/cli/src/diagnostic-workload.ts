import { readDiagnosticSources } from "@chatgpt-tela/core";

interface DiagnosticEvent {
  readonly ts?: unknown;
  readonly event?: unknown;
  readonly stage?: unknown;
  readonly capability?: unknown;
  readonly result_bytes?: unknown;
  readonly request_bytes?: unknown;
  readonly truncated?: unknown;
  readonly has_more?: unknown;
  readonly is_error?: unknown;
}

interface Counter {
  calls: number;
  resultBytes: number;
  maxResultBytes: number;
  large64KiB: number;
  large256KiB: number;
}

function counter(): Counter {
  return { calls: 0, resultBytes: 0, maxResultBytes: 0, large64KiB: 0, large256KiB: 0 };
}

function addResult(target: Counter, bytes: number): void {
  target.calls += 1;
  target.resultBytes += bytes;
  target.maxResultBytes = Math.max(target.maxResultBytes, bytes);
  if (bytes >= 64 * 1024) target.large64KiB += 1;
  if (bytes >= 256 * 1024) target.large256KiB += 1;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function eventTime(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}


export function summarizeDiagnosticWorkload(input: {
  readonly paths: readonly string[];
  readonly minutes?: number;
  readonly nowMs?: number;
}): Readonly<Record<string, unknown>> {
  const minutes = input.minutes ?? 15;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) {
    throw new Error("diagnostics workload --minutes must be an integer from 1 to 120");
  }
  const nowMs = input.nowMs ?? Date.now();
  const fromMs = nowMs - minutes * 60_000;
  const combined = counter();
  const chat = counter();
  const codex = counter();
  const byCapability = new Map<string, Counter>();
  let scanned = 0;
  let inWindow = 0;
  let withoutTimestamp = 0;
  let missingResultSize = 0;
  let chatTruncated = 0;
  let chatHasMore = 0;
  let codexRequestBytes = 0;
  let codexErrors = 0;
  let latestMs = 0;

  const source = readDiagnosticSources(input.paths);
  withoutTimestamp = source.coverage.reduce((sum,item)=>sum+item.invalidTimestampRows,0);
  scanned = withoutTimestamp;
  for (const item of source.events) {
      scanned += 1;
      const ts = eventTime(item.ts);
      if (ts === undefined) {
        withoutTimestamp += 1;
        continue;
      }
      if (ts < fromMs || ts > nowMs + 60_000) continue;
      const isChat = item.event === "chatgpt_tela_chat" && item.stage === "capability_call_complete";
      const isCodex = item.event === "chatgpt_tela_codex" && item.stage === "tool_invoke_complete";
      if (!isChat && !isCodex) continue;
      inWindow += 1;
      latestMs = Math.max(latestMs, ts);
      const bytes = safeInteger(item.result_bytes);
      if (bytes === undefined) {
        missingResultSize += 1;
        continue;
      }
      addResult(combined, bytes);
      if (isChat) {
        addResult(chat, bytes);
        if (item.truncated === true) chatTruncated += 1;
        if (item.has_more === true) chatHasMore += 1;
        if (typeof item.capability === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(item.capability)) {
          const current = byCapability.get(item.capability) ?? counter();
          addResult(current, bytes);
          byCapability.set(item.capability, current);
        }
      } else {
        addResult(codex, bytes);
        codexRequestBytes += safeInteger(item.request_bytes) ?? 0;
        if (item.is_error === true) codexErrors += 1;
      }
  }

  const renderCounter = (value: Counter) => Object.freeze({
    calls: value.calls,
    resultBytes: value.resultBytes,
    maxResultBytes: value.maxResultBytes,
    largeResults64KiB: value.large64KiB,
    largeResults256KiB: value.large256KiB,
  });
  return Object.freeze({
    privacy: "structural-counts-and-byte-sizes-only",
    contentRead: false,
    pathsEmitted: false,
    window: Object.freeze({
      minutes,
      from: new Date(fromMs).toISOString(),
      to: new Date(nowMs).toISOString(),
    }),
    events: Object.freeze({ scanned, inWindow, withoutTimestamp, missingResultSize }),
    sourceCoverage: source.coverage,
    combined: renderCounter(combined),
    chat: Object.freeze({
      ...renderCounter(chat),
      truncatedCalls: chatTruncated,
      boundedReadsWithMore: chatHasMore,
      byCapability: Object.freeze(Object.fromEntries(
        [...byCapability.entries()].sort(([left], [right]) => left.localeCompare(right))
          .map(([name, value]) => [name, renderCounter(value)]),
      )),
    }),
    codex: Object.freeze({
      ...renderCounter(codex),
      requestBytes: codexRequestBytes,
      errorCalls: codexErrors,
    }),
    latestObservedAt: latestMs > 0 ? new Date(latestMs).toISOString() : null,
  });
}
