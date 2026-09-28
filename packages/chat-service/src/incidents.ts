import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const MAX_INCIDENTS_PER_WORKSPACE = 32;
const MAX_INCIDENTS_TOTAL = 128;
const INCIDENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_INCIDENT_SERIALIZED_BYTES = 4 * 1024;

export interface ChatIncidentRecord {
  readonly version: 1;
  readonly incidentRef: string;
  readonly observedAt: string;
  readonly capability: string;
  readonly category: "failed" | "aborted";
  readonly workspaceFingerprint: string;
}

export interface ChatIncidentSummary {
  readonly incidentRef: string;
  readonly observedAt: string;
  readonly capability: string;
  readonly category: "failed" | "aborted";
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function incidentRef(value: unknown): string {
  const parsed = text(value, "incident reference");
  if (!/^chatincident_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new Error("incident reference is invalid");
  }
  return parsed;
}

export function chatWorkspaceFingerprint(workspaceId: string): string {
  return createHash("sha256").update(text(workspaceId, "workspace id")).digest("hex").slice(0, 24);
}

export function parseChatIncidentRecord(value: unknown): ChatIncidentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("incident record must be an object");
  const item = value as Record<string, unknown>;
  if (item.version !== 1) throw new Error("incident record version is invalid");
  const observedAt = text(item.observedAt, "incident observedAt");
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("incident observedAt is invalid");
  const category = item.category;
  if (category !== "failed" && category !== "aborted") throw new Error("incident category is invalid");
  const workspaceFingerprint = text(item.workspaceFingerprint, "incident workspace fingerprint");
  if (!/^[a-f0-9]{24}$/.test(workspaceFingerprint)) throw new Error("incident workspace fingerprint is invalid");
  return Object.freeze({
    version: 1,
    incidentRef: incidentRef(item.incidentRef),
    observedAt,
    capability: text(item.capability, "incident capability"),
    category,
    workspaceFingerprint,
  });
}

function summary(record: ChatIncidentRecord): ChatIncidentSummary {
  return Object.freeze({
    incidentRef: record.incidentRef,
    observedAt: record.observedAt,
    capability: record.capability,
    category: record.category,
  });
}

export class ChatIncidentStore {
  readonly #root: string;

  constructor(input: { readonly root: string }) {
    this.#root = resolve(input.root);
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.#prune();
  }

  #path(ref: string): string {
    return join(this.#root, `${incidentRef(ref)}.json`);
  }

  captureFailure(input: {
    readonly capability: string;
    readonly workspaceId: string;
    readonly error: unknown;
  }): ChatIncidentRecord {
    const record: ChatIncidentRecord = Object.freeze({
      version: 1,
      incidentRef: `chatincident_${randomUUID()}`,
      observedAt: new Date().toISOString(),
      capability: text(input.capability, "incident capability"),
      category: input.error instanceof Error && input.error.name === "AbortError" ? "aborted" : "failed",
      workspaceFingerprint: chatWorkspaceFingerprint(input.workspaceId),
    });
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_INCIDENT_SERIALIZED_BYTES) {
      throw new Error("incident record exceeds its serialized byte limit");
    }
    const path = this.#path(record.incidentRef);
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
    renameSync(temporary, path);
    this.#prune();
    return record;
  }

  list(workspaceId: string, limit = 20): readonly ChatIncidentSummary[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("incident list limit must be an integer from 1 to 100");
    const fingerprint = chatWorkspaceFingerprint(workspaceId);
    return Object.freeze(this.#records()
      .filter(record => record.workspaceFingerprint === fingerprint)
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
      .slice(0, limit)
      .map(summary));
  }

  read(workspaceId: string, ref: string): ChatIncidentSummary {
    const path = this.#path(ref);
    if (!existsSync(path)) throw new Error(`unknown Tela Chat incident reference: ${ref}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("incident record file is unsafe or replaced");
    const record = parseChatIncidentRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (record.workspaceFingerprint !== chatWorkspaceFingerprint(workspaceId)) {
      throw new Error(`unknown Tela Chat incident reference for workspace ${workspaceId}: ${ref}`);
    }
    return summary(record);
  }

  #records(): ChatIncidentRecord[] {
    const records: ChatIncidentRecord[] = [];
    for (const entry of readdirSync(this.#root)) {
      if (!/^chatincident_[0-9a-f-]+\.json$/i.test(entry)) continue;
      const path = join(this.#root, entry);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        records.push(parseChatIncidentRecord(JSON.parse(readFileSync(path, "utf8")) as unknown));
      } catch {
        // Corrupt product-owned diagnostics never become authority for a user workspace.
      }
    }
    return records;
  }

  #prune(): void {
    const now = Date.now();
    const records = this.#records().sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    const remove = new Set<string>();
    for (const record of records) {
      if (now - Date.parse(record.observedAt) > INCIDENT_RETENTION_MS) remove.add(record.incidentRef);
    }
    const byWorkspace = new Map<string, ChatIncidentRecord[]>();
    for (const record of records.filter(record => !remove.has(record.incidentRef))) {
      const list = byWorkspace.get(record.workspaceFingerprint) ?? [];
      list.push(record);
      byWorkspace.set(record.workspaceFingerprint, list);
    }
    for (const list of byWorkspace.values()) {
      while (list.length > MAX_INCIDENTS_PER_WORKSPACE) remove.add(list.shift()!.incidentRef);
    }
    const remaining = records.filter(record => !remove.has(record.incidentRef));
    while (remaining.length > MAX_INCIDENTS_TOTAL) remove.add(remaining.shift()!.incidentRef);
    for (const ref of remove) rmSync(this.#path(ref), { force: true });

    for (const entry of readdirSync(this.#root)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(this.#root, entry);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (now - stat.mtimeMs > INCIDENT_RETENTION_MS && !records.some(record => `${record.incidentRef}.json` === entry)) {
          rmSync(path, { force: true });
        }
      } catch { /* best-effort retention cleanup */ }
    }
  }
}
