/** Policy over the current engine catalog; selection/readback remains owned by the browser adapter. */
export interface DelegationWebModel {
  readonly model: string;
  readonly displayName: string;
  readonly effort: "xhigh" | "high";
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid Web model catalog");
  return value as Record<string, unknown>;
}

/** Numeric release labels are an isolated policy, not model identity. Unrankable/new naming fails closed. */
export function selectDelegationWebModel(catalog: unknown): DelegationWebModel {
  const list = object(catalog);
  if (!Array.isArray(list.data) || list.nextCursor != null || list.data.length > 256) {
    throw Error("Web model catalog must be complete");
  }
  const rows = list.data.map(object).filter(row => row.hidden !== true
    && typeof row.model === "string" && /^chatgpt-tela-web\/family\/[a-f0-9]{20}$/.test(row.model));
  if (!rows.length || new Set(rows.map(row => row.model)).size !== rows.length) {
    throw Error("No unambiguous available Web models");
  }
  const ranked = rows.map(row => {
    if (typeof row.displayName !== "string") throw Error("Web model label is missing");
    const versions = row.displayName.match(/\d+(?:\.\d+)*/g);
    if (versions?.length !== 1) throw Error("Latest Web model cannot be determined from this catalog");
    return { row, version: versions[0]!.split(".").map(Number) };
  });
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const difference = (a[i] ?? 0) - (b[i] ?? 0);
      if (difference) return difference;
    }
    return 0;
  };
  ranked.sort((a, b) => compare(b.version, a.version));
  if (ranked.length > 1 && compare(ranked[0]!.version, ranked[1]!.version) === 0) {
    throw Error("Latest Web model is ambiguous; explicit model selection is required");
  }
  const row = ranked[0]!.row;
  if (!Array.isArray(row.supportedReasoningEfforts)) throw Error("Web effort availability is missing");
  const efforts = row.supportedReasoningEfforts.map(value => object(value).reasoningEffort);
  const effort = efforts.includes("xhigh") ? "xhigh" : efforts.includes("high") ? "high" : undefined;
  if (!effort) throw Error("Latest Web model does not offer Extra high or High");
  return Object.freeze({ model: row.model as string, displayName: row.displayName as string, effort });
}

/** Native collaboration settings override the top-level model/effort on resumed threads. */
export function webDelegationTurnSettings(selection: DelegationWebModel) {
  return { collaborationMode: { mode: "default", settings: {
    model: selection.model, reasoning_effort: selection.effort, developer_instructions: null,
  } } } as const;
}
