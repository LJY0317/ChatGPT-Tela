import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 128 * 1024;
const MAX_ROWS = 64;
const WINDOW_MS = 24 * 60 * 60 * 1_000;
const DECISION_EVENT = /^decision_(web_reopen|web_disconnect)_(pending|accepted|deferred)$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

type DecisionState = "unanswered_at_last_observation" | "accepted" | "deferred";

export interface TelaDecisionObservation {
  readonly slot: number;
  readonly kind: "web_reopen" | "web_disconnect";
  readonly state: DecisionState;
  readonly observedAt: string;
  /** An event record never proves that a UI window is still on screen. */
  readonly currentWindowPresence: "unverified";
  readonly owner: "tela_menu_bar";
}

/**
 * Read-only record of Tela-owned modal dialogs. No Accessibility scraping,
 * foreign-app windows, dialog text, button clicks or credentials.
 * An unmatched pending event is a clue, NEVER proof of a live prompt.
 */
export function observeTelaDecisions(logsRoot: string, nowMs = Date.now()): {
  readonly source: "tela_menu_bar";
  readonly observed: readonly TelaDecisionObservation[];
  readonly currentForeignAppPrompts: "not_observable";
} {
  const empty = Object.freeze({ source: "tela_menu_bar" as const, observed: Object.freeze([]),
    currentForeignAppPrompts: "not_observable" as const });
  const path = join(logsRoot, "menu-ui-events.json");
  let rows: unknown;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) return empty;
    rows = JSON.parse(readFileSync(path, "utf8"));
  } catch { return empty; }
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return empty;

  const byId = new Map<string, TelaDecisionObservation>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const { at, slot, event, uiSession, decision } = row as Record<string, unknown>;
    if (typeof at !== "number" || !Number.isFinite(at) ||
      at * 1000 < nowMs - WINDOW_MS || at * 1000 > nowMs + 60_000 ||
      !Number.isSafeInteger(slot) || (slot as number) < 1 || (slot as number) > 99 ||
      typeof event !== "string" || typeof decision !== "string" || !UUID.test(decision) ||
      typeof uiSession !== "string" || !UUID.test(uiSession)) continue;
    const match = DECISION_EVENT.exec(event);
    if (!match) continue;
    const id = `${uiSession}:${decision}`;
    const kind = match[1] as TelaDecisionObservation["kind"];
    const phase = match[2]!;
    const prior = byId.get(id);
    if (prior && (prior.kind !== kind || prior.slot !== slot ||
      (prior.state !== "unanswered_at_last_observation"))) continue;
    if (!prior && phase !== "pending") continue;
    byId.set(id, Object.freeze({
      slot: slot as number, kind,
      state: phase === "pending" ? "unanswered_at_last_observation"
        : phase as DecisionState,
      observedAt: new Date(at * 1000).toISOString(),
      currentWindowPresence: "unverified" as const,
      owner: "tela_menu_bar" as const,
    }));
  }
  return Object.freeze({ source: "tela_menu_bar" as const,
    observed: Object.freeze([...byId.values()].slice(-16)),
    currentForeignAppPrompts: "not_observable" as const });
}
