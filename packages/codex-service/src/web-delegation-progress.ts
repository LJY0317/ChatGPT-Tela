/** Last public presentation only: never execution authority, a block classifier, or raw reasoning. */
export interface WebDelegationProgress {
  readonly summary: string;
  readonly observedAt: number;
  readonly source: "native-public-summary" | "native-indexed-summary";
}
const MAX_SUMMARY_CHARACTERS = 2048;
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function indexedWebDelegationProgress(items: readonly unknown[], observedAt: number): WebDelegationProgress | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = object(items[i]);
    if (item?.type !== "reasoning" || !Array.isArray(item.summary)) continue;
    for (let j = item.summary.length - 1; j >= 0; j--) {
      const part = item.summary[j];
      const text = typeof part === "string" ? part : object(part)?.text;
      if (typeof text === "string" && text.trim()) return {
        summary: text.slice(0, MAX_SUMMARY_CHARACTERS), observedAt, source: "native-indexed-summary",
      };
    }
  }
}

/** Caller proves the exact thread and turn before passing public Native notifications. */
export class WebDelegationProgressProjection {
  #itemId?: string;
  #index = -1;
  #text = "";
  observe(method: string, event: Record<string, unknown>, observedAt: number): WebDelegationProgress | undefined {
    if (method === "item/started" || method === "item/completed") {
      const progress = indexedWebDelegationProgress([event.item], observedAt);
      return progress ? { ...progress, source: "native-public-summary" } : undefined;
    }
    if (method !== "item/reasoning/summaryPartAdded" && method !== "item/reasoning/summaryTextDelta") return;
    const { itemId, summaryIndex } = event;
    if (typeof itemId !== "string" || !Number.isSafeInteger(summaryIndex) || (summaryIndex as number) < 0) return;
    if (itemId === this.#itemId && (summaryIndex as number) < this.#index) return;
    if (itemId !== this.#itemId || summaryIndex !== this.#index) {
      this.#itemId = itemId; this.#index = summaryIndex as number; this.#text = "";
    }
    if (method !== "item/reasoning/summaryTextDelta" || typeof event.delta !== "string") return;
    const text = (this.#text + event.delta.slice(0, MAX_SUMMARY_CHARACTERS)).slice(0, MAX_SUMMARY_CHARACTERS);
    if (text === this.#text) return;
    this.#text = text;
    if (text.trim()) return { summary: text, observedAt, source: "native-public-summary" };
  }
}
