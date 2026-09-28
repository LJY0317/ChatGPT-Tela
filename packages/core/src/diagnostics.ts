export interface IncidentEvidence {
  readonly kind: string;
  readonly summary: string;
  readonly observedAt: string;
}

export class BoundedIncidentBuffer {
  readonly #maxEntries: number;
  readonly #entries: IncidentEvidence[] = [];

  constructor(maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive safe integer");
    }
    this.#maxEntries = maxEntries;
  }

  push(evidence: IncidentEvidence): void {
    this.#entries.push(Object.freeze({ ...evidence }));
    if (this.#entries.length > this.#maxEntries) {
      this.#entries.splice(0, this.#entries.length - this.#maxEntries);
    }
  }

  snapshot(): readonly IncidentEvidence[] {
    return Object.freeze(this.#entries.map(entry => Object.freeze({ ...entry })));
  }
}
